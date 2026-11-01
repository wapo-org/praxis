import Foundation
import Compression
@testable import AgentSkills

/// A temp directory removed when the test releases it.
final class Scratch {
    let url: URL

    init() {
        url = FileManager.default.temporaryDirectory.appending(path: "skills-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
        try! FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }

    deinit { try? FileManager.default.removeItem(at: url) }

    func dir(_ name: String) -> URL {
        let d = url.appending(path: name, directoryHint: .isDirectory)
        try! FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    func file(_ name: String, _ data: Data) -> URL {
        let f = url.appending(path: name)
        try! FileManager.default.createDirectory(at: f.deletingLastPathComponent(), withIntermediateDirectories: true)
        try! data.write(to: f)
        return f
    }
}

func skillMarkdown(name: String, description: String = "Formats widgets. Use when the user asks about widgets.",
                   body: String = "# Widgets\n\nStep 1: do the thing.") -> String {
    "---\nname: \(name)\ndescription: \(description)\n---\n\n\(body)\n"
}

/// Writes `files` (relative path → text) under `dir`.
func write(_ files: [String: String], to dir: URL) {
    for (path, text) in files {
        let url = dir.appending(path: path)
        try! FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try! Data(text.utf8).write(to: url)
    }
}

func listFiles(_ dir: URL) -> [String] {
    SkillDirectory.list(dir).files.map(\.path).sorted()
}

// MARK: - Crafted archives

/// One entry for `TestZip`. Defaults produce a well-formed Unix entry;
/// the overrides craft malformed or hostile ones.
struct ZipEntrySpec {
    var name: String
    var data: Data
    var deflate = false
    var unixMode: UInt32? = 0o100644
    var flags: UInt16 = 0
    var method: UInt16? = nil
    var declaredSize: Int? = nil
    var crc: UInt32? = nil

    init(_ name: String, _ text: String, deflate: Bool = false, unixMode: UInt32? = 0o100644) {
        self.name = name
        self.data = Data(text.utf8)
        self.deflate = deflate
        self.unixMode = unixMode
    }

    init(_ name: String, data: Data, deflate: Bool = false, unixMode: UInt32? = 0o100644) {
        self.name = name
        self.data = data
        self.deflate = deflate
        self.unixMode = unixMode
    }
}

/// A tiny ZIP writer (stored + raw-deflate) for archives `/usr/bin/zip`
/// can't or won't produce.
enum TestZip {
    static func make(_ entries: [ZipEntrySpec], diskNumber: UInt16 = 0, zip64Locator: Bool = false,
                     totalEntries: UInt16? = nil) -> Data {
        var out = Data()
        var central = Data()
        for e in entries {
            let payload = e.deflate ? deflate(e.data) : e.data
            let method = e.method ?? (e.deflate ? 8 : 0)
            let crc = e.crc ?? CRC32.checksum(e.data)
            let size = UInt32(e.declaredSize ?? e.data.count)
            let name = Data(e.name.utf8)
            let offset = UInt32(out.count)

            out.le32(0x0403_4b50); out.le16(20); out.le16(e.flags); out.le16(method); out.le16(0); out.le16(0x21)
            out.le32(crc); out.le32(UInt32(payload.count)); out.le32(size)
            out.le16(UInt16(name.count)); out.le16(0)
            out.append(name); out.append(payload)

            central.le32(0x0201_4b50)
            central.le16(e.unixMode == nil ? 20 : (3 << 8) | 20); central.le16(20)
            central.le16(e.flags); central.le16(method); central.le16(0); central.le16(0x21)
            central.le32(crc); central.le32(UInt32(payload.count)); central.le32(size)
            central.le16(UInt16(name.count)); central.le16(0); central.le16(0); central.le16(0); central.le16(0)
            central.le32((e.unixMode ?? 0) << 16); central.le32(offset)
            central.append(name)
        }
        let centralOffset = UInt32(out.count)
        out.append(central)
        if zip64Locator {
            out.le32(0x0706_4b50); out.le32(0); out.le32(0); out.le32(0); out.le32(1)
        }
        let count = totalEntries ?? UInt16(entries.count)
        out.le32(0x0605_4b50); out.le16(diskNumber); out.le16(diskNumber); out.le16(count); out.le16(count)
        out.le32(UInt32(central.count)); out.le32(centralOffset); out.le16(0)
        return out
    }

    static func deflate(_ data: Data) -> Data {
        guard !data.isEmpty else { return Data() }
        let capacity = data.count + 1024
        var out = Data(count: capacity)
        let n = out.withUnsafeMutableBytes { dst in
            data.withUnsafeBytes { src in
                compression_encode_buffer(dst.bindMemory(to: UInt8.self).baseAddress!, capacity,
                                          src.bindMemory(to: UInt8.self).baseAddress!, data.count, nil, COMPRESSION_ZLIB)
            }
        }
        precondition(n > 0)
        out.count = n
        return out
    }
}

private extension Data {
    mutating func le16(_ v: UInt16) { append(contentsOf: [UInt8(v & 0xFF), UInt8(v >> 8)]) }
    mutating func le32(_ v: UInt32) { append(contentsOf: (0..<4).map { UInt8((v >> (8 * $0)) & 0xFF) }) }
}

#if os(macOS)
/// Runs a macOS archiver (`/usr/bin/zip`, `/usr/bin/ditto`) to make
/// real-world archives.
@discardableResult
func runTool(_ path: String, _ args: [String], in cwd: URL) throws -> Int32 {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: path)
    process.arguments = args
    process.currentDirectoryURL = cwd
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    process.waitUntilExit()
    return process.terminationStatus
}
#endif
