import SwiftUI
import UIKit

/// Feathered blur field protecting text under chrome (spec §3).
/// Blur holds full strength over the chrome itself (`hold`, a fraction of
/// `length`), then feathers smoothly to zero below it, paired with a
/// canvas tint fading 72%→0% on the same profile. No visible start line.
/// Built from public APIs: a `UIVisualEffectView` whose alpha mask is a
/// multi-stop gradient, layered under the native `scrollEdgeEffectStyle(.soft)`.
///
/// `hold` matters more than `length`: with a straight fade from the edge,
/// the toolbar title sat where the blur was already down to ~25% and text
/// scrolling behind it stayed legible enough to clash.
///
/// Live blur is expensive while scrolling: use it for screen chrome only.
/// Small in-content edges (code blocks, command output) use `fadeEdges`.
struct ProgressiveBlurScrim: View {
    enum Edge { case top, bottom, leading, trailing }
    var edge: Edge = .top
    var length: CGFloat = 110
    var maxRadius: CGFloat = 18 // visual strength at the edge band
    /// Share of `length` (from the edge) kept at full strength: the band
    /// the chrome sits on. The rest feathers out.
    var hold: CGFloat = 0

    var body: some View {
        ZStack {
            ProgressiveBlurView(edge: edge, hold: hold)
            LinearGradient(
                stops: Self.profile(hold: hold).map {
                    .init(color: Praxis.canvas.opacity(0.72 * $0.strength), location: $0.location)
                },
                startPoint: start, endPoint: end
            )
        }
        .frame(
            width: (edge == .leading || edge == .trailing) ? length : nil,
            height: (edge == .top || edge == .bottom) ? length : nil
        )
        .allowsHitTesting(false)
        .accessibilityHidden(true)
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

private struct ProgressiveBlurView: UIViewRepresentable {
    let edge: ProgressiveBlurScrim.Edge
    let hold: CGFloat

    func makeUIView(context: Context) -> MaskedBlurView {
        MaskedBlurView(edge: edge, hold: hold)
    }

    func updateUIView(_ view: MaskedBlurView, context: Context) {
        view.edge = edge
        view.hold = hold
    }
}

/// The gradient mask is built once and resized in `layoutSubviews`, so
/// parent re-renders never rebuild layers or queue async work.
private final class MaskedBlurView: UIVisualEffectView {
    private let gradient = CAGradientLayer()

    var edge: ProgressiveBlurScrim.Edge {
        didSet { if edge != oldValue { applyDirection() } }
    }

    var hold: CGFloat {
        didSet { if hold != oldValue { applyProfile() } }
    }

    init(edge: ProgressiveBlurScrim.Edge, hold: CGFloat) {
        self.edge = edge
        self.hold = hold
        super.init(effect: UIBlurEffect(style: .systemUltraThinMaterial))
        isUserInteractionEnabled = false
        applyProfile()
        applyDirection()
        layer.mask = gradient
    }

    /// Bands of decreasing alpha — full over the held band at the edge.
    private func applyProfile() {
        let stops = ProgressiveBlurScrim.profile(hold: hold)
        gradient.colors = stops.map { UIColor.white.withAlphaComponent($0.strength).cgColor }
        gradient.locations = stops.map { NSNumber(value: Double($0.location)) }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        gradient.frame = bounds
        CATransaction.commit()
    }

    private func applyDirection() {
        switch edge {
        case .top:
            gradient.startPoint = CGPoint(x: 0.5, y: 0); gradient.endPoint = CGPoint(x: 0.5, y: 1)
        case .bottom:
            gradient.startPoint = CGPoint(x: 0.5, y: 1); gradient.endPoint = CGPoint(x: 0.5, y: 0)
        case .leading:
            gradient.startPoint = CGPoint(x: 0, y: 0.5); gradient.endPoint = CGPoint(x: 1, y: 0.5)
        case .trailing:
            gradient.startPoint = CGPoint(x: 1, y: 0.5); gradient.endPoint = CGPoint(x: 0, y: 0.5)
        }
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
