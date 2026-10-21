import SwiftUI
import UIKit

/// Praxis design tokens. Exact values from the Praxis spec §4.
/// Doctrine: calm, monochrome, liquid glass — materials that bend light
/// instead of casting shadows.
enum Praxis {
    // MARK: Colour (light / dark, exact hex from spec)

    private static func dyn(_ light: (CGFloat, CGFloat, CGFloat), _ dark: (CGFloat, CGFloat, CGFloat)) -> Color {
        Color(UIColor { t in
            let c = t.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: c.0, green: c.1, blue: c.2, alpha: 1)
        })
    }
    private static func hex(_ v: UInt32) -> (CGFloat, CGFloat, CGFloat) {
        (CGFloat((v >> 16) & 0xFF) / 255, CGFloat((v >> 8) & 0xFF) / 255, CGFloat(v & 0xFF) / 255)
    }
    private static func c(_ light: UInt32, _ dark: UInt32) -> Color { dyn(hex(light), hex(dark)) }

    static let canvas = c(0xFBFBF9, 0x0B0B0A)
    static let card = c(0xFFFFFF, 0x151513)
    static let ink = c(0x15140F, 0xF1EFE9)
    static let mutedInk = c(0x8A877E, 0x8F8C84)
    static let pressedMuted = c(0xB3AFA3, 0x6E6B62)
    /// Lightened in dark mode to clear 4.5:1 (spec §4).
    static let secondaryInk = c(0x6E6B62, 0xA8A49A)
    static let hairline = c(0xE9E6DF, 0x2A2926)
    static let fill1 = c(0xF4F2EC, 0x151513)
    static let fill2 = c(0xE9E6DF, 0x2A2926)
    static let tile = c(0x2A2926, 0xDDD9CF)
    static let tileGlyph = c(0xF4F2EC, 0x151513)
    /// Lightened in dark mode to clear 4.5:1 (spec §4).
    static let success = c(0x17653F, 0x4CC38A)
    static let destructive = c(0xB3382E, 0xFF7A6E)

    // MARK: Rhythm (spec §4)

    static let margin: CGFloat = 20
    static let turnGap: CGFloat = 32
    static let bubbleToAnswer: CGFloat = 16
    static let activityToAnswer: CGFloat = 20
    /// Composer / tray card corner: a full capsule at the 56pt idle height.
    static let composerRadius: CGFloat = 28

    // MARK: Reduce-Transparency hand-built glass (spec §3, Praxis ramp)
    // Frosted fill 5–6% white over strong blur, saturation ×4–×9, 160°
    // primary sheen 55→16→4→0% at 0/26/44/60%, 340° counter-sheen
    // 22→7→0% at 0/22/42%, 1pt rim white 20%, hairline white 8%.

    static func frostedFill(reduceTransparency: Bool) -> some ShapeStyle {
        reduceTransparency ? AnyShapeStyle(Color.white.opacity(0.06)) : AnyShapeStyle(Color.clear)
    }
}
