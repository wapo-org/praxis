import SwiftUI
import ImageIO

/// User bubble (§8): right-aligned, max 78%, fill-2, radius 20 with the
/// bottom-trailing corner at 8. Compact density for very short prompts.
/// Long-press: native context menu — Copy / Edit / Resend. Long-press an
/// attachment: "Hide from code" / "Available to code".
struct UserBubble: View {
    let turn: Turn
    var onCopy: () -> Void = {}
    var onEdit: () -> Void = {}
    var onResend: () -> Void = {}
    /// Bottom of the composer's text field when this turn was just sent:
    /// the bubble rises from there. Nil for every other appearance.
    var riseFrom: CGFloat?
    /// Optional so previews without a store still render.
    @Environment(ChatStore.self) private var store: ChatStore?

    private var isCompact: Bool { turn.userText.count <= 24 && turn.attachments.isEmpty }

    var body: some View {
        HStack {
            Spacer(minLength: 0)
            VStack(alignment: .trailing, spacing: 8) {
                if !turn.attachments.isEmpty {
                    // Same rounded-square boxes as the composer strip;
                    // scrolls sideways instead of overflowing the bubble
                    // column when a turn carries many attachments.
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(turn.attachments) { att in
                                AttachmentThumbnail(attachment: att, size: 56)
                                    .codeAccessMenu(att) { store?.setHiddenFromCode($0, attachmentID: att.id) }
                            }
                        }
                    }
                    // A strip that fits needs no clip (it would shave the
                    // thumbnails' code-hidden badges).
                    .scrollClipDisabled(turn.attachments.count <= 4)
                    .frame(maxWidth: 680 * 0.78)
                }
                if !turn.userText.isEmpty {
                    Text(turn.userText)
                        .font(Type.inter(isCompact ? 15 : 16, isCompact ? .footnote : .body))
                        .lineSpacing(isCompact ? 5 : 6)
                        .foregroundStyle(Praxis.ink)
                        .padding(.horizontal, isCompact ? 13 : 16)
                        .padding(.vertical, isCompact ? 7 : 10)
                        .background(
                            Praxis.fill2,
                            in: UnevenRoundedRectangle(
                                topLeadingRadius: 20, bottomLeadingRadius: 20,
                                bottomTrailingRadius: 8, topTrailingRadius: 20,
                                style: .continuous)
                        )
                        .contextMenu {
                            Button { UIPasteboard.general.string = turn.userText; onCopy() } label: {
                                Label("Copy", systemImage: "doc.on.doc")
                            }
                            Button { onEdit() } label: {
                                Label("Edit", systemImage: "pencil")
                            }
                            Button { onResend() } label: {
                                Label("Resend", systemImage: "arrow.up.circle")
                            }
                        }
                }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .frame(maxWidth: 680 * 0.78, alignment: .trailing)
        .frame(maxWidth: .infinity, alignment: .trailing)
        .sendRise(turnID: turn.id, from: riseFrom)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("You said: \(turn.userText)")
    }
}

struct AttachmentThumbnail: View {
    let attachment: Attachment
    var size: CGFloat = 56
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        Group {
            if let img = ThumbnailCache.image(for: attachment, side: size * displayScale) {
                Image(uiImage: img).resizable().scaledToFill()
            } else {
                ZStack {
                    Praxis.fill1
                    Image(systemName: attachment.kind == .file ? "doc" : "photo")
                        .foregroundStyle(Praxis.mutedInk)
                }
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Praxis.hairline, lineWidth: 1))
        .accessibilityLabel(attachment.name)
    }
}

// MARK: Code access

extension View {
    /// Long-press menu on an attachment thumbnail: "Hide from code" /
    /// "Available to code" (JS `fs` access, `Attachment.isHiddenFromCode`),
    /// plus a small badge while hidden. VoiceOver gets the same as an
    /// action and reads the state as the value.
    func codeAccessMenu(_ attachment: Attachment, setHidden: @escaping (Bool) -> Void) -> some View {
        let hidden = attachment.isHiddenFromCode
        let title = hidden ? "Available to code" : "Hide from code"
        return self
            .overlay(alignment: .bottomTrailing) {
                if hidden { CodeHiddenBadge().padding(4).transition(.scale.combined(with: .opacity)) }
            }
            .contextMenu {
                Section(hidden ? "Code can't open this file" : "Code can open this file") {
                    Button { setHidden(!hidden) } label: {
                        Label(title, systemImage: hidden ? "curlybraces" : "eye.slash")
                    }
                }
            }
            .accessibilityValue(hidden ? "Hidden from code" : "")
            .accessibilityAction(named: title) { setHidden(!hidden) }
    }
}

/// Quiet marker on a thumbnail the user hid from code.
private struct CodeHiddenBadge: View {
    var body: some View {
        Image(systemName: "eye.slash")
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(Praxis.ink)
            .frame(width: 20, height: 20)
            .praxisGlass(in: Circle(), interactive: false)
            .accessibilityHidden(true)
    }
}

/// Downsampled thumbnails, decoded once per attachment. `UIImage(data:)` in
/// `body` decoded full-resolution camera photos on every render — during
/// streaming that was every token, for every visible bubble.
@MainActor
enum ThumbnailCache {
    private static let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 200
        return cache
    }()

    static func image(for attachment: Attachment, side: CGFloat) -> UIImage? {
        guard let data = attachment.imageData else { return nil }
        let key = "\(attachment.id.uuidString)-\(Int(side))" as NSString
        if let hit = cache.object(forKey: key) { return hit }
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            // Long-side cap; 2× leaves the short side sharp under scaledToFill.
            kCGImageSourceThumbnailMaxPixelSize: max(side * 2, 1),
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        let image = UIImage(cgImage: cg)
        cache.setObject(image, forKey: key)
        return image
    }
}
