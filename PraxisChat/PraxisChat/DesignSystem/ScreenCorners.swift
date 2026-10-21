import SwiftUI
import UIKit

/// The display's corner radius and home-indicator inset, read from the
/// hosting window (iOS 26 `effectiveRadius(corner:)`), so floating chrome
/// can sit concentric with the screen's rounded corners on every device.
struct ScreenCorners: Equatable {
    var radius: CGFloat = 0
    var bottomInset: CGFloat = 0

    /// Edge inset that keeps a shape of `cornerRadius` concentric with the
    /// screen corner: equal gap along the sides, the bottom and the curve.
    func concentricInset(for cornerRadius: CGFloat, minimum: CGFloat = 8) -> CGFloat {
        // Unknown radius: home-indicator devices are rounded, and their
        // inset approximates the concentric gap closely.
        let screen = radius > 0 ? radius : (bottomInset > 0 ? cornerRadius + bottomInset : 0)
        return max(minimum, screen - cornerRadius)
    }
}

struct ScreenCornerReader: UIViewRepresentable {
    @Binding var corners: ScreenCorners

    func makeUIView(context: Context) -> ReaderView { ReaderView() }

    func updateUIView(_ view: ReaderView, context: Context) {
        view.onChange = { new in if corners != new { corners = new } }
        view.report()
    }

    /// The window itself reports 0, and SwiftUI's hosting views don't
    /// relay container shapes, so a hidden container-concentric probe sits
    /// directly on the window, flush with the display: its radius is the
    /// display's own corner radius.
    final class ReaderView: UIView {
        var onChange: (ScreenCorners) -> Void = { _ in }
        private let probe: UIView = {
            let view = UIView()
            view.isHidden = true
            view.isUserInteractionEnabled = false
            view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            view.cornerConfiguration = .corners(radius: .containerConcentric())
            return view
        }()

        override func didMoveToWindow() {
            super.didMoveToWindow()
            if let window {
                probe.frame = window.bounds
                window.addSubview(probe)
            } else {
                probe.removeFromSuperview()
            }
            report()
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            report()
        }

        func report() {
            guard let window else { return }
            probe.layoutIfNeeded()
            let value = ScreenCorners(radius: probe.effectiveRadius(corner: .bottomLeft),
                                      bottomInset: window.safeAreaInsets.bottom)
            DispatchQueue.main.async { self.onChange(value) }
        }
    }
}
