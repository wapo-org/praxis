import SwiftUI
import UIKit

/// Marks chip-only glyphs (tile monograms, file-icon spacers) so copying a
/// selection yields the prose, not the placeholders the renderer draws over.
private let chipGlyphKey = NSAttributedString.Key("praxis.chipGlyph")

extension View {
    /// Finished prose selects like regular text: the SwiftUI text keeps
    /// drawing (chips) and stays the accessibility element, while touches
    /// fall through to a native text view laid out identically behind it,
    /// so the highlight sits under the glyphs like any selection. Streaming
    /// text keeps plain SwiftUI hit-testing so the reveal never fights one.
    func selectionLayer(_ text: AttributedString, lineSpacing: CGFloat,
                        font: Font = Type.inter(17), enabled: Bool,
                        onLink: @escaping (URL) -> Void) -> some View {
        allowsHitTesting(!enabled)
            .background {
                if enabled {
                    SelectableTextLayer(text: text, lineSpacing: lineSpacing,
                                        fallbackFont: font, onLink: onLink)
                }
            }
    }
}

/// Native range selection for agent prose: an invisible TextKit 2 view
/// mirroring the drawn runs, fonts and line spacing, so long-press, drag
/// handles and the edit menu behave like regular text. Chip links tap
/// through the same handler the SwiftUI text used.
struct SelectableTextLayer: UIViewRepresentable {
    let text: AttributedString
    let lineSpacing: CGFloat
    var fallbackFont: Font = Type.inter(17)
    let onLink: (URL) -> Void

    func makeUIView(context: Context) -> SelectableTextView {
        let view = SelectableTextView(usingTextLayoutManager: true)
        view.isEditable = false
        view.isSelectable = true
        view.isScrollEnabled = false
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.linkTextAttributes = [:]
        view.tintColor = UIColor(Praxis.ink)
        view.delegate = context.coordinator
        return view
    }

    func updateUIView(_ view: SelectableTextView, context: Context) {
        let coordinator = context.coordinator
        coordinator.onLink = onLink
        // The transcript re-renders on every streamed token; finished
        // paragraphs only rebuild their mirror when their input changes.
        let fonts = context.environment.fontResolutionContext
        let key = Coordinator.Key(text: text, lineSpacing: lineSpacing, fonts: fonts)
        guard coordinator.key != key else { return }
        coordinator.key = key
        view.attributedText = Self.mirror(text, lineSpacing: lineSpacing,
                                          fallback: fallbackFont.resolve(in: fonts).ctFont as UIFont,
                                          fonts: fonts)
    }

    /// Takes exactly the frame of the SwiftUI text it mirrors.
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: SelectableTextView, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? 0, height: proposal.height ?? 0)
    }

    func makeCoordinator() -> Coordinator { Coordinator(onLink: onLink) }

    /// Rebuilds the attributed runs for UIKit with clear ink: same fonts
    /// (resolved from the SwiftUI fonts), tracking, links and line spacing.
    static func mirror(_ text: AttributedString, lineSpacing: CGFloat,
                       fallback: UIFont, fonts: Font.Context) -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = lineSpacing
        paragraph.lineBreakStrategy = .standard
        let out = NSMutableAttributedString()
        for run in text.runs {
            var attrs: [NSAttributedString.Key: Any] = [
                .foregroundColor: UIColor.clear,
                .paragraphStyle: paragraph,
            ]
            let font = run[AttributeScopes.SwiftUIAttributes.FontAttribute.self]
            attrs[.font] = font.map { $0.resolve(in: fonts).ctFont as UIFont } ?? fallback
            if let tracking = run[AttributeScopes.SwiftUIAttributes.TrackingAttribute.self] {
                attrs[.tracking] = tracking
            }
            if let link = run.link { attrs[.link] = link }
            if run[TileTextAttribute.self] != nil { attrs[chipGlyphKey] = true }
            out.append(NSAttributedString(string: String(text[run.range].characters), attributes: attrs))
        }
        return out
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        struct Key: Equatable {
            let text: AttributedString
            let lineSpacing: CGFloat
            let fonts: Font.Context
        }
        var key: Key?
        var onLink: (URL) -> Void
        init(onLink: @escaping (URL) -> Void) { self.onLink = onLink }

        func textView(_ textView: UITextView, primaryActionFor textItem: UITextItem,
                      defaultAction: UIAction) -> UIAction? {
            guard case .link(let url) = textItem.content else { return defaultAction }
            return UIAction { [weak self] _ in self?.onLink(url) }
        }

        /// Chip links are app actions, not web pages: no link preview menu.
        func textView(_ textView: UITextView, menuConfigurationFor textItem: UITextItem,
                      defaultMenu: UIMenu) -> UITextItem.MenuConfiguration? {
            nil
        }
    }
}

final class SelectableTextView: UITextView {
    /// The SwiftUI text in front stays the accessibility element (it
    /// exposes the chip links); the mirror would only duplicate it.
    override var isAccessibilityElement: Bool { get { false } set {} }
    override var accessibilityElementsHidden: Bool { get { true } set {} }

    /// Copies the selected prose as plain text (the mirror's ink is clear,
    /// so rich text would paste invisibly) and drops chip placeholders.
    override func copy(_ sender: Any?) {
        guard let attributed = attributedText, selectedRange.length > 0 else { return }
        var plain = ""
        attributed.enumerateAttributes(in: selectedRange) { attrs, range, _ in
            guard attrs[chipGlyphKey] == nil else { return }
            plain += (attributed.string as NSString).substring(with: range)
        }
        UIPasteboard.general.string = plain.trimmingCharacters(in: .whitespaces)
    }
}
