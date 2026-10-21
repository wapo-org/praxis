import SwiftUI

/// User bubble (§8): right-aligned, max 78%, fill-2, radius 20 with the
/// bottom-trailing corner at 8. Compact density for very short prompts.
/// Long-press: native context menu — Copy / Edit / Resend.
struct UserBubble: View {
    let turn: Turn
    var onCopy: () -> Void = {}
    var onEdit: () -> Void = {}
    var onResend: () -> Void = {}

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
                            }
                        }
                    }
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
        .accessibilityElement(children: .combine)
        .accessibilityLabel("You said: \(turn.userText)")
    }
}

struct AttachmentThumbnail: View {
    let attachment: Attachment
    var size: CGFloat = 56

    var body: some View {
        Group {
            if let data = attachment.imageData, let img = UIImage(data: data) {
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
