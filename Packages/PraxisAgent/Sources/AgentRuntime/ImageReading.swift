import Foundation
import Synchronization
import AgentCore
import AgentProviders
#if canImport(ImageIO)
import ImageIO
import CoreGraphics
import UniformTypeIdentifiers
#endif

/// The model that looks at images for a chat model that can't: any
/// profile + model the user picked in Settings (another provider is fine).
/// Built at send time with the key from the Keychain; never persisted.
public struct ImageReader: Sendable {
    public var endpoint: ProviderEndpoint
    public var model: String
    /// For traces and the result header, e.g. "OpenRouter · gpt-5-mini".
    public var displayName: String
    public var maxOutputTokens: Int?
    /// Called when the reader's provider turns image input down (the
    /// picked model is text-only after all), so the app can remember it.
    public var onImagesRejected: (@Sendable () async -> Void)?

    public init(endpoint: ProviderEndpoint, model: String, displayName: String, maxOutputTokens: Int? = nil,
                onImagesRejected: (@Sendable () async -> Void)? = nil) {
        self.endpoint = endpoint
        self.model = model
        self.displayName = displayName
        self.maxOutputTokens = maxOutputTokens
        self.onImagesRejected = onImagesRejected
    }
}

/// Whether `look_at_image` can run for this turn, resolved by the app.
public enum ImageReaderAccess: Sendable {
    case ready(ImageReader)
    /// Told to the model as the tool's error, e.g. how to set one up.
    case unavailable(String)

    public static let notConfiguredMessage = """
    No image-reading model is set up, so the image can't be looked at. Tell the user: in Settings → Image reading model, \
    pick a provider and a model that accepts images; the chat can stay on the current model. Meanwhile, ask the user to \
    describe the image if it matters.
    """

    public static let notConfigured = ImageReaderAccess.unavailable(notConfiguredMessage)

    /// The picked image-reading model doesn't take images itself.
    public static func readerCantSeeImagesMessage(_ readerName: String) -> String {
        """
        The image-reading model (\(readerName)) can't take images itself, so the image can't be looked at. Tell the user: \
        in Settings → Image reading model, pick a model that accepts images. Meanwhile, ask the user to describe the \
        image if it matters.
        """
    }
}

/// Images one run can look at, by `ImageReference.id`: everything in the
/// transcript it started with, plus images committed during the run
/// (e.g. returned by tools).
final class ImageIndex: Sendable {
    private let images = Mutex<[String: MediaData]>([:])

    init(_ messages: [Message] = []) {
        add(messages)
    }

    func add(_ messages: [Message]) {
        var found: [String: MediaData] = [:]
        for message in messages {
            for part in message.parts {
                switch part {
                case .image(let media):
                    found[ImageReference.id(for: media)] = media
                case .toolResult(let result):
                    for case .image(let media) in result.content { found[ImageReference.id(for: media)] = media }
                default:
                    break
                }
            }
        }
        guard !found.isEmpty else { return }
        images.withLock { $0.merge(found) { a, _ in a } }
    }

    func image(_ id: String) -> MediaData? { images.withLock { $0[id] } }
    var ids: [String] { images.withLock { $0.keys.sorted() } }
}

/// `look_at_image {image_id, question, region?}`: asks the image-reading
/// model about one image and returns its answer as text.
///
/// Offered only to conversations whose chat model wasn't known to take image
/// input when they were frozen (`AgentRuntime.prepare(includeImageReader:)`),
/// or whose first request was turned down for images
/// (`AgentRuntime.addingImageReader`); the
/// spec doesn't depend on which reader is configured, so changing the
/// reader in Settings never changes a frozen tool list. Read-only and
/// built-in: allowed in every mode — the user attached the image to be
/// looked at, and the reader's host needs AI-data consent like any provider.
struct LookAtImageTool: AgentTool {
    static let name = ImageReference.lookToolName
    static let maxQuestionLength = 2_000

    let access: ImageReaderAccess
    let images: ImageIndex
    let transport: any HTTPTransport

