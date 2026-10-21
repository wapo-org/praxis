import SwiftUI

/// Draws CodePill + IntegrationAvatar backgrounds behind inline runs and
/// the per-word streaming reveal (spec §9.2/§10): new words fade from 0
/// with a 2pt rise over ~180ms, per text run — never a view per word.
struct ChipTextRenderer: TextRenderer {
    /// Words with fadeIndex below this are fully visible.
    var revealedWords: Double = .infinity
    var animatableData: Double {
        get { revealedWords }
        set { revealedWords = newValue }
    }

    func draw(layout: Text.Layout, in ctx: inout GraphicsContext) {
        // Chip backgrounds first, from each run's layout bounds + padding.
        for line in layout {
            for run in line {
                let rect = run.typographicBounds.rect
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
        // Runs, with the streaming reveal per word run.
        for line in layout {
            for run in line {
                for slice in run {
                    var runCtx = ctx
                    if let fade = slice[FadeMarker.self] {
                        let t = min(max(revealedWords - fade.index, 0), 1)
                        runCtx.opacity = t
                        if t < 1 {
                            runCtx.translateBy(x: 0, y: (1 - t) * 2)
                            runCtx.addFilter(.blur(radius: (1 - t) * 4))
                        }
                    }
                    runCtx.draw(slice)
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
