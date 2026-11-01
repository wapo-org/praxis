import Foundation
import Compression

/// A gzip-compressed tar archive (`.tar.gz`), read fully into memory.
///
/// The Agent Skills discovery RFC makes `.tar.gz` the default archive
/// format, so registry installs need it. Only what skills use is
/// supported: ustar / POSIX pax / GNU long names, regular files and
/// folders. Links and device entries are reported (the importer refuses
/// archives containing them); decompression stops at `maxBytes`, so a
/// gzip bomb fails instead of filling memory.
struct TarArchive {
    struct Entry {
        var name: String
        var data: Data
        var isDirectory: Bool
        /// Symbolic or hard link.
        var isLink: Bool
        /// Device, FIFO or anything else that isn't a file or folder.
        var isSpecial: Bool
        var isExecutable: Bool
    }

    var entries: [Entry] = []

    static func isGzip(_ data: Data) -> Bool {
        data.count >= 18 && data[data.startIndex] == 0x1F && data[data.startIndex + 1] == 0x8B
    }

    init(gzipped data: Data, maxBytes: Int, maxEntries: Int) throws {
        try self.init(tar: Self.gunzip(data, maxBytes: maxBytes), maxEntries: maxEntries)
    }

    // MARK: gzip

    static func gunzip(_ data: Data, maxBytes: Int) throws -> Data {
        let bytes = [UInt8](data)
        guard bytes.count >= 18, bytes[0] == 0x1F, bytes[1] == 0x8B else {
            throw SkillError.unreadableArchive("This isn't a gzip file.")
        }
        guard bytes[2] == 8 else { throw SkillError.unreadableArchive("This gzip file uses an unknown compression method.") }
        let flags = bytes[3]
        var pos = 10
        func skipZeroTerminated() throws {
            while pos < bytes.count, bytes[pos] != 0 { pos += 1 }
            guard pos < bytes.count else { throw damaged }
            pos += 1
        }
        if flags & 0x04 != 0 {
            guard pos + 2 <= bytes.count else { throw damaged }
            pos += 2 + (Int(bytes[pos]) | Int(bytes[pos + 1]) << 8)
        }
        if flags & 0x08 != 0 { try skipZeroTerminated() }
        if flags & 0x10 != 0 { try skipZeroTerminated() }
        if flags & 0x02 != 0 { pos += 2 }
        guard pos < bytes.count - 8 else { throw damaged }

        var output = Data()
        var overflow = false
        do {
            let filter = try OutputFilter(.decompress, using: .zlib) { chunk in
                guard let chunk else { return }
                if output.count + chunk.count > maxBytes {
                    overflow = true
                    throw SkillError.tooLarge("This archive expands to more than \(SkillImporter.formatBytes(maxBytes)).")
                }
                output.append(chunk)
            }
            // The trailer (CRC + size) follows the deflate stream; the
            // decoder stops at the stream's end, so feeding it is harmless.
            let body = Data(bytes[pos...])
            var offset = 0
            while offset < body.count {
                let end = min(offset + 64 * 1024, body.count)
                try filter.write(body.subdata(in: offset..<end))
                offset = end
            }
            try filter.finalize()
        } catch let error as SkillError {
            throw error
        } catch {
            if overflow { throw SkillError.tooLarge("This archive expands to more than \(SkillImporter.formatBytes(maxBytes)).") }
            throw damaged
        }
        return output
    }

    private static let damaged = SkillError.unreadableArchive("This .tar.gz archive is damaged or truncated.")

    // MARK: tar

    init(tar data: Data, maxEntries: Int) throws {
        let bytes = [UInt8](data)
        var pos = 0
        var longName: String?
        var paxPath: String?
        while pos + 512 <= bytes.count {
            let header = Array(bytes[pos..<(pos + 512)])
            if header.allSatisfy({ $0 == 0 }) { break }
            guard Self.checksumMatches(header) else { throw Self.damaged }
            let size = try Self.number(header[124..<136])
            guard size >= 0, size <= bytes.count else { throw Self.damaged }
            let dataStart = pos + 512
            guard dataStart + size <= bytes.count else { throw Self.damaged }
            let body = Data(bytes[dataStart..<(dataStart + size)])
            pos = dataStart + (size + 511) / 512 * 512

            let type = header[156]
            switch type {
            case UInt8(ascii: "L"): // GNU long name for the next entry
                longName = Self.string(Array(body))
                continue
            case UInt8(ascii: "x"): // pax extended header for the next entry
                paxPath = Self.paxValue("path", in: body)
                continue
            case UInt8(ascii: "g"), UInt8(ascii: "K"): // global pax / GNU long link name
                continue
            default:
                break
            }

            var name = Self.string(Array(header[0..<100]))
            let magic = Self.string(Array(header[257..<262]))
            if magic == "ustar" {
                let prefix = Self.string(Array(header[345..<500]))
                if !prefix.isEmpty { name = prefix + "/" + name }
            }
            if let override = paxPath ?? longName { name = override }
            paxPath = nil
            longName = nil

            let mode = (try? Self.number(header[100..<108])) ?? 0o644
            let isFile = type == 0 || type == UInt8(ascii: "0") || type == UInt8(ascii: "7")
            let isDirectory = type == UInt8(ascii: "5")
            let isLink = type == UInt8(ascii: "1") || type == UInt8(ascii: "2")
            entries.append(Entry(name: name, data: isFile ? body : Data(), isDirectory: isDirectory, isLink: isLink,
                                 isSpecial: !(isFile || isDirectory || isLink), isExecutable: isFile && mode & 0o111 != 0))
            if entries.count > maxEntries {
                throw SkillError.tooLarge("This archive has more than \(maxEntries) entries.")
            }
        }
    }

    private static func checksumMatches(_ header: [UInt8]) -> Bool {
        guard let stored = try? number(header[148..<156]) else { return false }
        var sum = 0
        for (i, b) in header.enumerated() { sum += (148..<156).contains(i) ? 0x20 : Int(b) }
        return sum == stored
    }

    /// Octal (NUL/space padded), or GNU base-256 when the high bit is set.
    private static func number(_ field: ArraySlice<UInt8>) throws -> Int {
        if let first = field.first, first & 0x80 != 0 {
            var value = 0
            for (i, b) in field.enumerated() {
                let byte = i == 0 ? Int(b & 0x7F) : Int(b)
                guard value < Int.max >> 8 else { throw damaged }
                value = value << 8 | byte
            }
            return value
        }
        let text = String(decoding: field.filter { $0 != 0 }, as: UTF8.self).trimmingCharacters(in: .whitespaces)
        if text.isEmpty { return 0 }
        guard let value = Int(text, radix: 8) else { throw damaged }
        return value
    }

    private static func string(_ bytes: [UInt8]) -> String {
        let end = bytes.firstIndex(of: 0) ?? bytes.count
        return String(decoding: bytes[..<end], as: UTF8.self)
    }

    /// `<len> <key>=<value>\n` records.
    private static func paxValue(_ key: String, in data: Data) -> String? {
        let text = String(decoding: data, as: UTF8.self)
        for line in text.split(separator: "\n") {
            guard let space = line.firstIndex(of: " ") else { continue }
            let record = line[line.index(after: space)...]
            if record.hasPrefix(key + "=") { return String(record.dropFirst(key.count + 1)) }
        }
        return nil
    }
}