    var spec: ToolSpec {
        ToolSpec(
            name: Self.name,
            description: """
            Ask an image-reading model about an image you can't see yourself: one the user attached that appears in messages \
            as an [Image img_… ] placeholder instead of the picture. Pass that id. Ask a specific question; the answer is \
            text. Call again to check details, optionally with a region to zoom into part of the image.
            """,
            inputSchema: [
                "type": "object",
                "properties": [
                    "image_id": ["type": "string", "description": "The id from the placeholder, e.g. \"img_3fa2b1c4d5e6\""],
                    "question": ["type": "string", "description": "What to find out, e.g. \"Transcribe the table\" or \"What error is shown?\""],
                    "region": [
                        "type": "object",
                        "description": "Optional part of the image to look at, as fractions of its width and height from the top-left corner (0–1)",
                        "properties": [
                            "x": ["type": "number"], "y": ["type": "number"],
                            "width": ["type": "number"], "height": ["type": "number"],
                        ],
                        "required": ["x", "y", "width", "height"],
                    ],
                ],
                "required": ["image_id", "question"],
            ])
    }

    var traits: ToolTraits { [.readOnly, .idempotent] }
    var source: ToolSource { .builtin }

    func presentation(for arguments: JSONValue) -> ToolPresentation {
        let zoom = arguments["region"]?.objectValue != nil
        return ToolPresentation(category: .other,
                                runningTitle: zoom ? "Looking closer at the image…" : "Looking at the image…",
                                finishedTitle: zoom ? "Looked closer at the image" : "Looked at the image")
    }

