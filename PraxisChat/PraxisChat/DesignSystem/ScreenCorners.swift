import SwiftUI
import UIKit

struct ScreenCorners: Equatable {
    var radius: CGFloat = 0
    var bottomInset: CGFloat = 0

    func concentricInset(for cornerRadius: CGFloat, minimum: CGFloat = 8) -> CGFloat {
        // Fallback when display radius is unknown: home-indicator inset approximates concentric gap.
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

    /// Window reports 0 and SwiftUI drops container shapes, so a window-flush probe reads radius.
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
