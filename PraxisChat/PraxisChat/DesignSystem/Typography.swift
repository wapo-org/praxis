import SwiftUI

/// Praxis type. Inter (UI/body), IBM Plex Mono (code/traces/refs),
/// Source Serif 4 (agent headings only). Always `Font.custom(..., relativeTo:)`
/// so Dynamic Type scales (spec §2). Bundled OFL cuts live in Resources/Fonts.
enum Type {
    static func inter(_ size: CGFloat, _ style: Font.TextStyle = .body) -> Font {
        .custom("Inter", size: size, relativeTo: style)
    }
    static func inter(_ size: CGFloat, weight: Font.Weight, _ style: Font.TextStyle = .body) -> Font {
        .custom("Inter", size: size, relativeTo: style).weight(weight)
    }
    static func mono(_ size: CGFloat, _ style: Font.TextStyle = .caption) -> Font {
        .custom("IBM Plex Mono", size: size, relativeTo: style)
    }
    static func mono(_ size: CGFloat, weight: Font.Weight, _ style: Font.TextStyle = .caption) -> Font {
        .custom("IBM Plex Mono", size: size, relativeTo: style).weight(weight)
    }
    static func serif(_ size: CGFloat, weight: Font.Weight = .semibold, _ style: Font.TextStyle = .title) -> Font {
        .custom("Source Serif 4", size: size, relativeTo: style).weight(weight)
    }
}

extension View {
    /// Optical line height ≈1.58 for long-read body (spec §8): Inter 17/27.
    func bodyLineSpacing() -> some View { lineSpacing(10) }
}
