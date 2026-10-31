import { DropdownPositions } from './DropdownPositions';
import React from 'react';
import { AppleNotesReplica } from './AppleNotesReplica';
import './lab.css';
import {
  ArrowLeft,
  Check,
  Clock,
  Eye,
  FileText,
  Folder,
  Grid,
  LayoutGrid,
  Lock,
  Moon,
  MoreHorizontal,
  Pin,
  Plus,
  RotateCcw,
  ScanLine,
  Search,
  Share,
  Sliders,
  Sparkles,
  Star,
  Sun,
  Trash2,
  Zap,
} from '../../lib/icons';
import {
  DotMeter,
  FINISH_DEFAULTS,
  GlassCard,
  GlassChip,
  GlassDropdown,
  GlassIconButton,
  GlassSurface,
  MATERIAL_RAMP,
  ProgressiveBlurScrim,
  ScrollBlur,
  useGlassMaterial,
  useGlassRuntime,
  type GlassStrategy,
  type MaterialLevel,
  type RefractionIntensity,
} from '@praxis/glass';

export interface GlassLabPageProps {
  onNavigateBack?: () => void;
}

interface SyntheticModel {
  id: string;
  provider: string;
  name: string;
  tagline: string;
  speed: number;
  intelligence: number;
  vision: boolean;
  contextWindow: string;
}

const PROVIDERS = ['Anthropic', 'OpenAI', 'Google DeepMind', 'Groq', 'Mistral', 'Local Ollama'];
const MODEL_FAMILIES = [
  'Claude 3.7 Sonnet',
  'Claude 3.5 Haiku',
  'GPT-4.5 Orion',
  'o3-mini High',
  'Gemini 2.5 Pro',
  'Gemini 2.5 Flash',
  'Llama 3.3 70B SpecDec',
  'DeepSeek R1 Distill',
  'Mistral Large 2',
  'Qwen 2.5 Coder 32B',
];

const SYNTHETIC_500_MODELS: SyntheticModel[] = Array.from({ length: 500 }, (_, i) => {
  const provider = PROVIDERS[i % PROVIDERS.length]!;
  const family = MODEL_FAMILIES[i % MODEL_FAMILIES.length]!;
  const speed = ((i * 3) % 5) + 1;
  const intelligence = ((i * 7) % 5) + 1;
  return {
    id: `model-${i + 1}`,
    provider,
    name: `${family} #${i + 1}`,
    tagline: `${provider} · ${i % 2 === 0 ? 'Low-latency reasoning' : 'Extended context synthesis'}`,
    speed,
    intelligence,
    vision: i % 3 !== 0,
    contextWindow: i % 4 === 0 ? '1M' : i % 2 === 0 ? '200k' : '128k',
  };
});

/**
 * Exact 5 multi-line recent note previews from IMG_7773.PNG – IMG_7774.PNG
 */


const EDITORIAL_PASSAGES = [
  'The historical record of civil demonstrations and protests through history is primarily brutal and consequential when state apparatus lacks constitutional accountability. Across centuries of archival dispatches, witnesses describe how peaceful assemblies rapidly transform when communication channels fracture and local magistrates lose situational clarity.',
  'In contrast, modern digital historiography preserves frame-by-frame evidence—capturing not merely the written manifesto, but the physical cadence of public gathering, the acoustics of urban boulevards, and the subtle interplay of light and shadow across newsprint.',
  'When designing reading interfaces for dense primary-source archives, typography and chrome must never compete with the manuscript. Floating controls should behave like optical lenses cut from warm crown glass: bending background ink along their curved squircle bezel while diffusing interior luminance into a calm, legible parchment substrate.',
  'Notice how the six-band progressive blur scrim at the top and bottom of the viewport dissolves each line of Source Serif prose across 0.5px, 1.5px, 3.5px, 7px, 12px, and 20px Gaussian radii—eliminating the harsh razor clip of conventional overflow containers.',
  'As you scroll deeper through the transcript, specular rim highlights respond to pointer proximity while Snell-law refraction magnifies the underlying glyphs along the outer 20-pixel perimeter.',
];

