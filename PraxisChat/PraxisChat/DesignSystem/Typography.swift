import SwiftUI

/// Always use Font.custom(..., relativeTo:) so Dynamic Type scales with bundled OFL fonts.
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
    func bodyLineSpacing() -> some View { lineSpacing(10) }
}
