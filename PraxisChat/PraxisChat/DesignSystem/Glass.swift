import SwiftUI

/// Liquid Glass helpers (spec §3). Native `glassEffect` everywhere;
/// hand-built frost only as the Reduce Transparency fallback, using the
/// Praxis ramp: 5–6% white frost, 160° sheen 55→16→4→0 (0/26/44/60),
/// 340° counter-sheen 22→7→0 (0/22/42), rim white 20%, hairline 8%.
extension View {
    /// Regular interactive glass in a continuous shape.
    func praxisGlass<S: InsettableShape>(in shape: S, interactive: Bool = true, tint: Color? = nil) -> some View {
        modifier(PraxisGlassModifier(shape: shape, interactive: interactive, tint: tint))
    }
}

private struct PraxisGlassModifier<S: InsettableShape>: ViewModifier {
    let shape: S
    let interactive: Bool
    let tint: Color?
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    func body(content: Content) -> some View {
        var glass = Glass.regular
        if let tint { glass = glass.tint(tint) }
        if interactive { glass = glass.interactive() }
        return Group {
            if reduceTransparency {
                content
                    .background { if let tint { shape.fill(tint) } }
                    .background(FrostedGlass(shape: shape))
                    .overlay(shape.strokeBorder(Color.white.opacity(0.2), lineWidth: 1))
                    .overlay(shape.inset(by: 1).strokeBorder(Color.white.opacity(0.08), lineWidth: 1))
            } else {
                content.glassEffect(glass, in: shape)
            }
        }
    }
}

/// Frosted fallback surface: strong blur + saturation boost + sheens.
private struct FrostedGlass<S: InsettableShape>: View {
    let shape: S
    var body: some View {
        ZStack {
            shape.fill(Color.white.opacity(0.06))
            shape.fill(
                LinearGradient(
                    stops: [
                        .init(color: .white.opacity(0.55), location: 0),
                        .init(color: .white.opacity(0.16), location: 0.26),
                        .init(color: .white.opacity(0.04), location: 0.44),
                        .init(color: .white.opacity(0), location: 0.60),
                    ],
                    startPoint: UnitPoint(x: 0.36, y: 0), // ≈160°
                    endPoint: UnitPoint(x: 0.64, y: 1)
                )
            )
            shape.fill(
                LinearGradient(
                    stops: [
                        .init(color: .white.opacity(0.22), location: 0),
                        .init(color: .white.opacity(0.07), location: 0.22),
                        .init(color: .white.opacity(0), location: 0.42),
                    ],
                    startPoint: UnitPoint(x: 0.64, y: 1), // ≈340°
                    endPoint: UnitPoint(x: 0.36, y: 0)
                )
            )
        }
        .background(.ultraThinMaterial, in: shape)
        .saturation(5)
    }
}
