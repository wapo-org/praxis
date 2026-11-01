import Foundation
import CryptoKit
#if canImport(ImageIO)
import ImageIO
#endif

/// Images for models that can't see them.
///
/// When the chat model has no image input, request builders replace every
/// image part with a placeholder naming a stable id and basic metadata,
/// and the conversation may offer `look_at_image`, which asks a separate
/// image-reading model about the image with that id.
///
/// The id is derived from the image bytes, so it is the same in every
/// request, after a relaunch (attachments replay identical bytes) and
/// after older turns are compacted away — placeholders never change the
/// request prefix, and an id the model saw earlier keeps working.
public enum ImageReference {
    /// The tool request builders point the model at when it is offered.
    public static let lookToolName = "look_at_image"

    /// `img_` + 12 hex digits of the SHA-256 of the bytes.
    public static func id(for media: MediaData) -> String {
        id(for: media.data)
    }

    public static func id(for data: Data) -> String {
        "img_" + SHA256.hash(data: data).prefix(6).map { String(format: "%02x", $0) }.joined()
    }

    public struct Metadata: Sendable, Hashable {
        public var width: Int?
        public var height: Int?
        public var byteCount: Int
    }

    /// Pixel size (orientation applied) without decoding the image.
    public static func metadata(for media: MediaData) -> Metadata {
        var width: Int?
        var height: Int?
        #if canImport(ImageIO)
        if let source = CGImageSourceCreateWithData(media.data as CFData, nil),
           let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] {
            width = properties[kCGImagePropertyPixelWidth] as? Int
            height = properties[kCGImagePropertyPixelHeight] as? Int
            if let orientation = properties[kCGImagePropertyOrientation] as? Int, (5...8).contains(orientation) {
                swap(&width, &height)
            }
        }
        #endif
        return Metadata(width: width, height: height, byteCount: media.data.count)
    }

    /// Locale-independent (placeholders are part of the request prefix).
    static func formatBytes(_ n: Int) -> String {
        if n < 1_000 { return "\(n) B" }
        if n < 1_000_000 { return "\(Int((Double(n) / 1_000).rounded())) KB" }
        let mb = Double(n) / 1_000_000
        let tenths = Int((mb * 10).rounded())
        return "\(tenths / 10).\(tenths % 10) MB"
    }

    /// The text that stands in for an image the model can't see.
    /// - Parameter lookToolOffered: the request offers `look_at_image`.
    public static func placeholder(for media: MediaData, lookToolOffered: Bool) -> String {
        let meta = metadata(for: media)
        var facts = [media.mediaType]
        if let w = meta.width, let h = meta.height { facts.append("\(w)×\(h)") }
        facts.append(formatBytes(meta.byteCount))
        let name = media.name.map { " “\($0)”" } ?? ""
        let head = "[Image \(id(for: media))\(name) (\(facts.joined(separator: ", ")))"
        if lookToolOffered {
            return head + " — you can't see images directly. Call \(lookToolName) with image_id \"\(id(for: media))\" and a question to have an image-reading model look at it; ask again (optionally with a region) to check details.]"
        }
        return head + " — the user attached this image, but the current model can't view images and this conversation has no image-reading tool. If its content matters, ask the user to describe it.]"
    }

    // MARK: Rejected image input

    /// Whether a provider error message says the model (or every endpoint
    /// serving it) doesn't take image input. A family of wordings from
    /// compatible servers, matched on the message rather than on who sent it:
    /// OpenRouter ("No endpoints found that support image input"), vLLM
    /// ("… is not a multimodal model", "At most 0 image(s) may be provided"),
    /// llama.cpp / LM Studio ("image input is not supported", "vision is not
    /// enabled"), Ollama ("missing data required for image input"), OpenAI
    /// ("image_url is only supported by certain models"), DeepSeek-style
    /// schema errors ("unknown variant `image_url`") and the generic
    /// "does not support image(s)/vision".
    public static func isImageInputRejection(_ message: String) -> Bool {
        let text = message.lowercased()
        return rejectionPatterns.contains { text.range(of: $0, options: .regularExpression) != nil }
    }

    static let rejectionPatterns: [String] = [
        #"no endpoints? found that supports? (image|vision|multimodal)"#,
        #"(does not|doesn't|do not|don't|cannot|can't|unable to) (support|accept|handle|process|take)( the)?( any)? (image|images|vision|multi-?modal|image_url|image input|image content)"#,
        #"(image|images|vision|image_url|multi-?modal)( input| inputs| content| parts?)? (is|are) not (supported|enabled|allowed|available)"#,
        #"(image|vision|multi-?modal)( input)? not supported"#,
        #"not an? (multi-?modal|vision|vlm|image)[- ]?(capable )?model"#,
        #"vision (add-on|adapter|projector) is not loaded"#,
        #"at most 0 image"#,
        #"missing data required for image input"#,
        #"unknown variant `?image_url"#,
        #"image_url is only supported by certain models"#,
        #"(model|endpoint) (has no|without) (vision|image) (support|input)"#,
    ]

    /// The transcript sends at least one image (user part or tool result).
    public static func containsImages(_ messages: [Message]) -> Bool {
        messages.contains { message in
            message.parts.contains { part in
                switch part {
                case .image: return true
                case .toolResult(let result): return result.content.contains { if case .image = $0 { return true }; return false }
                default: return false
                }
            }
        }
    }
}

extension ProviderError {
    /// The provider rejected image input (`ImageReference.isImageInputRejection`).
    /// Not worth retrying as is; resend with images as placeholders.
    public var isImageInputUnsupported: Bool {
        switch self {
        case .http(_, let message, _), .stream(_, let message): return ImageReference.isImageInputRejection(message)
        case .network, .decoding, .invalidConfiguration: return false
        }
    }
}

extension RunOutcome {
    /// The run failed because the provider rejected image input. The loop
    /// reports provider errors as `ProviderError.description`, which keeps
    /// the server's message.
    public var isImageInputRejection: Bool {
        if case .failed(let reason) = self { return ImageReference.isImageInputRejection(reason) }
        return false
    }
}
