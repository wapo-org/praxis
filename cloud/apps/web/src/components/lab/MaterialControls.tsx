import {
  FINISH_DEFAULTS,
  GlassCard,
  GlassChip,
  MATERIAL_RAMP,
  useGlassRuntime,
  type MaterialLevel,
  type RefractionIntensity,
} from '@praxis/glass';
import { RotateCcw, Sliders } from '../../lib/icons';
import './lab.css';

export function MaterialControls() {
  const overrides = useGlassRuntime((s) => s.overrides);
  const setOverrides = useGlassRuntime((s) => s.setOverrides);
  // Live Material Controls state synced with @praxis/glass store overrides
  const material: MaterialLevel = overrides.material ?? 'regular';
  const intensity: RefractionIntensity = overrides.intensity ?? 'medium';
  const refraction: boolean = overrides.refraction ?? true;
  const frost: 'progressive' | 'uniform' | 'none' = overrides.frost ?? 'progressive';
  const rim = overrides.finish?.rim ?? FINISH_DEFAULTS.rim;
  const sheen = overrides.finish?.sheen ?? FINISH_DEFAULTS.sheen;
  const shadow = overrides.finish?.shadow ?? FINISH_DEFAULTS.shadow;

  const updateFinish = (patch: Partial<{ rim: number; sheen: number; shadow: number }>) => {
    setOverrides({
      finish: {
        ...FINISH_DEFAULTS,
        ...overrides.finish,
        ...patch,
      },
    });
  };

  const resetMaterialControls = () => {
    setOverrides({
      material: 'regular',
      intensity: 'medium',
      refraction: true,
      frost: 'progressive',
      finish: { ...FINISH_DEFAULTS },
    });
  };

  const activeRamp = MATERIAL_RAMP[material];
  return (
    <GlassCard
      data-testid="glass-lab-material-controls"
      radius={20}
      style={{
        padding: '20px 24px',
        border: '1px solid var(--paper-hairline)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '16px',
          flexWrap: 'wrap',
          gap: '8px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Sliders size={16} style={{ color: 'var(--paper-secondary-ink)' }} />
          <h2 style={{ margin: 0, fontSize: '15px', fontWeight: 600 }}>
            Live Material &amp; Snell Bezel Controls
          </h2>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '11px',
              color: 'var(--paper-muted-ink)',
            }}
          >
            bezel {activeRamp.bezel}px · maxDisp {activeRamp.maxDisplacement}px · frost [
            {activeRamp.frostCore}, {activeRamp.frostMid}, {activeRamp.frostRim}]px
          </span>
        </div>
        <GlassChip icon={<RotateCcw size={13} />} onClick={resetMaterialControls}>
          Reset Defaults
        </GlassChip>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '18px',
        }}
      >
        {/* Material Tier */}
        <div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '10px',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--paper-muted-ink)',
              marginBottom: '6px',
            }}
          >
            Material Tier
          </div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {(['ultrathin', 'thin', 'regular', 'thick'] as MaterialLevel[]).map((lvl) => (
              <GlassChip
                key={lvl}
                active={material === lvl}
                onClick={() => setOverrides({ material: lvl })}
              >
                {lvl}
              </GlassChip>
            ))}
          </div>
        </div>

        {/* Refraction Intensity */}
        <div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '10px',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--paper-muted-ink)',
              marginBottom: '6px',
            }}
          >
            Refraction Intensity
          </div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {(['subtle', 'medium', 'strong'] as RefractionIntensity[]).map((int) => (
              <GlassChip
                key={int}
                active={intensity === int}
                onClick={() => setOverrides({ intensity: int })}
              >
                {int}
              </GlassChip>
            ))}
            <GlassChip
              active={refraction}
              onClick={() => setOverrides({ refraction: !refraction })}
            >
              {refraction ? 'Snell Lens: ON' : 'Snell Lens: OFF'}
            </GlassChip>
          </div>
        </div>

        {/* Frost Mode */}
        <div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '10px',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--paper-muted-ink)',
              marginBottom: '6px',
            }}
          >
            Frost Layering
          </div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {(['progressive', 'uniform', 'none'] as const).map((f) => (
              <GlassChip key={f} active={frost === f} onClick={() => setOverrides({ frost: f })}>
                {f}
              </GlassChip>
            ))}
          </div>
        </div>

        {/* Finish Sliders (Rim / Sheen / Shadow) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: '12px',
              color: 'var(--paper-secondary-ink)',
            }}
          >
            <span>Specular Rim ({rim.toFixed(2)})</span>
            <input
              type="range"
              aria-label="Specular Rim"
              min={0}
              max={2}
              step={0.05}
              value={rim}
              onChange={(e) => updateFinish({ rim: parseFloat(e.target.value) })}
            />
          </label>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: '12px',
              color: 'var(--paper-secondary-ink)',
            }}
          >
            <span>Surface Sheen ({sheen.toFixed(2)})</span>
            <input
              type="range"
              aria-label="Surface Sheen"
              min={0}
              max={2}
              step={0.05}
              value={sheen}
              onChange={(e) => updateFinish({ sheen: parseFloat(e.target.value) })}
            />
          </label>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: '12px',
              color: 'var(--paper-secondary-ink)',
            }}
          >
            <span>Elevation Shadow ({shadow.toFixed(2)})</span>
            <input
              type="range"
              aria-label="Elevation Shadow"
              min={0}
              max={2}
              step={0.05}
              value={shadow}
              onChange={(e) => updateFinish({ shadow: parseFloat(e.target.value) })}
            />
          </label>
        </div>
      </div>
    </GlassCard>
  );
}
