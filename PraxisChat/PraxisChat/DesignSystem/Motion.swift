import SwiftUI

/// Motion tokens (spec §11). Springs only — no linear/ease-in-out UI motion.
/// Every animation is interruptible and re-targets from its presented value.
enum Motion {
    /// Press feedback on touch-down: scale 0.96 + highlight.
    static let tap = Animation.spring(response: 0.22, dampingFraction: 0.9)
    /// Toggles, segments, chevrons, icon morphs.
    static let snap = Animation.snappy(duration: 0.25)
    /// Glass merges/splits; composer ↔ tray; mic ↔ send ↔ stop.
    static let morph = Animation.spring(response: 0.38, dampingFraction: 0.82)
    /// Height changes, list inserts, expand/collapse.
    static let reflow = Animation.smooth(duration: 0.35)
    /// Content appearing: fade + 4pt rise + blur 4→0.
    static let reveal = Animation.easeOut(duration: 0.21)
}

/// Press style: feedback starts on touch-down, same frame (spec §1/§11).
struct PressScaleStyle: ButtonStyle {
    var scale: CGFloat = 0.96
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? scale : 1)
            .opacity(configuration.isPressed ? 0.75 : 1)
            .animation(reduceMotion ? .easeOut(duration: 0.12) : Motion.tap, value: configuration.isPressed)
    }
}

extension View {
    /// Reveal transition honouring Reduce Motion (spec §11): crossfade only.
    func revealTransition(reduceMotion: Bool) -> some View {
        transition(reduceMotion
            ? .opacity
            : .asymmetric(
                insertion: .opacity.combined(with: .offset(y: 4)).combined(with: .modifier(
                    active: BlurModifier(radius: 4), identity: BlurModifier(radius: 0))),
                removal: .opacity))
    }
}

struct BlurModifier: ViewModifier {
    var radius: CGFloat
    func body(content: Content) -> some View { content.blur(radius: radius) }
}
