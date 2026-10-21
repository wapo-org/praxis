import SwiftUI

/// Design tokens reconstructed from static evidence in the reference bundle.
/// Values marked `observed` were read from Assets.car / font name tables.
/// Values marked `inferred` follow the observed warm-neutral hue family and
/// standard SwiftUI springs; exact numeric constants live in compiled code
/// and are not present as strings in the binary.
enum Tokens {
    // MARK: Color — observed AccentColor in Assets.car (sRGB components)
    /// Light: components [0.40, 0.39, 0.34, 1] -> #666357
    static let accentLight = Color(red: 0.40, green: 0.39, blue: 0.34)
    /// Dark: components [0.72, 0.71, 0.66, 1] -> #B8B5A8
    static let accentDark = Color(red: 0.72, green: 0.71, blue: 0.66)

    static var accent: Color {
        Color(UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.72, green: 0.71, blue: 0.66, alpha: 1)
                : UIColor(red: 0.40, green: 0.39, blue: 0.34, alpha: 1)
        })
    }

    // Warm-neutral surfaces anchored on the observed accent hue (inferred).
    static let surface = Color(UIColor { t in
        t.userInterfaceStyle == .dark
            ? UIColor(red: 0.16, green: 0.15, blue: 0.14, alpha: 1)
            : UIColor(red: 0.98, green: 0.97, blue: 0.95, alpha: 1)
    })
    static let surfaceRaised = Color(UIColor { t in
        t.userInterfaceStyle == .dark
            ? UIColor(red: 0.22, green: 0.21, blue: 0.19, alpha: 1)
            : UIColor(red: 1.0, green: 0.99, blue: 0.97, alpha: 1)
    })
    static let hairline = Color(UIColor { t in
        t.userInterfaceStyle == .dark
            ? UIColor(white: 1, alpha: 0.10)
            : UIColor(white: 0, alpha: 0.08)
    })

    // MARK: Spacing — 4 pt grid (inferred; no numeric constants in strings)
    static let s1: CGFloat = 4
    static let s2: CGFloat = 8
    static let s3: CGFloat = 12
    static let s4: CGFloat = 16
    static let s5: CGFloat = 20
    static let s6: CGFloat = 24
    static let s8: CGFloat = 32

    // MARK: Radii (inferred)
    static let radiusS: CGFloat = 8
    static let radiusM: CGFloat = 12
    static let radiusL: CGFloat = 20
    static let radiusPill: CGFloat = 999

    // MARK: Typography — observed families: Anthropic Sans/Serif Mobile
    // Text (variable), JetBrains Mono. Proprietary files are not bundled;
    // the custom names resolve when the fonts are installed, otherwise
    // SwiftUI falls back to the system design in the same class.
    static func sans(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .custom("AnthropicSansMobileVariable-TextRegular", size: size)
            .weight(weight)
    }
    static func serif(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .custom("AnthropicSerifMobileVariable-TextRegular", size: size)
            .weight(weight)
    }
    static func mono(_ size: CGFloat) -> Font {
        .custom("JetBrainsMono-Regular", size: size)
    }

    static let titleSerif = serif(28, weight: .medium)
    static let bodySans = sans(16)
    static let bodySerif = serif(16)
    static let captionSans = sans(13)
    static let codeMono = mono(13)

    // MARK: Motion — `Animation.spring()` / `interactiveSpring()` and
    // `initWithDuration:dampingRatio:initialVelocity:` symbols observed.
    // Exact response/damping numbers are compiled constants (unknown).
    static let springSnappy = Animation.spring(response: 0.32, dampingFraction: 0.86)
    static let springGentle = Animation.spring(response: 0.45, dampingFraction: 0.92)
    static let springInteractive = Animation.interactiveSpring(response: 0.28, dampingFraction: 0.82)
    static let easeOutFast = Animation.easeOut(duration: 0.18)
}
