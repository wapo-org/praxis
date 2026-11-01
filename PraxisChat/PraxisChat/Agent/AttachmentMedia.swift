import Foundation
import ImageIO
import UniformTypeIdentifiers
import AgentCore

/// Attachments as JS `fs` sees them: read-only, by file name.
///
/// Scope rule: **this turn's attachments are listed; earlier ones are
/// readable only by exact name; ones the user hid from code are neither.**
/// `list()` names just the files the user attached to the current message
/// (re-attaching an older file puts it back in the list). A file from an
/// earlier turn is never enumerated, but the model can read it when it
/// names it exactly — the name it was shown when the file was attached.
/// A file the user marked "Hide from code" (`Attachment.isHiddenFromCode`,
/// any turn) is refused with `HiddenFromCode`, which tells the model why.
/// No globbing, prefixes or folders: a path is one plain file name
/// (`VirtualPath`), so `..`, absolute paths and separators are refused,
/// and a read returns at most 10 MB.
///
/// Why earlier files stay readable by default rather than only when
/// allowed: follow-ups ("now chart column B of data.csv") are the common
/// case, and a per-file opt-in would make the user re-allow every file
/// on every turn. Hiding is the explicit, sticky exception.
///
/// Names: this turn's files keep their plain names (duplicates get " (2)",
/// " (3)" …), then earlier files, newest first, take what's left — so a
/// re-attached "data.csv" means the new copy. Hidden files keep their
/// names, so hiding one never makes its name point at another file. Only
/// attachments whose bytes exist count; demo-era picks carry a name and
/// nothing else.
struct AttachmentFiles: VirtualFileSystem {
    private let current: [String: UUID]
    private let earlier: [String: UUID]
    private let store: AttachmentStore
    /// The hidden set right now (the store's live state during a run).
    private let hidden: @Sendable () async -> Set<UUID>

    /// The refusal for a hidden file; its text reaches the model.
    struct HiddenFromCode: LocalizedError, Equatable {
        let name: String
        var errorDescription: String? {
            "the user turned off code access for “\(name)” (Hide from code). Don't try other names for it; "
                + "if you need it, ask the user to long-press the attachment and choose “Available to code”."
        }
    }

    /// - Parameters:
    ///   - current: the new turn's attachments.
    ///   - conversation: every attachment in the conversation so far
    ///     (this turn's may be included; they count as current).
    ///   - hidden: the attachments hidden from code, asked at every call;
    ///     nil = the `isHiddenFromCode` flags of the attachments given.
    init(current: [Attachment], conversation: [Attachment] = [], store: AttachmentStore,
         hidden: (@Sendable () async -> Set<UUID>)? = nil) {
        var taken = Set<String>()
        func assign(_ attachments: [Attachment]) -> [String: UUID] {
            var out: [String: UUID] = [:]
            for attachment in attachments where store.contains(attachment.id) {
                let name = Self.unique(AttachmentMedia.fileName(for: attachment), taken: taken)
                taken.insert(name)
                out[name] = attachment.id
            }
            return out
        }
        let currentIDs = Set(current.map(\.id))
        self.current = assign(current)
        self.earlier = assign(conversation.filter { !currentIDs.contains($0.id) }.reversed())
        self.store = store
        let flagged = Set((current + conversation).filter(\.isHiddenFromCode).map(\.id))
        self.hidden = hidden ?? { flagged }
    }

    private static func unique(_ base: String, taken: Set<String>) -> String {
        var name = base
        var n = 2
        while taken.contains(name) {
            let ext = (base as NSString).pathExtension
            let stem = (base as NSString).deletingPathExtension
            name = ext.isEmpty ? "\(stem) (\(n))" : "\(stem) (\(n)).\(ext)"
            n += 1
        }
        return name
    }

    var isEmpty: Bool { current.isEmpty && earlier.isEmpty }

    func list() async -> [String] {
        let hidden = await hidden()
        return current.filter { !hidden.contains($0.value) }.keys.sorted()
    }

