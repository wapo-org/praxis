import SwiftUI

/// What happens to attached images when the chat model can't see them.
enum ImageInputHint: Equatable {
    /// The image-reading model describes them (`look_at_image`).
    case reader(String)
    /// A reader is picked but its host hasn't been allowed yet.
    case readerNeedsConsent(String)
    /// The picked reader turned out to be text-only too.
    case readerCantSeeImages(String)
    /// No reader configured.
    case noReader
    /// This chat froze its tools with a model that could see images, so it
    /// has no image tool; a new chat gets one.
    case notInThisChat
    /// The model can't call tools, so it can't ask about images either.
    case noTools

    var text: String {
        switch self {
        case .reader(let name): return "This model can't see images. \(name) will describe them for it."
        case .readerNeedsConsent(let name): return "This model can't see images. Allow \(name) in Settings → Image reading model to have it describe them."
        case .readerCantSeeImages(let name): return "This model can't see images, and neither can \(name). Pick one that takes images in Settings → Image reading model."
        case .noReader: return "This model can't see images, and no image-reading model is set up (Settings → Image reading model)."
        case .notInThisChat: return "This model can't see images, and this chat can't hand them to the image-reading model. Start a new chat to use it."
        case .noTools: return "This model can't see images or use tools, so images won't reach it."
        }
    }

    var isWarning: Bool { if case .reader = self { return false }; return true }
}

extension ChatStore {
    /// Shown above the composer while images are attached for a live model
    /// known not to take them (never for one whose support is unknown).
    var imageInputHint: ImageInputHint? {
        guard isLive, let services, attachments.contains(where: \.isImage) else { return nil }
        let settings = services.settings
        // Only a confirmed "no" (profile flag, model list, or an earlier
        // rejection): a model whose support is unknown is simply tried.
        guard settings.selectedProfile != nil, settings.selectedImageSupport == .unsupported else { return nil }
        guard settings.selectedModelSupportsTools else { return .noTools }
        if let conv = selected, let setup = conv.setup,
           conv.turns.contains(where: { $0.engine == .live && !$0.transcript.isEmpty }),
           !setup.toolSpecs.contains(where: { $0.name == "look_at_image" }) {
            return .notInThisChat
        }
        guard let reader = settings.imageReaderSelection(), let name = settings.imageReaderDisplayName else { return .noReader }
        if settings.imageSupport(profileID: reader.profile.id, model: reader.model) == .unsupported {
            return .readerCantSeeImages(name)
        }
        return services.consent.isGranted(baseURL: reader.endpoint.baseURL) ? .reader(name) : .readerNeedsConsent(name)
    }
}

extension Attachment {
    /// A photo, screenshot, camera shot or image file: it reaches the model
    /// as an image part.
    var isImage: Bool {
        hasImage || kind != .file || mediaType?.hasPrefix("image/") == true
    }
}

struct ImageInputHintRow: View {
    let hint: ImageInputHint

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: hint.isWarning ? "eye.slash" : "eye")
                .font(.system(size: 11, weight: .semibold))
            Text(hint.text)
                .font(Type.inter(12, .caption))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .foregroundStyle(hint.isWarning ? Praxis.secondaryInk : Praxis.mutedInk)
        .padding(.horizontal, 14)
        .padding(.top, 6)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("imageInputHint")
        .transition(.opacity)
    }
}
