import SwiftUI

/// Shared button styles for the app's secondary screens (Settings, Skills,
/// Connectors, sheets). One height, one font, one icon-to-label rhythm, one
/// press feel, so a primary and a secondary action sitting side by side
/// differ in material only: calm, monochrome, liquid glass.
///
///     Button { … } label: { PraxisButtonLabel("Import skill", systemImage: "square.and.arrow.down") }
///         .buttonStyle(.praxisPrimary())
///
/// - Primary: ink-filled capsule (inverts in dark mode via `Praxis.ink`).
/// - Secondary: native interactive glass capsule, same metrics as primary.
/// - Text: no chrome, for inline actions ("Withdraw", "Remove saved key").
/// - Icon: round glass button for single-glyph actions (back, close).
///
/// `Button(role: .destructive)` turns the label red in secondary/text, and
/// the fill red in primary. Disabled dims to 40% everywhere.
enum PraxisButtonSize: Sendable {
    case regular, compact

    var minHeight: CGFloat { self == .regular ? 44 : 36 }
    var horizontalPadding: CGFloat { self == .regular ? 20 : 16 }
    var iconLabelSpacing: CGFloat { self == .regular ? 7 : 6 }
    var iconSize: CGFloat { self == .regular ? 13 : 12 }
    var font: Font {
        self == .regular ? Type.inter(15, weight: .semibold, .body)
                         : Type.inter(14, weight: .semibold, .subheadline)
    }
    /// Diameter of the icon-only circle.
    var circle: CGFloat { self == .regular ? 44 : 32 }
    /// Glyph size inside the icon-only circle.
    var circleGlyph: CGFloat { self == .regular ? 14 : 13 }
}

extension EnvironmentValues {
    /// Set by the Praxis button styles so `PraxisButtonLabel` matches them.
    @Entry var praxisButtonSize: PraxisButtonSize = .regular
}

/// Standard label: optional SF Symbol, title, optional spinner replacing the
/// symbol while work is in flight. Font and spacing come from the style.
struct PraxisButtonLabel: View {
    let title: String
    var systemImage: String?
    var working = false
    @Environment(\.praxisButtonSize) private var size

    init(_ title: String, systemImage: String? = nil, working: Bool = false) {
        self.title = title
        self.systemImage = systemImage
        self.working = working
    }

    var body: some View {
        HStack(spacing: size.iconLabelSpacing) {
            if working {
                ProgressView().controlSize(.small)
            } else if let systemImage {
                Image(systemName: systemImage).font(.system(size: size.iconSize, weight: .semibold))
            }
            Text(title).lineLimit(1)
        }
    }
}

// MARK: Capsule action styles

private enum PraxisButtonKind { case primary, secondary }

private struct PraxisCapsuleButtonBody: View {
    let configuration: ButtonStyleConfiguration
    let kind: PraxisButtonKind
    let size: PraxisButtonSize
    let fillsWidth: Bool
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var destructive: Bool { configuration.role == .destructive }
    private var pressed: Bool { configuration.isPressed }
    private var foreground: Color {
        switch kind {
        case .primary: Praxis.canvas
        case .secondary: destructive ? Praxis.destructive : Praxis.ink
        }
    }

    var body: some View {
        let content = configuration.label
            .font(size.font)
            .foregroundStyle(foreground)
            .tint(foreground)
            .environment(\.praxisButtonSize, size)
            .padding(.horizontal, size.horizontalPadding)
            .frame(minHeight: size.minHeight)
            .frame(maxWidth: fillsWidth ? .infinity : nil)
            .contentShape(Capsule())
        Group {
            switch kind {
            case .primary:
                content
                    .background {
                        Capsule().fill(destructive ? Praxis.destructive : Praxis.ink)
                    }
                    .overlay { Capsule().strokeBorder(Praxis.canvas.opacity(0.14), lineWidth: 0.5) }
                    .scaleEffect(pressed && !reduceMotion ? 0.96 : 1)
                    .opacity(pressed ? 0.82 : 1)
            case .secondary:
                content
                    .scaleEffect(pressed && !reduceMotion ? 0.96 : 1)
                    .opacity(pressed ? 0.82 : 1)
                    .praxisGlass(in: Capsule())
            }
        }
        .opacity(isEnabled ? 1 : 0.4)
        .animation(reduceMotion ? .easeOut(duration: 0.12) : (pressed ? Motion.press : Motion.release), value: pressed)
    }
}

