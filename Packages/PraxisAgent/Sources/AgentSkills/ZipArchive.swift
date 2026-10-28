import Foundation
import Compression

/// Minimal read-only ZIP reader: Foundation has no unzip API on iOS.
///
/// Reads the end-of-central-directory record and the central directory
/// (the authoritative index — local headers are only used to find where
/// data starts), and extracts stored and deflated entries with a CRC-32
/// check. Anything outside that subset is rejected with a clear message
/// instead of being half-supported: ZIP64, encryption, multi-disk
/// archives, other compression methods, overlapping entries.
struct ZipArchive {
    struct Entry {
        var name: String
        var method: UInt16
        var flags: UInt16
        var crc32: UInt32
        var compressedSize: Int
        var uncompressedSize: Int
        var localHeaderOffset: Int
        /// Unix `st_mode` when the archiver recorded one.
        var unixMode: UInt32?

        var isDirectory: Bool {
            name.hasSuffix("/") || name.hasSuffix("\\") || unixMode.map { $0 & 0o170000 == 0o040000 } == true
        }
        var isSymlink: Bool { unixMode.map { $0 & 0o170000 == 0o120000 } == true }
        /// FIFOs, devices, sockets.
        var isSpecial: Bool {
            guard let type = unixMode.map({ $0 & 0o170000 }) else { return false }
            return type != 0 && type != 0o100000 && type != 0o040000 && type != 0o120000
        }
        var isExecutable: Bool { unixMode.map { $0 & 0o111 != 0 } == true }
    }

    let data: Data
    let entries: [Entry]

    private static let eocdSignature: UInt32 = 0x0605_4b50
    private static let zip64LocatorSignature: UInt32 = 0x0706_4b50
    private static let centralSignature: UInt32 = 0x0201_4b50
    private static let localSignature: UInt32 = 0x0403_4b50

    static func isZip(_ data: Data) -> Bool {
        data.count >= 4 && (data.starts(with: [0x50, 0x4b, 0x03, 0x04]) || data.starts(with: [0x50, 0x4b, 0x05, 0x06]))
    }