    func read(_ path: String, maxBytes: Int) async throws -> Data {
        let name = try VirtualPath.validate(path)
        guard let id = current[name] ?? earlier[name] else { throw CocoaError(.fileReadNoSuchFile) }
        if await hidden().contains(id) { throw HiddenFromCode(name: name) }
        guard let data = store.data(for: id) else { throw CocoaError(.fileReadNoSuchFile) }
        return data.prefix(max(0, min(maxBytes, VirtualPath.maxReadBytes)))
    }
}

/// Turns attachments into message parts the providers accept, and keeps
/// the persisted transcript free of attachment bytes.
///
/// Images are normalized once (JPEG/PNG/GIF/WebP within the providers'
/// size limits; HEIC and huge photos are re-encoded) and the exact bytes
/// sent are kept as a sidecar, so every later request replays identical
/// bytes. The transcript stores a reference instead of the bytes
/// (`dehydrate`) and requests swap them back in (`rehydrate`).
enum AttachmentMedia {
    static let referencePrefix = "praxis-attachment:"
    /// Inline text documents above this go to `fs` only.
    static let maxInlineTextBytes = 200_000
    static let maxDocumentBytes = 10 << 20
    static let maxImageBytes = 3_500_000
    static let maxImageSide = 2_000

    struct Built {
        var images: [MediaData] = []
        var documents: [MediaData] = []
        /// Media bytes → attachment id, to dehydrate the built message.
        var sources: [MediaData: UUID] = [:]
        /// Attachments the model only reaches through `fs`.
        var fileOnly: [Attachment] = []
    }

    static func build(_ attachments: [Attachment], store: AttachmentStore) -> Built {
        var built = Built()
        for attachment in attachments {
            guard let data = store.data(for: attachment.id) else { continue }
            let name = fileName(for: attachment)
            if attachment.hasImage || attachment.kind != .file || isImage(attachment.mediaType) {
                let bytes = store.sidecar(for: attachment.id) ?? normalizedImage(data, id: attachment.id, store: store)
                guard let bytes else { built.fileOnly.append(attachment); continue }
                let media = MediaData(mediaType: sniffImageType(bytes) ?? "image/jpeg", data: bytes, name: name)
                built.images.append(media)
                built.sources[media] = attachment.id
                continue
            }
            let type = attachment.mediaType ?? mediaType(forFileName: name)
            let isPDF = type == "application/pdf"
            let isText = UTType(mimeType: type)?.conforms(to: .text) ?? false
            if (isPDF && data.count <= maxDocumentBytes) || (isText && data.count <= maxInlineTextBytes) {
                let media = MediaData(mediaType: type, data: data, name: name)
                built.documents.append(media)
                built.sources[media] = attachment.id
            } else {
                built.fileOnly.append(attachment)
            }
        }
        return built
    }

    /// The user's text plus a line naming files only `fs` can read (and
    /// those the user hid from code, which nothing can read).
    static func text(_ text: String, fileOnly: [Attachment], hasJavaScript: Bool) -> String {
        guard !fileOnly.isEmpty else { return text }
        func names(_ list: [Attachment]) -> String { list.map { "“\(fileName(for: $0))”" }.joined(separator: ", ") }
        let readable = fileOnly.filter { !$0.isHiddenFromCode }, hidden = fileOnly.filter(\.isHiddenFromCode)
        var lines: [String] = []
        if !readable.isEmpty {
            let how = hasJavaScript ? " Read them with `fs` in run_javascript." : ""
            lines.append("[Attached file\(readable.count == 1 ? "" : "s"): \(names(readable)).\(how)]")
        }
        if !hidden.isEmpty {
            lines.append("[Attached file\(hidden.count == 1 ? "" : "s") hidden from code by the user: \(names(hidden)).]")
        }
        let note = lines.joined(separator: "\n")
        return text.isEmpty ? note : text + "\n\n" + note
    }

    // MARK: Transcript bytes

