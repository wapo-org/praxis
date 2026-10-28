import SwiftUI

/// Draws CodePill + IntegrationAvatar backgrounds behind inline runs and
/// the streaming reveal (spec §9.2/§10): new glyphs fade from 0 with a
/// 2pt rise and blur as the reveal front sweeps past — never a view per
/// word, and no timeline: `revealedLength` is animatable, so the caller
/// animates it toward the received length and SwiftUI interpolates.
struct ChipTextRenderer: TextRenderer {
    /// Characters a glyph needs behind the front to be fully visible —
    /// roughly three words of soft leading edge.
    static let fadeSpan: Double = 18

    /// Glyphs whose offset is below this (minus the span) are fully visible.
    var revealedLength: Double = .infinity
    var animatableData: Double {
        get { revealedLength }
        set { revealedLength = newValue }
    }

    private func progress(at offset: Double) -> Double {
        guard revealedLength.isFinite else { return 1 }
        return min(max((revealedLength - offset) / Self.fadeSpan, 0), 1)
    }

    func draw(layout: Text.Layout, in ctx: inout GraphicsContext) {
        // Chip backgrounds first, from each run's layout bounds + padding.
        for line in layout {
            for run in line {
                let rect = run.typographicBounds.rect
                var ctx = ctx
                if let fade = run[FadeMarker.self] {
                    let t = progress(at: fade.index)
                    if t <= 0 { continue }
                    ctx.opacity = t
                }
                if run[PillMarker.self] != nil {
                    let pill = RoundedRectangle(cornerRadius: 4, style: .continuous)
                        .path(in: rect.insetBy(dx: -6, dy: -2))
                    ctx.fill(pill, with: .color(Praxis.fill1))
                }
                if let tile = run[TileMarker.self], tile.monogram.hasPrefix("file-") {
                    // FileRef icon (§9.2): the Lucide glyph stroked at 14pt.
                    if let glyph = LucidePaths.path(for: tile.monogram) {
                        let s = 14.0 / 24.0
                        var iconCtx = ctx
                        iconCtx.translateBy(x: rect.minX, y: rect.midY - 7)
                        iconCtx.scaleBy(x: s, y: s)
                        iconCtx.stroke(glyph, with: .color(Praxis.mutedInk),
                                       style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                    }
                }
                if let tile = run[TileMarker.self], tile.monogram.count == 1,
                   run.typographicBounds.width < 30 {
                    let size: CGFloat = 16
                    let tileRect = CGRect(
                        x: rect.minX - 1, y: rect.midY - size / 2,
                        width: size, height: size)
                    let tilePath = RoundedRectangle(cornerRadius: 4, style: .continuous).path(in: tileRect)
                    ctx.fill(tilePath, with: .color(Praxis.tile))
                    // Centre the monogram optically (the source glyph is clear).
                    let glyph = ctx.resolve(
                        Text(tile.monogram)
                            .font(Type.inter(9, weight: .semibold, .caption2))
                            .foregroundStyle(Praxis.tileGlyph))
                    ctx.draw(glyph, at: CGPoint(x: tileRect.midX, y: tileRect.midY), anchor: .center)
                }
            }
        }
        // Glyphs. Finished text draws whole runs; only glyphs inside the
        // soft front pay for per-slice opacity, rise and blur.
        for line in layout {
            for run in line {
                guard let fade = run[FadeMarker.self], revealedLength.isFinite,
                      progress(at: fade.index + Double(run.count)) < 1 else {
                    ctx.draw(run)
                    continue
                }
                for (offset, slice) in run.enumerated() {
                    let t = progress(at: fade.index + Double(offset))
                    if t <= 0 { break }
                    if t >= 1 { ctx.draw(slice); continue }
                    var sliceCtx = ctx
                    sliceCtx.opacity = t
                    sliceCtx.translateBy(x: 0, y: (1 - t) * 2)
                    sliceCtx.addFilter(.blur(radius: (1 - t) * 4))
                    sliceCtx.draw(slice)
                }
            }
        }
    }
}

/// Small glass "Copied" toast (§9.2).
struct CopiedToast: View {
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "checkmark").font(.system(size: 11, weight: .semibold))
            Text("Copied").font(Type.inter(13, weight: .medium, .caption))
        }
        .foregroundStyle(Praxis.ink)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .praxisGlass(in: Capsule())
        .accessibilityLabel("Copied")
    }
}