    init(data: Data, maxEntries: Int = 5_000) throws {
        self.data = data
        let reader = ByteReader(data: data)

        // EOCD: 22 bytes + up to 64 KB comment, at the very end.
        let minEOCD = 22
        guard data.count >= minEOCD else { throw SkillError.unreadableArchive("This file is too small to be a ZIP archive.") }
        var eocd: Int?
        var pos = data.count - minEOCD
        let lowest = max(0, data.count - minEOCD - 0xFFFF)
        while pos >= lowest {
            if try reader.u32(pos) == Self.eocdSignature, try Int(reader.u16(pos + 20)) == data.count - pos - minEOCD {
                eocd = pos
                break
            }
            pos -= 1
        }
        guard let eocd else { throw SkillError.unreadableArchive("This file isn't a ZIP archive, or it's damaged (no end-of-archive record).") }

        let disk = try reader.u16(eocd + 4)
        let centralDisk = try reader.u16(eocd + 6)
        let entriesOnDisk = try reader.u16(eocd + 8)
        let totalEntries = try reader.u16(eocd + 10)
        let centralSize = try reader.u32(eocd + 12)
        let centralOffset = try reader.u32(eocd + 16)

        if eocd >= 20, try reader.u32(eocd - 20) == Self.zip64LocatorSignature {
            throw SkillError.unreadableArchive("ZIP64 archives aren't supported. Re-create the archive with a standard zip tool.")
        }
        if totalEntries == 0xFFFF || centralSize == 0xFFFF_FFFF || centralOffset == 0xFFFF_FFFF {
            throw SkillError.unreadableArchive("ZIP64 archives aren't supported. Re-create the archive with a standard zip tool.")
        }
        if disk != 0 || centralDisk != 0 || entriesOnDisk != totalEntries {
            throw SkillError.unreadableArchive("Split (multi-part) ZIP archives aren't supported.")
        }
        guard Int(totalEntries) <= maxEntries else {
            throw SkillError.tooLarge("This archive has \(totalEntries) entries; the limit is \(maxEntries).")
        }
        guard Int(centralOffset) + Int(centralSize) <= eocd else {
            throw SkillError.unreadableArchive("This ZIP archive is damaged (central directory out of bounds).")
        }

        var entries: [Entry] = []
        var cursor = Int(centralOffset)
        for _ in 0..<totalEntries {
            guard try reader.u32(cursor) == Self.centralSignature else {
                throw SkillError.unreadableArchive("This ZIP archive is damaged (bad central directory entry).")
            }
            let madeBy = try reader.u16(cursor + 4)
            let flags = try reader.u16(cursor + 8)
            let method = try reader.u16(cursor + 10)
            let crc = try reader.u32(cursor + 16)
            let compressed = try reader.u32(cursor + 20)
            let uncompressed = try reader.u32(cursor + 24)
            let nameLength = Int(try reader.u16(cursor + 28))
            let extraLength = Int(try reader.u16(cursor + 30))
            let commentLength = Int(try reader.u16(cursor + 32))
            let startDisk = try reader.u16(cursor + 34)
            let external = try reader.u32(cursor + 38)
            let localOffset = try reader.u32(cursor + 42)
            let nameBytes = try reader.bytes(cursor + 46, nameLength)
            let extra = try reader.bytes(cursor + 46 + nameLength, extraLength)

            let name = Self.decodeName(nameBytes, utf8Flag: flags & 0x0800 != 0)
            if flags & 0x0001 != 0 || flags & 0x0040 != 0 || method == 99 {
                throw SkillError.unreadableArchive("“\(SkillPath.printable(name))” is encrypted. Password-protected archives aren't supported.")
            }
            if compressed == 0xFFFF_FFFF || uncompressed == 0xFFFF_FFFF || localOffset == 0xFFFF_FFFF || Self.hasZip64Extra(extra) {
                throw SkillError.unreadableArchive("ZIP64 archives aren't supported. Re-create the archive with a standard zip tool.")
            }
            if startDisk != 0 {
                throw SkillError.unreadableArchive("Split (multi-part) ZIP archives aren't supported.")
            }
            // Host 3 = Unix, 19 = OS X: the high 16 bits of the external
            // attributes hold st_mode. Other hosts (MS-DOS, NTFS) don't.
            let host = madeBy >> 8
            let mode = external >> 16
            let unixMode: UInt32? = (host == 3 || host == 19 || (host != 0 && host != 10 && host != 11 && host != 14 && mode != 0)) ? mode : nil

            entries.append(Entry(name: name, method: method, flags: flags, crc32: crc, compressedSize: Int(compressed),
                                 uncompressedSize: Int(uncompressed), localHeaderOffset: Int(localOffset), unixMode: unixMode))
            cursor += 46 + nameLength + extraLength + commentLength
        }
        self.entries = entries
    }

    /// Where an entry's compressed bytes are, validated against the archive
    /// bounds and against every other entry: overlapping entries are how
    /// "overlapped" zip bombs expand one blob into thousands of files.
    func checkLayout() throws {
        var ranges: [(start: Int, end: Int, name: String)] = []
        for entry in entries {
            let range = try dataRange(of: entry)
            ranges.append((entry.localHeaderOffset, range.upperBound, entry.name))
        }
        ranges.sort { $0.start < $1.start }
        for (a, b) in zip(ranges, ranges.dropFirst()) where b.start < a.end {
            throw SkillError.unsafeContent("“\(SkillPath.printable(b.name))” overlaps another entry — this archive looks crafted to expand (zip bomb).")
        }
    }

    private func dataRange(of entry: Entry) throws -> Range<Int> {
        let reader = ByteReader(data: data)
        let offset = entry.localHeaderOffset
        guard try reader.u32(offset) == Self.localSignature else {
            throw SkillError.unreadableArchive("This ZIP archive is damaged (bad local header for “\(SkillPath.printable(entry.name))”).")
        }
        let nameLength = Int(try reader.u16(offset + 26))
        let extraLength = Int(try reader.u16(offset + 28))
        let start = offset + 30 + nameLength + extraLength
        let end = start + entry.compressedSize
        guard end <= data.count else {
            throw SkillError.unreadableArchive("This ZIP archive is damaged or truncated (“\(SkillPath.printable(entry.name))” runs past the end).")
        }
        return start..<end
    }

