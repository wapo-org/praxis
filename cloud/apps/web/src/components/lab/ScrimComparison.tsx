import { ProgressiveBlurScrim, ScrollBlur } from '@praxis/glass';
import './lab.css';

const EDITORIAL_PASSAGES = [
  'The historical record of civil demonstrations and protests through history is primarily brutal and consequential when state apparatus lacks constitutional accountability. Across centuries of archival dispatches, witnesses describe how peaceful assemblies rapidly transform when communication channels fracture and local magistrates lose situational clarity.',
  'In contrast, modern digital historiography preserves frame-by-frame evidence—capturing not merely the written manifesto, but the physical cadence of public gathering, the acoustics of urban boulevards, and the subtle interplay of light and shadow across newsprint.',
  'When designing reading interfaces for dense primary-source archives, typography and chrome must never compete with the manuscript. Floating controls should behave like optical lenses cut from warm crown glass: bending background ink along their curved squircle bezel while diffusing interior luminance into a calm, legible parchment substrate.',
  'Notice how the six-band progressive blur scrim at the top and bottom of the viewport dissolves each line of Source Serif prose across 0.5px, 1.5px, 3.5px, 7px, 12px, and 20px Gaussian radii—eliminating the harsh razor clip of conventional overflow containers.',
  'As you scroll deeper through the transcript, specular rim highlights respond to pointer proximity while Snell-law refraction magnifies the underlying glyphs along the outer 20-pixel perimeter.',
];

export function ScrimComparison() {
  return (
    <section
      data-testid="progressive-blur-comparison-section"
      style={{
        borderRadius: '24px',
        border: '1px solid var(--paper-hairline)',
        backgroundColor: 'var(--paper-card)',
        padding: '24px',
      }}
    >
      <div style={{ marginBottom: '16px' }}>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '10px',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: 'var(--paper-muted-ink)',
          }}
        >
          ProgressiveBlurScrim.swift · 6-Band Variable Edge Feather
        </span>
        <h2 style={{ margin: '2px 0 4px 0', fontSize: '16px', fontWeight: 600 }}>
          ProgressiveBlurScrim (6-Band Feather) vs. Hard Clip Scroll Container
        </h2>
        <p
          style={{
            margin: 0,
            fontSize: '13px',
            color: 'var(--paper-secondary-ink)',
          }}
        >
          Left: 6 stacked backdrop-filter bands (
          <code>0.5px → 1.5px → 3.5px → 7px → 12px → 20px</code>) with warm paper feathering. Right:
          standard CSS <code>overflow-y: auto</code> with a hard razor clip.
        </p>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: '20px',
        }}
      >
        {/* Left: 6-Band ProgressiveBlurScrim */}
        <div
          data-testid="scrim-demo-progressive"
          style={{
            borderRadius: '18px',
            border: '1px solid var(--paper-hairline)',
            backgroundColor: 'var(--paper-canvas)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '10px 16px',
              borderBottom: '1px solid var(--paper-hairline)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: '12px',
              fontWeight: 600,
            }}
          >
            <span>With 6-Band ProgressiveBlurScrim</span>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '11px',
                color: 'var(--paper-success)',
              }}
            >
              0.5px → 20px + Paper Feather
            </span>
          </div>

          <ScrollBlur height={260} scrimHeight={56}>
            <div
              style={{
                padding: '28px 20px',
                fontFamily: 'var(--font-serif)',
                fontSize: '16px',
                lineHeight: '26px',
                color: 'var(--paper-ink)',
              }}
            >
              {EDITORIAL_PASSAGES.map((p, i) => (
                <p key={i} style={{ margin: '0 0 16px 0' }}>
                  {p}
                </p>
              ))}
            </div>
          </ScrollBlur>
        </div>

        {/* Right: Hard Clip */}
        <div
          data-testid="scrim-demo-hard-clip"
          style={{
            borderRadius: '18px',
            border: '1px solid var(--paper-hairline)',
            backgroundColor: 'var(--paper-canvas)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '10px 16px',
              borderBottom: '1px solid var(--paper-hairline)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: '12px',
              fontWeight: 600,
            }}
          >
            <span>Without Scrim (Hard Viewport Clip)</span>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '11px',
                color: 'var(--paper-muted-ink)',
              }}
            >
              overflow-y: auto
            </span>
          </div>

          <div
            style={{
              position: 'relative',
              height: '260px',
              overflowY: 'auto',
              padding: '28px 20px',
              fontFamily: 'var(--font-serif)',
              fontSize: '16px',
              lineHeight: '26px',
              color: 'var(--paper-ink)',
            }}
          >
            {EDITORIAL_PASSAGES.map((p, i) => (
              <p key={i} style={{ margin: '0 0 16px 0' }}>
                {p}
              </p>
            ))}
          </div>
        </div>
      </div>

      {/* Standalone Scrim Inspector Strip */}
      <div
        style={{
          marginTop: '16px',
          position: 'relative',
          height: '68px',
          borderRadius: '14px',
          border: '1px solid var(--paper-hairline)',
          backgroundColor: 'var(--paper-canvas)',
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'var(--font-mono)',
          fontSize: '11px',
          color: 'var(--paper-secondary-ink)',
        }}
      >
        <span>
          6-Band ProgressiveBlurScrim Overlay Preview (Top &amp; Bottom Edge Masks Active)
        </span>
        <ProgressiveBlurScrim edge="top" height={24} />
        <ProgressiveBlurScrim edge="bottom" height={24} />
      </div>
    </section>
  );
}