/// Ink-filled capsule: the one main action on a screen.
struct PraxisPrimaryButtonStyle: ButtonStyle {
    var size: PraxisButtonSize = .regular
    var fillsWidth = false
    func makeBody(configuration: Configuration) -> some View {
        PraxisCapsuleButtonBody(configuration: configuration, kind: .primary, size: size, fillsWidth: fillsWidth)
    }
}

/// Interactive glass capsule with the primary's metrics.
struct PraxisSecondaryButtonStyle: ButtonStyle {
    var size: PraxisButtonSize = .regular
    var fillsWidth = false
    func makeBody(configuration: Configuration) -> some View {
        PraxisCapsuleButtonBody(configuration: configuration, kind: .secondary, size: size, fillsWidth: fillsWidth)
    }
}

// MARK: Text and icon styles

/// No chrome: an inline action inside a row or a footer.
struct PraxisTextButtonStyle: ButtonStyle {
    var muted = false
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        let color = configuration.role == .destructive ? Praxis.destructive
            : (muted ? Praxis.secondaryInk : Praxis.ink)
        configuration.label
            .font(Type.inter(14, weight: .medium, .subheadline))
            .foregroundStyle(color)
            .tint(color)
            .environment(\.praxisButtonSize, .compact)
            .contentShape(Rectangle())
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.96 : 1)
            .opacity(configuration.isPressed ? 0.82 : (isEnabled ? 1 : 0.4))
            .animation(reduceMotion ? .easeOut(duration: 0.12)
                       : (configuration.isPressed ? Motion.press : Motion.release),
                       value: configuration.isPressed)
    }
}

/// Round glass button for a single glyph (back, close).
struct PraxisIconButtonStyle: ButtonStyle {
    var size: PraxisButtonSize = .regular
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: size.circleGlyph, weight: .semibold))
            .foregroundStyle(Praxis.ink)
            .frame(width: size.circle, height: size.circle)
            .contentShape(Circle())
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.96 : 1)
            .opacity(configuration.isPressed ? 0.82 : 1)
            .animation(reduceMotion ? .easeOut(duration: 0.12)
                       : (configuration.isPressed ? Motion.press : Motion.release),
                       value: configuration.isPressed)
            .praxisGlass(in: Circle())
            .opacity(isEnabled ? 1 : 0.4)
    }
}

// MARK: Style lookup sugar

extension ButtonStyle where Self == PraxisPrimaryButtonStyle {
    static var praxisPrimary: PraxisPrimaryButtonStyle { .init() }
    static func praxisPrimary(_ size: PraxisButtonSize = .regular, fillsWidth: Bool = false) -> PraxisPrimaryButtonStyle {
        .init(size: size, fillsWidth: fillsWidth)
    }
}

extension ButtonStyle where Self == PraxisSecondaryButtonStyle {
    static var praxisSecondary: PraxisSecondaryButtonStyle { .init() }
    static func praxisSecondary(_ size: PraxisButtonSize = .regular, fillsWidth: Bool = false) -> PraxisSecondaryButtonStyle {
        .init(size: size, fillsWidth: fillsWidth)
    }
}

extension ButtonStyle where Self == PraxisTextButtonStyle {
    static var praxisText: PraxisTextButtonStyle { .init() }
    static func praxisText(muted: Bool) -> PraxisTextButtonStyle { .init(muted: muted) }
}

extension ButtonStyle where Self == PraxisIconButtonStyle {
    static var praxisIcon: PraxisIconButtonStyle { .init() }
    static func praxisIcon(_ size: PraxisButtonSize) -> PraxisIconButtonStyle { .init(size: size) }
}
