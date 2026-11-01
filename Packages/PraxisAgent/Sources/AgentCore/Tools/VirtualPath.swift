import Foundation

/// Paths accepted by a `VirtualFileSystem`: one plain file name, exactly
/// as `list()` (or the transcript) gives it. The namespace is flat, so
/// anything that looks like navigation is refused rather than resolved —
/// no folders, no `.` / `..`, no absolute or home paths, no control
/// characters.
public enum VirtualPath {
    public static let maxNameBytes = 255
    /// Upper bound on one read through `VirtualFileSystem.read`.
    public static let maxReadBytes = 10 << 20

    public struct Invalid: Error, CustomStringConvertible, Equatable {
        public let path: String
        public let reason: String
        public var description: String { "Invalid file name “\(path.prefix(80))”: \(reason)" }
    }

    /// The validated name.
    public static func validate(_ path: String) throws -> String {
        func fail(_ reason: String) -> Invalid { Invalid(path: path, reason: reason) }
        if path.isEmpty { throw fail("it is empty.") }
        if path.utf8.count > maxNameBytes { throw fail("it is longer than \(maxNameBytes) bytes.") }
        if path == "." || path == ".." { throw fail("use a file name from fs.list().") }
        if path.hasPrefix("/") || path.hasPrefix("~") { throw fail("absolute paths aren't allowed; use the plain file name.") }
        if path.contains("/") || path.contains("\\") { throw fail("folders aren't supported; use the plain file name.") }
        if path.unicodeScalars.contains(where: { $0.properties.generalCategory == .control }) {
            throw fail("it contains control characters.")
        }
        return path
    }
}
