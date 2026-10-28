import SwiftUI

/// Motion tokens (spec §11). Springs only — no linear/ease-in-out UI motion.
/// Every animation is interruptible and re-targets from its presented value.
/// Rule of thumb: things the finger touches overshoot a little; text and
/// height changes inside scroll views never do (bounce there reads as jank).
enum Motion {
    /// Touch-down: reaches the pressed state almost instantly, no overshoot.
    static let press = Animation.spring(response: 0.16, dampingFraction: 0.86)
    /// Touch-up: springs back past rest — the "alive" part of a tap.
    static let release = Animation.spring(response: 0.42, dampingFraction: 0.58)
    /// Kept for callers that animate a press-like state change.
    static let tap = press
    /// Toggles, segments, chevrons, icon morphs.
    static let snap = Animation.spring(response: 0.3, dampingFraction: 0.72)
    /// Glass merges/splits; composer ↔ tray; mic ↔ send ↔ stop.
    static let morph = Animation.spring(response: 0.42, dampingFraction: 0.76)
    /// Small chrome popping in: toast, jump button, badges.
    static let pop = Animation.spring(response: 0.36, dampingFraction: 0.62)
    /// Height changes, list inserts, expand/collapse. Never bounces.
    static let reflow = Animation.spring(response: 0.36, dampingFraction: 0.92)
    /// Content appearing: fade + 4pt rise + blur 4→0.
    static let reveal = Animation.spring(response: 0.3, dampingFraction: 1)
    /// Quick exit used for removals: gone in ~0.15s, before any delayed
    /// entrance starts, so two states are never drawn on top of each other.
    static let exit = Animation.spring(response: 0.1, dampingFraction: 1)
    /// Delay for an entrance that follows an `exit` in the same spot.
    static let handoff: Double = 0.1
    /// A sent bubble rising from the composer into the thread: quick, with
    /// a hair of settle at the end, like Messages.
    static let send = Animation.spring(response: 0.38, dampingFraction: 0.82)
    /// Reduce Motion stand-in for every token above.
    static let reduced = Animation.easeOut(duration: 0.15)
}

/// Press style: feedback starts on touch-down, same frame (spec §1/§11).
/// Down is quick and flat; release overshoots slightly so even short taps
/// read as a physical squish.
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

/// Row press style for list rows inside scroll views: a soft fill instead of
/// scaling, so a touch that turns into a scroll never shrinks the row.
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
    /// Reveal transition honouring Reduce Motion (spec §11): crossfade only.
    func revealTransition(reduceMotion: Bool) -> some View {
        transition(reduceMotion ? .opacity : .praxisReveal)
    }
}

extension AnyTransition {
    /// Fade + 4pt rise + blur 4→0 on the way in; a quick fade out.
    static var praxisReveal: AnyTransition {
        .asymmetric(
            insertion: .opacity.combined(with: .offset(y: 4)).combined(with: .modifier(
                active: BlurModifier(radius: 4), identity: BlurModifier(radius: 0))),
            removal: .opacity)
    }

    /// Small chrome popping in from below with a bounce, shrinking out.
    static var praxisPop: AnyTransition {
        .asymmetric(
            insertion: .scale(scale: 0.6).combined(with: .opacity).combined(with: .offset(y: 8)),
            removal: .scale(scale: 0.85).combined(with: .opacity))
    }
}

/// Fades content in when it first appears — opacity, blur and a small
/// rise drawn as render effects only. Layout is never animated, so rows
/// streaming into the transcript can't fight the scroll anchor.
/// Disabled, it starts shown: history rows the lazy transcript builds
/// while scrolling back must not fade in like fresh content.
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
    /// Shared by the composer (which records where its text sits) and the
    /// transcript (whose new bubble rises from there).
    @Entry var sendLaunch: SendLaunch?
}

/// Send, Messages-style: the new bubble rises from where the text sat in
/// the composer to its place at the bottom of the thread. Nothing else in
/// the transcript animates — the send itself runs without an animation
/// transaction, and the jump to the bottom is instant (see
/// `TranscriptView.pinToBottom`).
///
/// Deliberately not observable: the composer reports its frame on every
/// wrap, and that must not re-render the transcript.
@MainActor
final class SendLaunch {
    /// The composer's text field, in global coordinates.
    private var fieldFrame: CGRect = .zero
    private var pending: (turnID: UUID, originMaxY: CGFloat, at: Date)?

    func track(_ frame: CGRect) { fieldFrame = frame }

    /// Called just before the turn is created.
    func arm(turnID: UUID) {
        guard fieldFrame != .zero else { return }
        pending = (turnID, fieldFrame.maxY, Date())
    }

    /// Where the bubble for `turnID` starts: the bottom of the field, while
    /// the send is fresh. A row the lazy transcript rebuilds later (scrolled
    /// back into view) gets nil and simply sits in place.
    func origin(for turnID: UUID) -> CGFloat? {
        guard let pending, pending.turnID == turnID, Date().timeIntervalSince(pending.at) < 1 else { return nil }
        return pending.originMaxY
    }

    func landed(_ turnID: UUID) {
        if pending?.turnID == turnID { pending = nil }
    }
}

/// Runs the rise on the bubble row. The start offset is measured against
/// the bubble's live position every frame, so the instant jump to the
/// bottom (or a reply row landing under it) mid-flight never makes it
/// leap: it always travels from the composer to wherever it now rests.
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
            // Shows almost at once: it starts under the composer's glass,
            // where the typed text just was.
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
    /// The rise for a just-sent bubble; `originMaxY` nil means no rise.
    func sendRise(turnID: UUID, from originMaxY: CGFloat?) -> some View {
        modifier(SendRise(turnID: turnID, originMaxY: originMaxY))
    }
}

struct BlurModifier: ViewModifier {
    var radius: CGFloat
    func body(content: Content) -> some View { content.blur(radius: radius) }
}
