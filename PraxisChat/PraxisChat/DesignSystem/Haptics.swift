import SwiftUI

/// Haptic vocabulary (spec §12). Never on scroll, never twice per gesture.
/// Callers flip a token with `bump()` and attach `.praxisHaptics(_:)`.
enum Haptic: Equatable {
    case selection, light, soft, success, warning
}

@MainActor
@Observable
final class HapticCenter {
    var token: Int = 0
    var kind: Haptic = .selection
    func fire(_ kind: Haptic) {
        self.kind = kind
        token &+= 1
    }
}

struct PraxisHapticsModifier: ViewModifier {
    @Environment(HapticCenter.self) private var center
    func body(content: Content) -> some View {
        content
            .sensoryFeedback(trigger: center.token) { _, _ in
                switch center.kind {
                case .selection: return .selection
                case .light: return .impact(weight: .light)
                case .soft: return .impact(weight: .light, intensity: 0.5)
                case .success: return .success
                case .warning: return .warning
                }
            }
    }
}

extension View {
    func praxisHaptics() -> some View { modifier(PraxisHapticsModifier()) }
}
