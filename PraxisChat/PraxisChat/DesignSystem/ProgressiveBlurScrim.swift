import SwiftUI
import UIKit

/// True variable (progressive) blur protecting text under screen chrome.
///
/// The blur RADIUS grows toward the edge — text goes from sharp, to
/// slightly soft, to strongly blurred — with only a whisper of
/// theme-aware canvas tint. Built from public API only: `bands` stacked
/// `UIVisualEffectView`s, each masked to a band reaching further inward
/// than the one above it, so content near the edge is blurred repeatedly
/// while the tail gets a single soft pass. No `CAFilter.variableBlur`
/// (private API, App Store rejection risk).
///
/// Where the system can do it instead, it does: scroll views under
/// navigation bars, toolbars and `safeAreaBar`s use
/// `.scrollEdgeEffectStyle(.soft)` (Apple's own progressive blur). This
/// scrim is for chrome the system effect can't see — the chat's floating
/// composer dock (a ZStack overlay, not a bar) and the tray card's bottom.
///
/// `hold` matters more than `length`: with a straight fade from the edge,
/// chrome sitting partway down the field lands where the blur has already
/// weakened. The held band gets every layer at full strength.
///
/// Live blur is expensive while scrolling: use it for screen chrome only.
/// Small in-content edges (code blocks, command output) use `fadeEdges`.
struct ProgressiveBlurScrim: View {
    enum Edge { case top, bottom, leading, trailing }
    var edge: Edge = .top
    var length: CGFloat = 110
    /// Stacked blur layers (clamped to 1...6). Each extra layer re-blurs
    /// a shorter band toward the edge, stepping the effective radius up.
    var bands: Int = 4
    /// Share of `length` (from the edge) kept at full strength: the band
    /// the chrome sits on. The rest feathers out.
    var hold: CGFloat = 0
    /// Peak canvas tint at the edge, fading out with the blur. A
    /// readability aid only — keep it subtle (≤ 0.15), never a gradient
    /// wash. Theme-aware via `Praxis.canvas`.
    var tint: CGFloat = 0.12

    var body: some View {
        ZStack {
            VariableBlurView(edge: edge, hold: hold, bands: bands)
            if tint > 0 {
                LinearGradient(
                    stops: Self.profile(hold: hold).map {
                        .init(color: Praxis.canvas.opacity(tint * $0.strength), location: $0.location)
                    },
                    startPoint: start, endPoint: end
                )
            }
        }
        .frame(
            width: (edge == .leading || edge == .trailing) ? length : nil,
            height: (edge == .top || edge == .bottom) ? length : nil
        )
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    /// Inner reach of each blur layer, as a fraction of `length` from the
    /// edge. Layer 0 reaches the full length; deeper layers stop sooner,
    /// so the edge gets all `bands` blur passes and the tail gets one.
    /// Strictly decreasing, all in (0, 1], every one past `hold`.
    static func bandReach(bands: Int, hold: CGFloat) -> [CGFloat] {
        let bands = min(max(bands, 1), 6)
        let hold = min(max(hold, 0), 0.8)
        guard bands > 1 else { return [1] }
        return (0..<bands).map { i in
            1 - (1 - hold) * CGFloat(i) / CGFloat(bands)
        }
    }

    /// Alpha-mask stops for one blur layer: full from the edge (location
    /// 0) to `reach - feather`, feathering to clear at `reach` so band
    /// steps never read as lines. Locations ascend in 0...1.
    static func maskStops(reach: CGFloat, feather: CGFloat = 0.10) -> [(location: CGFloat, strength: CGFloat)] {
        let reach = min(max(reach, 0.01), 1)
        let knee = max(reach - feather, 0)
        if knee <= 0.001 { return [(0, 1), (reach, 0)] }
        return [(0, 1), (knee, 1), (reach, 0)]
    }

    /// Strength from the edge (location 0) inward: flat over the held
    /// band, then an ease-out feather (steep early, long soft tail) so the
    /// end of the field never reads as a line.
    static func profile(hold: CGFloat) -> [(location: CGFloat, strength: CGFloat)] {
        let hold = min(max(hold, 0), 0.8)
        let feather: [CGFloat] = [1.0, 0.92, 0.80, 0.64, 0.46, 0.29, 0.14, 0.05, 0.0]
        var stops: [(CGFloat, CGFloat)] = hold > 0 ? [(0, 1)] : []
        for (i, strength) in feather.enumerated() {
            stops.append((hold + (1 - hold) * CGFloat(i) / CGFloat(feather.count - 1), strength))
        }
        return stops
    }

    private var start: UnitPoint {
        switch edge {
        case .top: return .top
        case .bottom: return .bottom
        case .leading: return .leading
        case .trailing: return .trailing
        }
    }

    private var end: UnitPoint {
        switch edge {
        case .top: return .bottom
        case .bottom: return .top
        case .leading: return .trailing
        case .trailing: return .leading
        }
    }
}

private struct VariableBlurView: UIViewRepresentable {
    let edge: ProgressiveBlurScrim.Edge
    let hold: CGFloat
    let bands: Int