    func execute(_ invocation: ToolInvocation, context: ToolContext) async throws -> ToolOutput {
        let args = invocation.arguments
        guard let id = args["image_id"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !id.isEmpty else {
            return .error("Missing image_id.")
        }
        guard let question = args["question"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !question.isEmpty else {
            return .error("Missing question.")
        }
        guard let media = images.image(id) else {
            let known = images.ids
            let list = known.isEmpty ? "This conversation has no images." : "Images here: " + known.joined(separator: ", ") + "."
            return .error("There's no image with id \(id). " + list)
        }
        let region: CGRect?
        do {
            region = try Self.region(args["region"])
        } catch {
            return .error((error as? ImageCropError)?.message ?? "Invalid region.")
        }
        guard case .ready(let reader) = access else {
            if case .unavailable(let message) = access { return .error(message) }
            return .error(ImageReaderAccess.notConfiguredMessage)
        }

        var image = media
        if let region {
            do { image = try ImageCropper.crop(media, to: region) } catch {
                return .error((error as? ImageCropError)?.message ?? "Couldn't crop the image.")
            }
        }
        context.emit(.trace(.image, "Asked \(reader.displayName): \(question.prefix(120))"))
        let answer: String
        do {
            answer = try await Self.ask(reader, image: image, question: String(question.prefix(Self.maxQuestionLength)),
                                        transport: transport)
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as ProviderError where error.isImageInputUnsupported {
            await reader.onImagesRejected?()
            return .error(ImageReaderAccess.readerCantSeeImagesMessage(reader.displayName) + " (Provider said: \(error.description))")
        } catch {
            let detail = (error as? ProviderError)?.description ?? error.localizedDescription
            return .error("The image-reading model (\(reader.displayName)) failed: \(detail). If it keeps failing, the user can pick another image-reading model in Settings.")
        }
        guard !answer.isEmpty else { return .error("The image-reading model returned no answer.") }
        let scope = region.map { r in
            String(format: " · region x %.2f y %.2f w %.2f h %.2f", r.origin.x, r.origin.y, r.width, r.height)
        } ?? ""
        return ToolOutput(content: [.text("[\(id)\(scope) · answered by \(reader.displayName)]\n\(answer)")],
                          summary: region == nil ? "Looked at the image" : "Looked closer at the image")
    }

    static let readerSystemPrompt = """
    You read images for an AI assistant that can't see them. Answer its question about the image precisely and factually, \
    in plain text. Transcribe any text that matters exactly, including numbers and code. Describe layout or positions \
    when relevant. If something is unclear, cut off or not visible, say so instead of guessing.
    """

    /// One request to the reader: the image (vision forced on — the user
    /// picked this model for it) and the question, no tools.
    static func ask(_ reader: ImageReader, image: MediaData, question: String, transport: any HTTPTransport) async throws -> String {
        var endpoint = reader.endpoint
        endpoint.capabilities.vision = true
        let provider = ProviderFactory.make(endpoint, transport: transport)
        let request = ProviderRequest(model: reader.model, system: readerSystemPrompt,
                                      messages: [Message(role: .user, parts: [.image(image), .text(question)])],
                                      tools: [], maxTokens: min(4_096, reader.maxOutputTokens ?? 4_096), effort: .low)
        var text = ""
        for try await event in provider.stream(request) {
            switch event {
            case .textDelta(_, let delta): text += delta
            case .completed(let response):
                let full = response.message.text
                if !full.isEmpty { text = full }
            default: break
            }
        }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func region(_ value: JSONValue?) throws -> CGRect? {
        guard let value, !value.isNull else { return nil }
        guard let x = value["x"]?.doubleValue, let y = value["y"]?.doubleValue,
              let w = value["width"]?.doubleValue, let h = value["height"]?.doubleValue else {
            throw ImageCropError("region needs x, y, width and height as numbers between 0 and 1.")
        }
        guard w > 0, h > 0, x >= 0, y >= 0, x < 1, y < 1 else {
            throw ImageCropError("region must lie inside the image: x and y in 0–1, width and height above 0.")
        }
        return CGRect(x: x, y: y, width: min(w, 1 - x), height: min(h, 1 - y))
    }
}

struct ImageCropError: Error {
    var message: String
    init(_ message: String) { self.message = message }
}

enum ImageCropper {
    /// Small crops are scaled up so text stays legible to the reader.
    static let minimumLongSide = 768
    static let maximumLongSide = 2_000

    /// Crops `rect` (fractions, top-left origin, orientation applied) and
    /// re-encodes: PNG for PNG sources (screenshots keep sharp text), JPEG otherwise.
    static func crop(_ media: MediaData, to rect: CGRect) throws -> MediaData {
        #if canImport(ImageIO)
        guard let source = CGImageSourceCreateWithData(media.data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int else {
            throw ImageCropError("This image can't be decoded on this device, so it can't be cropped. Ask without a region.")
        }
        // Decode upright (EXIF orientation applied) at full size.
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: max(width, height),
        ]
        guard let full = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            throw ImageCropError("This image can't be decoded on this device, so it can't be cropped. Ask without a region.")
        }
        let pixels = CGRect(x: rect.origin.x * Double(full.width), y: rect.origin.y * Double(full.height),
                            width: rect.width * Double(full.width), height: rect.height * Double(full.height)).integral
        guard pixels.width >= 1, pixels.height >= 1, let cropped = full.cropping(to: pixels) else {
            throw ImageCropError("That region is too small to crop.")
        }
        let longSide = max(cropped.width, cropped.height)
        let scale = longSide < minimumLongSide ? Double(minimumLongSide) / Double(longSide)
            : longSide > maximumLongSide ? Double(maximumLongSide) / Double(longSide) : 1
        let output = scale == 1 ? cropped : try resized(cropped, scale: min(scale, 4))
        let png = media.mediaType == "image/png"
        let data = NSMutableData()
        let type = (png ? UTType.png : UTType.jpeg).identifier as CFString
        guard let destination = CGImageDestinationCreateWithData(data, type, 1, nil) else { throw ImageCropError("Couldn't encode the crop.") }
        CGImageDestinationAddImage(destination, output, png ? nil : [kCGImageDestinationLossyCompressionQuality: 0.9] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw ImageCropError("Couldn't encode the crop.") }
        return MediaData(mediaType: png ? "image/png" : "image/jpeg", data: data as Data, name: media.name.map { "\($0) (region)" })
        #else
        throw ImageCropError("Cropping isn't available on this platform. Ask without a region.")
        #endif
    }

    #if canImport(ImageIO)
    private static func resized(_ image: CGImage, scale: Double) throws -> CGImage {
        let w = max(1, Int((Double(image.width) * scale).rounded()))
        let h = max(1, Int((Double(image.height) * scale).rounded()))
        guard let context = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            throw ImageCropError("Couldn't scale the crop.")
        }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        guard let result = context.makeImage() else { throw ImageCropError("Couldn't scale the crop.") }
        return result
    }
    #endif
}
