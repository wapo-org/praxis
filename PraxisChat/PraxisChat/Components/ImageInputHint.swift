import SwiftUI

enum ImageInputHint: Equatable {
    case reader(String)
    case readerNeedsConsent(String)
    case readerCantSeeImages(String)
    case noReader
    case notInThisChat
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
    /// Only shown when live model is known text-only.
    var imageInputHint: ImageInputHint? {
        guard isLive, let services, attachments.contains(where: \.isImage) else { return nil }
        let settings = services.settings
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