    /// Media parts built from attachments keep only a reference.
    static func dehydrate(_ message: Message, sources: [MediaData: UUID]) -> Message {
        var message = message
        message.parts = message.parts.map { part in
            switch part {
            case .image(let media): if let id = sources[media] { return .image(reference(media, id)) }
            case .document(let media): if let id = sources[media] { return .document(reference(media, id)) }
            default: break
            }
            return part
        }
        return message
    }

    /// The exact bytes back in place of references. A file that's gone
    /// becomes a short text part, so the request stays valid.
    static func rehydrate(_ messages: [Message], store: AttachmentStore) -> [Message] {
        messages.map { message in
            guard message.role == .user, message.parts.contains(where: isReference) else { return message }
            var message = message
            message.parts = message.parts.map { part in
                switch part {
                case .image(let media):
                    guard let id = referencedID(media) else { return part }
                    guard let data = store.sidecar(for: id) ?? store.data(for: id) else { return missing(media) }
                    return .image(MediaData(mediaType: media.mediaType, data: data, name: media.name))
                case .document(let media):
                    guard let id = referencedID(media) else { return part }
                    guard let data = store.data(for: id) else { return missing(media) }
                    return .document(MediaData(mediaType: media.mediaType, data: data, name: media.name))
                default:
                    return part
                }
            }
            return message
        }
    }

    private static func reference(_ media: MediaData, _ id: UUID) -> MediaData {
        MediaData(mediaType: media.mediaType, data: Data((referencePrefix + id.uuidString).utf8), name: media.name)
    }

    static func referencedID(_ media: MediaData) -> UUID? {
        guard media.data.count < 80 else { return nil }
        let text = String(decoding: media.data, as: UTF8.self)
        guard text.hasPrefix(referencePrefix) else { return nil }
        return UUID(uuidString: String(text.dropFirst(referencePrefix.count)))
    }

    private static func isReference(_ part: Part) -> Bool {
        switch part {
        case .image(let m), .document(let m): return referencedID(m) != nil
        default: return false
        }
    }

    private static func missing(_ media: MediaData) -> Part {
        .text("[Attachment \(media.name.map { "“\($0)” " } ?? "")is no longer available.]")
    }

    // MARK: Types

    static func fileName(for attachment: Attachment) -> String {
        if attachment.kind == .file || !(attachment.name as NSString).pathExtension.isEmpty { return attachment.name }
        let ext = attachment.mediaType.flatMap { UTType(mimeType: $0)?.preferredFilenameExtension } ?? "jpg"
        return "\(attachment.name).\(ext)"
    }

    static func mediaType(forFileName name: String) -> String {
        UTType(filenameExtension: (name as NSString).pathExtension)?.preferredMIMEType ?? "application/octet-stream"
    }

    private static func isImage(_ type: String?) -> Bool { type?.hasPrefix("image/") ?? false }

    static func sniffImageType(_ data: Data) -> String? {
        let bytes = [UInt8](data.prefix(12))
        if bytes.starts(with: [0xFF, 0xD8, 0xFF]) { return "image/jpeg" }
        if bytes.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return "image/png" }
        if bytes.starts(with: [0x47, 0x49, 0x46, 0x38]) { return "image/gif" }
        if bytes.count >= 12, bytes[0...3] == [0x52, 0x49, 0x46, 0x46], bytes[8...11] == [0x57, 0x45, 0x42, 0x50] { return "image/webp" }
        return nil
    }

    /// Bytes providers accept: the original when it already is, else a
    /// re-encoded JPEG (stored as the sidecar so it's encoded only once).
    private static func normalizedImage(_ data: Data, id: UUID, store: AttachmentStore) -> Data? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        let width = properties?[kCGImagePropertyPixelWidth] as? Int ?? 0
        let height = properties?[kCGImagePropertyPixelHeight] as? Int ?? 0
        if sniffImageType(data) != nil, data.count <= maxImageBytes, max(width, height) <= maxImageSide { return data }

        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: min(max(width, height, 1), maxImageSide),
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        let jpeg = out as Data
        store.setSidecar(jpeg, for: id)
        return jpeg
    }
}
