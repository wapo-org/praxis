import SwiftUI

/// Springs only (no linear/ease); scroll-view text and height changes must never overshoot.
enum Motion {
    static let press = Animation.spring(response: 0.16, dampingFraction: 0.86)
    static let release = Animation.spring(response: 0.42, dampingFraction: 0.58)
    static let tap = press
    static let snap = Animation.spring(response: 0.3, dampingFraction: 0.72)
    static let morph = Animation.spring(response: 0.42, dampingFraction: 0.76)
    static let pop = Animation.spring(response: 0.36, dampingFraction: 0.62)
    static let reflow = Animation.spring(response: 0.36, dampingFraction: 0.92)
    static let reveal = Animation.spring(response: 0.3, dampingFraction: 1)
    /// Must finish (~0.15s) before handoff-delayed entrances start so states never overlap.
    static let exit = Animation.spring(response: 0.1, dampingFraction: 1)
    static let handoff: Double = 0.1
    static let send = Animation.spring(response: 0.38, dampingFraction: 0.82)
    static let reduced = Animation.easeOut(duration: 0.15)
}

struct PressScaleStyle: ButtonStyle {
    var scale: CGFloat = 0.96
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? scale : 1)
            .opacity(configuration.isPressed ? 0.82 : 1)
            .animation(reduceMotion ? .easeOut(duration: 0.12)
                       : (configuration.isPressed ? Motion.press : Motion.release),
                       value: configuration.isPressed)
    }
}

/// Uses a fill instead of scaling so scroll-view touches that become drags never shrink rows.
struct PressHighlightStyle: ButtonStyle {
    var cornerRadius: CGFloat = 14
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(Praxis.fill2.opacity(configuration.isPressed ? 0.7 : 0))
                    .padding(-4)
            }
            .animation(configuration.isPressed ? Motion.press : Motion.reveal, value: configuration.isPressed)
    }
}

extension View {
    func revealTransition(reduceMotion: Bool) -> some View {
        transition(reduceMotion ? .opacity : .praxisReveal)
    }
}

extension AnyTransition {
    static var praxisReveal: AnyTransition {
        .asymmetric(
            insertion: .opacity.combined(with: .offset(y: 4)).combined(with: .modifier(
                active: BlurModifier(radius: 4), identity: BlurModifier(radius: 0))),
            removal: .opacity)
    }

    static var praxisPop: AnyTransition {
        .asymmetric(
            insertion: .scale(scale: 0.6).combined(with: .opacity).combined(with: .offset(y: 8)),
            removal: .scale(scale: 0.85).combined(with: .opacity))
    }
}

/// Render-effect reveal (no layout animation to fight scroll anchor); disabled skips history.
struct AppearFade: ViewModifier {
    @State private var shown: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(enabled: Bool = true) {
        _shown = State(initialValue: !enabled)
    }

    func body(content: Content) -> some View {
        content
            .opacity(shown ? 1 : 0)
            .blur(radius: shown || reduceMotion ? 0 : 4)
            .offset(y: shown || reduceMotion ? 0 : 4)
            .onAppear {
                guard !shown else { return }
                withAnimation(reduceMotion ? Motion.reduced : Motion.reveal) { shown = true }
            }
    }
}

extension View {
    func appearFade(_ enabled: Bool = true) -> some View { modifier(AppearFade(enabled: enabled)) }
}

extension EnvironmentValues {
    @Entry var sendLaunch: SendLaunch?
}

/// Deliberately non-observable so composer frame updates on text wrap never re-render transcript.
@MainActor
final class SendLaunch {
    private var fieldFrame: CGRect = .zero
    private var pending: (turnID: UUID, originMaxY: CGFloat, at: Date)?

    func track(_ frame: CGRect) { fieldFrame = frame }

    func arm(turnID: UUID) {
        guard fieldFrame != .zero else { return }
        pending = (turnID, fieldFrame.maxY, Date())
    }

    /// Returns origin only while the send is fresh so lazy-rebuilt history rows return nil.
    func origin(for turnID: UUID) -> CGFloat? {
        guard let pending, pending.turnID == turnID, Date().timeIntervalSince(pending.at) < 1 else { return nil }
        return pending.originMaxY
    }

    func landed(_ turnID: UUID) {
        if pending?.turnID == turnID { pending = nil }
    }
}

/// Measures offset against live bubble position each frame so mid-flight scroll jumps never leap.
private struct SendRise: ViewModifier {
    let turnID: UUID
    let originMaxY: CGFloat?
    @State private var progress: CGFloat
    @Environment(\.sendLaunch) private var launch
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(turnID: UUID, originMaxY: CGFloat?) {
        self.turnID = turnID
        self.originMaxY = originMaxY
        _progress = State(initialValue: originMaxY == nil ? 1 : 0)
    }

    func body(content: Content) -> some View {
        content
            .modifier(RiseEffect(progress: progress, originMaxY: originMaxY ?? 0,
                                 moves: originMaxY != nil && !reduceMotion))
            .onAppear {
                guard progress < 1 else { return }
                launch?.landed(turnID)
                withAnimation(reduceMotion ? Motion.reduced : Motion.send) { progress = 1 }
            }
    }
}

private struct RiseEffect: ViewModifier, Animatable {
    var progress: CGFloat
    let originMaxY: CGFloat
    let moves: Bool

    nonisolated var animatableData: CGFloat {
        get { progress }
        set { progress = newValue }
    }

    func body(content: Content) -> some View {
        let p = progress
        content
            .opacity(min(1, max(0, p * 5)))
            .visualEffect { [originMaxY, moves] effect, proxy in
                let lift = moves ? max(0, originMaxY - proxy.frame(in: .global).maxY) : 0
                return effect
                    .scaleEffect(moves ? 0.94 + 0.06 * p : 1, anchor: .bottomTrailing)
                    .offset(y: lift * (1 - p))
            }
    }
}

extension View {
    func sendRise(turnID: UUID, from originMaxY: CGFloat?) -> some View {
        modifier(SendRise(turnID: turnID, originMaxY: originMaxY))
    }
}

struct BlurModifier: ViewModifier {
    var radius: CGFloat
    func body(content: Content) -> some View { content.blur(radius: radius) }
}