    /// Decompressed bytes, never more than the declared size: a header that
    /// under-reports its size fails here instead of inflating unbounded.
    func contents(of entry: Entry) throws -> Data {
        let range = try dataRange(of: entry)
        let compressed = data.subdata(in: (data.startIndex + range.lowerBound)..<(data.startIndex + range.upperBound))
        let output: Data
        switch entry.method {
        case 0:
            guard compressed.count == entry.uncompressedSize else {
                throw SkillError.unreadableArchive("“\(SkillPath.printable(entry.name))” is damaged (size mismatch).")
            }
            output = compressed
        case 8:
            output = try Self.inflate(compressed, expectedSize: entry.uncompressedSize, name: entry.name)
        default:
            throw SkillError.unreadableArchive("“\(SkillPath.printable(entry.name))” uses compression method \(entry.method); only stored and deflate are supported.")
        }
        guard CRC32.checksum(output) == entry.crc32 else {
            throw SkillError.unreadableArchive("“\(SkillPath.printable(entry.name))” is damaged (CRC mismatch).")
        }
        return output
    }

    /// Raw DEFLATE (RFC 1951) — what `COMPRESSION_ZLIB` decodes; ZIP entries
    /// carry no zlib header.
    private static func inflate(_ input: Data, expectedSize: Int, name: String) throws -> Data {
        if expectedSize == 0 { return Data() }
        guard !input.isEmpty else { throw SkillError.unreadableArchive("“\(SkillPath.printable(name))” is damaged (no data).") }
        let capacity = expectedSize + 1
        var output = Data(count: capacity)
        let written = output.withUnsafeMutableBytes { dst in
            input.withUnsafeBytes { src in
                compression_decode_buffer(dst.bindMemory(to: UInt8.self).baseAddress!, capacity,
                                          src.bindMemory(to: UInt8.self).baseAddress!, input.count, nil, COMPRESSION_ZLIB)
            }
        }
        if written > expectedSize {
            throw SkillError.unsafeContent("“\(SkillPath.printable(name))” expands beyond its declared size — this archive looks crafted (zip bomb).")
        }
        guard written == expectedSize else {
            throw SkillError.unreadableArchive("“\(SkillPath.printable(name))” is damaged (could not decompress).")
        }
        output.count = written
        return output
    }

    private static func decodeName(_ bytes: Data, utf8Flag: Bool) -> String {
        // Many archivers write UTF-8 without setting the flag; fall back to
        // Latin-1 (close enough to CP437 for display) only if it isn't UTF-8.
        if let s = String(data: bytes, encoding: .utf8) { return s }
        return String(data: bytes, encoding: .isoLatin1) ?? ""
    }

    private static func hasZip64Extra(_ extra: Data) -> Bool {
        let reader = ByteReader(data: extra)
        var pos = 0
        while pos + 4 <= extra.count {
            guard let id = try? reader.u16(pos), let size = try? reader.u16(pos + 2) else { return false }
            if id == 0x0001 { return true }
            pos += 4 + Int(size)
        }
        return false
    }
}

/// Bounds-checked little-endian reads.
private struct ByteReader {
    let data: Data

    func u16(_ offset: Int) throws -> UInt16 {
        guard offset >= 0, offset + 2 <= data.count else { throw Self.truncated }
        let i = data.startIndex + offset
        return UInt16(data[i]) | UInt16(data[i + 1]) << 8
    }

    func u32(_ offset: Int) throws -> UInt32 {
        guard offset >= 0, offset + 4 <= data.count else { throw Self.truncated }
        let i = data.startIndex + offset
        return UInt32(data[i]) | UInt32(data[i + 1]) << 8 | UInt32(data[i + 2]) << 16 | UInt32(data[i + 3]) << 24
    }

    func bytes(_ offset: Int, _ count: Int) throws -> Data {
        guard offset >= 0, count >= 0, offset + count <= data.count else { throw Self.truncated }
        return data.subdata(in: (data.startIndex + offset)..<(data.startIndex + offset + count))
    }

    static let truncated = SkillError.unreadableArchive("This ZIP archive is damaged or truncated.")
}

/// CRC-32 (IEEE 802.3, reflected 0xEDB88320) as used by ZIP.
enum CRC32 {
    static let table: [UInt32] = (0..<256).map { n -> UInt32 in
        var c = UInt32(n)
        for _ in 0..<8 { c = c & 1 != 0 ? 0xEDB8_8320 ^ (c >> 1) : c >> 1 }
        return c
    }

    static func checksum(_ data: Data) -> UInt32 {
        var crc: UInt32 = 0xFFFF_FFFF
        data.withUnsafeBytes { buffer in
            for byte in buffer { crc = table[Int((crc ^ UInt32(byte)) & 0xFF)] ^ (crc >> 8) }
        }
        return crc ^ 0xFFFF_FFFF
    }
}
