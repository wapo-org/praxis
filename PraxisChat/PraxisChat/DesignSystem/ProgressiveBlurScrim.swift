import SwiftUI
import UIKit

/// Feathered blur field protecting text under chrome (spec §3).
/// Blur is strongest at the screen edge and feathers smoothly to zero,
/// paired with a canvas tint fading 65%→0%. No visible start line.
/// Built from public APIs: a `UIVisualEffectView` whose alpha mask is a
/// multi-stop gradient (8 bands of decreasing intensity), layered under
/// the native `scrollEdgeEffectStyle(.soft)`.
struct ProgressiveBlurScrim: View {
    enum Edge { case top, bottom, leading, trailing }
    var edge: Edge = .top
    var length: CGFloat = 110
    var maxRadius: CGFloat = 18 // visual strength at the edge band

    var body: some View {
        ZStack {
            ProgressiveBlurView(edge: edge)
            LinearGradient(
                colors: [Praxis.canvas.opacity(0.65), Praxis.canvas.opacity(0)],
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

    func makeUIView(context: Context) -> UIVisualEffectView {
        let view = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterial))
        view.isUserInteractionEnabled = false
        installMask(on: view)
        return view
    }

    func updateUIView(_ view: UIVisualEffectView, context: Context) {
        installMask(on: view)
    }

    private func installMask(on view: UIVisualEffectView) {
        // 8 bands of decreasing alpha — strongest at the chrome edge.
        let bands: [CGFloat] = [1.0, 0.92, 0.80, 0.64, 0.46, 0.29, 0.14, 0.0]
        let gradient = CAGradientLayer()
        gradient.colors = bands.map { UIColor.white.withAlphaComponent($0).cgColor }
        gradient.locations = bands.indices.map { NSNumber(value: Double($0) / Double(bands.count - 1)) }
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
        gradient.frame = view.bounds.isEmpty ? CGRect(x: 0, y: 0, width: 400, height: 400) : view.bounds
        view.layer.mask = gradient
        // Keep the mask sized with the view.
        DispatchQueue.main.async {
            CATransaction.begin(); CATransaction.setDisableActions(true)
            gradient.frame = view.bounds
            CATransaction.commit()
        }
    }
}
