import SwiftUI
import UIKit

/// Core Animation runs in the render server so looping animations avoid SwiftUI re-rasterization.
private let ambientFrameRate = CAFrameRateRange(minimum: 10, maximum: 30, preferred: 30)

// MARK: Pulsing icon

struct PulsingLucideIcon: UIViewRepresentable {
    let name: String
    var size: CGFloat = 14

    func makeUIView(context: Context) -> PulsingIconView { PulsingIconView() }

    func updateUIView(_ view: PulsingIconView, context: Context) {
        view.configure(name: name, size: size)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: PulsingIconView, context: Context) -> CGSize? {
        CGSize(width: size, height: size)
    }
}

final class PulsingIconView: UIView {
    private let shape = CAShapeLayer()
    private var key: (name: String, size: CGFloat)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        isAccessibilityElement = false
        accessibilityElementsHidden = true
        shape.fillColor = nil
        shape.lineCap = .round
        shape.lineJoin = .round
        layer.addSublayer(shape)
        registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitAccessibilityContrast.self]) {
            (view: PulsingIconView, _: UITraitCollection) in view.applyColor()
        }
        applyColor()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    func configure(name: String, size: CGFloat) {
        guard key?.name != name || key?.size != size else { return }
        key = (name, size)
        let scale = size / 24
        shape.path = LucidePaths.path(for: name)?
            .applying(CGAffineTransform(scaleX: scale, y: scale)).cgPath
        shape.lineWidth = 2 * scale
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let side = key?.size ?? bounds.width
        shape.frame = CGRect(x: (bounds.width - side) / 2, y: (bounds.height - side) / 2, width: side, height: side)
        CATransaction.commit()
    }

    /// Core Animation strips animations on window removal (lazy rows, background); re-add on return.
    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard window != nil else { return layer.removeAnimation(forKey: "pulse") }
        guard layer.animation(forKey: "pulse") == nil else { return }
        let pulse = CABasicAnimation(keyPath: "opacity")
        pulse.fromValue = 1
        pulse.toValue = 0.45
        pulse.duration = 0.8
        pulse.autoreverses = true
        pulse.repeatCount = .infinity
        pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        pulse.preferredFrameRateRange = ambientFrameRate
        layer.add(pulse, forKey: "pulse")
    }

    private func applyColor() {
        shape.strokeColor = UIColor(Praxis.mutedInk).resolvedColor(with: traitCollection).cgColor
    }
}

// MARK: Shimmer text

/// Phase locks to wall clock so recreated lazy rows don't restart the 1.6s shimmer sweep.
struct ShimmerText: UIViewRepresentable {
    let text: String

    func makeUIView(context: Context) -> ShimmerTextView { ShimmerTextView() }

    func updateUIView(_ view: ShimmerTextView, context: Context) {
        let fonts = context.environment.fontResolutionContext
        let font = (context.environment.font ?? .body).resolve(in: fonts).ctFont as UIFont
        view.configure(text: text, font: font)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: ShimmerTextView, context: Context) -> CGSize? {
        uiView.fittingSize(width: proposal.width)
    }
}

final class ShimmerTextView: UIView {
    private let base = UILabel()
    private let highlight = UILabel()
    private let band = CAGradientLayer()
    private var animatedWidth: CGFloat = 0
    static let period: CFTimeInterval = 1.6

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        isAccessibilityElement = false
        accessibilityElementsHidden = true
        for label in [base, highlight] {
            label.numberOfLines = 1
            label.lineBreakMode = .byTruncatingTail
            addSubview(label)
        }
        base.textColor = UIColor(Praxis.mutedInk)
        highlight.textColor = UIColor(Praxis.ink)
        band.colors = [UIColor(white: 1, alpha: 0).cgColor, UIColor.white.cgColor, UIColor(white: 1, alpha: 0).cgColor]
        band.startPoint = CGPoint(x: 0, y: 0.5)
        band.endPoint = CGPoint(x: 1, y: 0.5)
        highlight.layer.mask = band
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    func configure(text: String, font: UIFont) {
        guard base.text != text || base.font != font else { return }
        for label in [base, highlight] {
            label.text = text
            label.font = font
        }
        invalidateIntrinsicContentSize()
        setNeedsLayout()
    }

    func fittingSize(width: CGFloat?) -> CGSize {
        let natural = base.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude))
        return CGSize(width: min(natural.width, width ?? natural.width), height: natural.height)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        base.frame = bounds
        highlight.frame = bounds
        let width = bounds.width
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        band.bounds = CGRect(x: 0, y: 0, width: width, height: bounds.height)
        band.position = CGPoint(x: -width / 2, y: bounds.height / 2)
        CATransaction.commit()
        if width != animatedWidth { animatedWidth = width; startSweep() }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil {
            band.removeAnimation(forKey: "sweep")
        } else if band.animation(forKey: "sweep") == nil {
            startSweep()
        }
    }

    private func startSweep() {
        band.removeAnimation(forKey: "sweep")
        guard window != nil, animatedWidth > 0 else { return }
        let sweep = CABasicAnimation(keyPath: "position.x")
        sweep.fromValue = -animatedWidth / 2
        sweep.toValue = animatedWidth * 1.5
        sweep.duration = Self.period
        sweep.repeatCount = .infinity
        sweep.preferredFrameRateRange = ambientFrameRate
        let phase = Date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: Self.period)
        sweep.beginTime = band.convertTime(CACurrentMediaTime(), from: nil) - phase
        band.add(sweep, forKey: "sweep")
    }
}