    func makeUIView(context: Context) -> VariableBlurContainer {
        VariableBlurContainer(edge: edge, hold: hold, bands: bands)
    }

    func updateUIView(_ view: VariableBlurContainer, context: Context) {
        view.edge = edge
        view.hold = hold
        view.bands = bands
    }
}

/// The stacked blur layers and their gradient masks. Rebuilt only when
/// the configuration changes, so parent re-renders never rebuild layers
/// or queue async work; masks resize in `layoutSubviews`.
private final class VariableBlurContainer: UIView {
    private var layers: [(view: UIVisualEffectView, mask: CAGradientLayer)] = []

    var edge: ProgressiveBlurScrim.Edge {
        didSet { if edge != oldValue { rebuild() } }
    }

    var hold: CGFloat {
        didSet { if hold != oldValue { rebuild() } }
    }

    var bands: Int {
        didSet { if bands != oldValue { rebuild() } }
    }

    init(edge: ProgressiveBlurScrim.Edge, hold: CGFloat, bands: Int) {
        self.edge = edge
        self.hold = hold
        self.bands = bands
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        rebuild()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    private func rebuild() {
        layers.forEach { $0.view.removeFromSuperview() }
        layers = []
        for reach in ProgressiveBlurScrim.bandReach(bands: bands, hold: hold) {
            let view = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterial))
            view.isUserInteractionEnabled = false
            view.frame = bounds
            view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            let mask = CAGradientLayer()
            let stops = ProgressiveBlurScrim.maskStops(reach: reach)
            mask.colors = stops.map { UIColor.white.withAlphaComponent($0.strength).cgColor }
            mask.locations = stops.map { NSNumber(value: Double($0.location)) }
            switch edge {
            case .top:
                mask.startPoint = CGPoint(x: 0.5, y: 0); mask.endPoint = CGPoint(x: 0.5, y: 1)
            case .bottom:
                mask.startPoint = CGPoint(x: 0.5, y: 1); mask.endPoint = CGPoint(x: 0.5, y: 0)
            case .leading:
                mask.startPoint = CGPoint(x: 0, y: 0.5); mask.endPoint = CGPoint(x: 1, y: 0.5)
            case .trailing:
                mask.startPoint = CGPoint(x: 1, y: 0.5); mask.endPoint = CGPoint(x: 0, y: 0.5)
            }
            mask.frame = bounds
            view.layer.mask = mask
            addSubview(view)
            layers.append((view, mask))
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for layer in layers { layer.mask.frame = bounds }
        CATransaction.commit()
    }
}

extension View {
    /// Cheap feathered edges for in-content scroll areas: an alpha mask,
    /// no live blur, so scrolling the transcript past it costs nothing.
    func fadeEdges(_ axis: Axis, length: CGFloat = 16, leading: Bool = true, trailing: Bool = true) -> some View {
        mask {
            GeometryReader { geo in
                let extent = axis == .horizontal ? geo.size.width : geo.size.height
                let f = extent > 0 ? min(length / extent, 0.5) : 0
                LinearGradient(stops: [
                    .init(color: leading ? .clear : .black, location: 0),
                    .init(color: .black, location: f),
                    .init(color: .black, location: 1 - f),
                    .init(color: trailing ? .clear : .black, location: 1),
                ], startPoint: axis == .horizontal ? .leading : .top,
                   endPoint: axis == .horizontal ? .trailing : .bottom)
            }
        }
    }
}