export function GlassLabPage({ onNavigateBack }: GlassLabPageProps) {
  const { strategy: contextStrategy } = useGlassMaterial();
  const runtimeStrategy = useGlassRuntime((s) => s.strategy);
  const setRuntimeStrategy = useGlassRuntime((s) => s.setStrategy);
  const overrides = useGlassRuntime((s) => s.overrides);
  const setOverrides = useGlassRuntime((s) => s.setOverrides);

  const activeStrategy: GlassStrategy = runtimeStrategy || contextStrategy;

  const [theme, setTheme] = React.useState<'light' | 'dark'>(() => {
    if (typeof document !== 'undefined') {
      return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    }
    return 'light';
  });

  const toggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', next);
    }
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem('praxis-theme', next);
      } catch {}
    }
  };

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

  // 2. 500-Model Virtualized Picker state
  const [modelPickerOpen, setModelPickerOpen] = React.useState(false);
  const [modelSearch, setModelSearch] = React.useState('');
  const [selectedModelId, setSelectedModelId] = React.useState<string>('model-1');
  const [pinnedModelIds, setPinnedModelIds] = React.useState<Set<string>>(
    () => new Set(['model-1', 'model-2', 'model-5']),
  );

  const filteredModels = React.useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    const list = q
      ? SYNTHETIC_500_MODELS.filter(
          (m) =>
            m.name.toLowerCase().includes(q) ||
            m.provider.toLowerCase().includes(q) ||
            m.tagline.toLowerCase().includes(q),
        )
      : SYNTHETIC_500_MODELS;
    return [...list].sort((a, b) => {
      const aPin = pinnedModelIds.has(a.id) ? 1 : 0;
      const bPin = pinnedModelIds.has(b.id) ? 1 : 0;
      return bPin - aPin;
    });
  }, [modelSearch, pinnedModelIds]);

  const selectedModel =
    SYNTHETIC_500_MODELS.find((m) => m.id === selectedModelId) ?? SYNTHETIC_500_MODELS[0]!;

  const togglePinModel = (id: string) => {
    setPinnedModelIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const activeRamp = MATERIAL_RAMP[material];
  if (
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).has('dropdown')
  ) return <DropdownPositions />;

  return (
    <div
      data-testid="glass-lab-page"
      style={{
        width: '100vw',
        height: '100dvh',
        overflowY: 'auto',
        backgroundColor: 'var(--paper-canvas)',
        color: 'var(--paper-ink)',
        fontFamily: 'var(--font-sans)',
        paddingBottom: '80px',
      }}
    >
      {/* Top Sticky Floating Header */}
      <header className="glass-lab-header"
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 90,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '12px',
          padding: '14px 24px',
          borderBottom: '1px solid var(--paper-hairline)',
          backgroundColor: 'color-mix(in srgb, var(--paper-canvas) 82%, transparent)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <GlassChip
            data-testid="glass-lab-back-button"
            icon={<ArrowLeft size={14} />}
            onClick={() => onNavigateBack?.()}
          >
            Back to Chat
          </GlassChip>
          <div>
            <h1
              style={{
                margin: 0,
                fontFamily: 'var(--font-serif)',
                fontSize: '20px',
                fontWeight: 600,
                letterSpacing: '-0.01em',
              }}
            >
              Liquid Glass Optical Lab
            </h1>
            <div style={{ fontSize: '12px', color: 'var(--paper-secondary-ink)' }}>
              @praxis/glass · Snell Squircle Refraction &amp; 35-Frame UIMenu Physics
            </div>
          </div>
        </div>

        {/* Engine Strategy Badge & Theme Switcher */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <div
            data-testid="glass-lab-strategy-badge"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '5px 11px',
              borderRadius: '9999px',
              backgroundColor: 'var(--paper-fill-1)',
              border: '1px solid var(--paper-hairline)',
              fontFamily: 'var(--font-mono)',
              fontSize: '11px',
              fontWeight: 500,
              color: 'var(--paper-ink)',
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: '9999px',
                backgroundColor:
                  activeStrategy === 'svg-displacement'
                    ? 'var(--paper-success)'
                    : activeStrategy === 'progressive-frost'
                      ? '#D97706'
                      : 'var(--paper-muted-ink)',
              }}
            />
            <span>Engine: {activeStrategy}</span>
          </div>

          <div
            role="group"
            aria-label="Simulate glass engine strategy"
            style={{
              display: 'inline-flex',
              padding: '2px',
              borderRadius: '9999px',
              backgroundColor: 'var(--paper-fill-1)',
              border: '1px solid var(--paper-hairline)',
            }}
          >
            {(
              ['svg-displacement', 'progressive-frost', 'reduced-transparency'] as GlassStrategy[]
            ).map((strat) => (
              <button
                key={strat}
                type="button"
                onClick={() => setRuntimeStrategy(strat)}
                style={{
                  border: 'none',
                  borderRadius: '9999px',
                  padding: '4px 9px',
                  fontSize: '11px',
                  fontFamily: 'var(--font-mono)',
                  cursor: 'pointer',
                  backgroundColor:
                    activeStrategy === strat ? 'var(--paper-tile)' : 'transparent',
                  color:
                    activeStrategy === strat
                      ? 'var(--paper-tile-glyph)'
                      : 'var(--paper-secondary-ink)',
                }}
              >
                {strat === 'svg-displacement'
                  ? 'SVG'
                  : strat === 'progressive-frost'
                    ? 'Frost'
                    : 'Opaque'}
              </button>
            ))}
          </div>

          <GlassChip
            data-testid="glass-lab-theme-toggle"
            icon={theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
            onClick={toggleTheme}
          >
            {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
          </GlassChip>
        </div>
      </header>

      <main className="glass-lab-main"
        style={{
          maxWidth: '1240px',
          margin: '0 auto',
          padding: '24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '28px',
        }}
      >
        {/* 1. Live Material Controls Panel */}
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
                  <GlassChip
                    key={f}
                    active={frost === f}
                    onClick={() => setOverrides({ frost: f })}
                  >
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

        <DropdownPositions compact />
        {/* Two-column showcase: Apple Notes 35-Frame Replica & 500-Model Virtualized Picker */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 460px), 1fr))',
            gap: '24px',
            alignItems: 'start',
          }}
        >
          {/* 2. Apple Notes 35-Frame Reference Replica Dropdown (IMG_7744 – IMG_7778) */}
          <AppleNotesReplica />

          {/* 3. 500-Model Virtualized Picker Demo */}
          <section
            data-testid="virtual-model-picker-section"
            style={{
              borderRadius: '24px',
              border: '1px solid var(--paper-hairline)',
              backgroundColor: 'var(--paper-card)',
              padding: '22px',
              minHeight: '640px',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
            }}
          >
            <div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: '16px',
                  flexWrap: 'wrap',
                  gap: '10px',
                }}
              >
                <div>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '10px',
                      textTransform: 'uppercase',
                      letterSpacing: '0.08em',
                      color: 'var(--paper-muted-ink)',
                    }}
                  >
                    60fps Windowed Combobox · 500 Synthetic Models
                  </span>
                  <h2 style={{ margin: '2px 0 0 0', fontSize: '16px', fontWeight: 600 }}>
                    500-Model Virtualized Picker Demo
                  </h2>
                </div>

                <GlassDropdown
                  portal
                  open={modelPickerOpen}
                  onOpenChange={setModelPickerOpen}
                  align="end"
                  side="bottom"
                >
                  <GlassDropdown.Trigger
                    data-testid="virtual-model-picker-trigger"
                    icon={<Zap size={14} />}
                    value={selectedModel.contextWindow}
                  >
                    {selectedModel.name}
                  </GlassDropdown.Trigger>

                  <GlassDropdown.Content minWidth={340} maxHeight={380}>
                    <GlassDropdown.Search
                      data-testid="virtual-model-picker-search"
                      value={modelSearch}
                      onValueChange={setModelSearch}
                      placeholder="Filter 500+ models…"
                    />

                    <GlassDropdown.VirtualList
                      items={filteredModels}
                      itemHeight={54}
                      height={310}
                      overscan={6}
                      renderItem={(model) => {
                        const isPinned = pinnedModelIds.has(model.id);
                        return (
                          <GlassDropdown.Item
                            key={model.id}
                            selected={model.id === selectedModelId}
                            subtitle={model.tagline}
                            onSelect={() => setSelectedModelId(model.id)}
                            badge={
                              <span
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '6px',
                                }}
                              >
                                {model.vision ? (
                                  <Eye
                                    size={12}
                                    aria-label="Vision supported"
                                    style={{ color: 'var(--paper-secondary-ink)' }}
                                  />
                                ) : null}
                                <DotMeter value={model.speed} label="⚡" />
                                <DotMeter value={model.intelligence} label="✦" />
                              </span>
                            }
                            trailingAction={
                              <button
                                type="button"
                                aria-label={isPinned ? `Unpin ${model.name}` : `Pin ${model.name}`}
                                onClick={() => togglePinModel(model.id)}
                                style={{
                                  border: 'none',
                                  background: 'transparent',
                                  padding: '4px',
                                  cursor: 'pointer',
                                  color: isPinned
                                    ? 'var(--paper-ink)'
                                    : 'var(--paper-muted-ink)',
                                  display: 'inline-flex',
                                }}
                              >
                                <Star
                                  size={13}
                                  fill={isPinned ? 'currentColor' : 'none'}
                                />
                              </button>
                            }
                          >
                            {model.name}
                          </GlassDropdown.Item>
                        );
                      }}
                    />
                  </GlassDropdown.Content>
                </GlassDropdown>
              </div>

              {/* Active Model Summary Card + Inline Preview of Virtualization */}
              <GlassSurface
                shape="card"
                radius={18}
                material={material}
                style={{
                  padding: '16px 18px',
                  marginBottom: '16px',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '12px',
                    flexWrap: 'wrap',
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: '11px',
                        color: 'var(--paper-secondary-ink)',
                      }}
                    >
                      Active Selection · {selectedModel.provider}
                    </div>
                    <div style={{ fontSize: '16px', fontWeight: 600, marginTop: '2px' }}>
                      {selectedModel.name}
                    </div>
                    <div
                      style={{
                        fontSize: '12.5px',
                        color: 'var(--paper-secondary-ink)',
                        marginTop: '2px',
                      }}
                    >
                      {selectedModel.tagline}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <DotMeter value={selectedModel.speed} label="Speed ⚡" />
                    <DotMeter value={selectedModel.intelligence} label="Intel ✦" />
                  </div>
                </div>
              </GlassSurface>

              {/* Always-visible interactive virtualized list benchmark box */}
              <div
                style={{
                  borderRadius: '16px',
                  border: '1px solid var(--paper-hairline)',
                  backgroundColor: 'var(--paper-canvas)',
                  padding: '12px',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: '8px',
                    fontSize: '12px',
                    color: 'var(--paper-secondary-ink)',
                  }}
                >
                  <span>
                    Showing {filteredModels.length} of {SYNTHETIC_500_MODELS.length} models (
                    {pinnedModelIds.size} pinned ★)
                  </span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}>
                    DOM window: ~18 nodes
                  </span>
                </div>

                <GlassDropdown portal closeOnSelect={false}>
                  <GlassDropdown.Trigger>
                    Open benchmark picker
                  </GlassDropdown.Trigger>
                  <GlassDropdown.Content
                    minWidth={320}
                    maxHeight={260}
                  >
                    <GlassDropdown.Search
                      value={modelSearch}
                      onValueChange={setModelSearch}
                      placeholder="Search 500 synthetic models by name or provider…"
                    />
                    <GlassDropdown.VirtualList
                      items={filteredModels}
                      itemHeight={52}
                      height={210}
                      overscan={5}
                      renderItem={(model) => {
                        const isPinned = pinnedModelIds.has(model.id);
                        return (
                          <GlassDropdown.Item
                            key={model.id}
                            selected={model.id === selectedModelId}
                            subtitle={model.tagline}
                            keepOpen
                            onSelect={() => setSelectedModelId(model.id)}
                            badge={
                              <span
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '6px',
                                }}
                              >
                                <DotMeter value={model.speed} label="⚡" />
                                <DotMeter value={model.intelligence} label="✦" />
                              </span>
                            }
                            trailingAction={
                              <button
                                type="button"
                                aria-label={isPinned ? `Unpin ${model.name}` : `Pin ${model.name}`}
                                onClick={() => togglePinModel(model.id)}
                                style={{
                                  border: 'none',
                                  background: 'transparent',
                                  padding: '4px',
                                  cursor: 'pointer',
                                  color: isPinned
                                    ? 'var(--paper-ink)'
                                    : 'var(--paper-muted-ink)',
                                  display: 'inline-flex',
                                }}
                              >
                                <Star size={13} fill={isPinned ? 'currentColor' : 'none'} />
                              </button>
                            }
                          >
                            {model.name}
                          </GlassDropdown.Item>
                        );
                      }}
                    />
                  </GlassDropdown.Content>
                </GlassDropdown>
              </div>
            </div>

            <div
              style={{
                marginTop: '16px',
                fontSize: '12px',
                fontFamily: 'var(--font-mono)',
                color: 'var(--paper-secondary-ink)',
                paddingTop: '12px',
                borderTop: '1px solid var(--paper-hairline)',
                display: 'flex',
                justifyContent: 'space-between',
              }}
            >
              <span>Selected: {selectedModel.id}</span>
              <span>Speed {selectedModel.speed}/5 · Intelligence {selectedModel.intelligence}/5</span>
            </div>
          </section>
        </div>

        {/* 4. ProgressiveBlurScrim Scroll Container Demo (Side-by-Side Comparison) */}
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
            <p style={{ margin: 0, fontSize: '13px', color: 'var(--paper-secondary-ink)' }}>
              Left: 6 stacked backdrop-filter bands (<code>0.5px → 1.5px → 3.5px → 7px → 12px → 20px</code>)
              with warm paper feathering. Right: standard CSS <code>overflow-y: auto</code> with a hard razor clip.
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
      </main>
    </div>
  );
}
