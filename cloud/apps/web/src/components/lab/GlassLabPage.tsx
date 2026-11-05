import {
  fade,
  GlassChip,
  GlassSurface,
  listItem,
  type MotionPreset,
  popIn,
  ProgressiveBlurScrim,
  ScrollBlur,
  sheet,
  slideIn,
  usePreset,
  usePress,
} from '@praxis/glass';
import { m as motion } from 'framer-motion';
import React from 'react';
import { ArrowDown, ArrowLeft, Moon, Sun } from '../../lib/icons';
import { DropdownPositions } from './DropdownPositions';
import { LabModels } from './LabModels';
import styles from './Lab.module.css';

export interface GlassLabPageProps {
  onNavigateBack?: () => void;
}

function Section({ id, title, note, children }: { id: string; title: string; note: string; children: React.ReactNode }) {
  return (
    <section className={styles.section} data-testid={id} aria-label={title}>
      <h2 className={styles.sectionTitle}>{title}</h2>
      <p className={styles.sectionNote}>{note}</p>
      {children}
    </section>
  );
}

const RECIPES = [
  { material: 'regular', note: 'Composer pill, top-bar clusters' },
  { material: 'thick', note: 'Menus, popovers, sheets, tray' },
  { material: 'clear', note: 'Small floating chips' },
] as const;

const PASSAGE = [
  'Glass is for floating chrome only. Messages, activity rows and cards sit on the paper, and the chrome floats above them.',
  'Four static bands of blur, each masked to its own depth, dissolve the text as it reaches the edge. Nothing runs per frame.',
  'The browser composites the blur on the GPU, so scrolling this panel costs the same as scrolling plain text.',
  'Scroll to see each line soften under the top edge and again above the bottom edge, where the composer would sit.',
  'The feather on top of the bands keeps the paper colour at the very edge, so a line never ends on a hard cut.',
];

function Passage() {
  return PASSAGE.concat(PASSAGE).map((text, index) => (
    <p key={index} className={styles.scrimText}>
      {text}
    </p>
  ));
}

function MotionTile({ name, preset }: { name: string; preset: MotionPreset }) {
  const motionProps = usePreset(preset);
  const [run, setRun] = React.useState(0);
  return (
    <button type="button" className={styles.motionTile} onClick={() => setRun((n) => n + 1)}>
      <span className={styles.motionStage}>
        <motion.span
          key={run}
          className={styles.motionChip}
          initial={motionProps.initial}
          animate={motionProps.animate}
          transition={motionProps.transition}
        />
      </span>
      {name}
    </button>
  );
}

function PressTile() {
  const pressProps = usePress();
  return (
    <motion.button type="button" className={styles.motionTile} {...pressProps}>
      <span className={styles.motionStage}>
        <span className={styles.motionChip} />
      </span>
      press (hold)
    </motion.button>
  );
}

/** The Lab: the real glass recipes, dropdowns, model list, blur and motion, and nothing else. */
export function GlassLabPage({ onNavigateBack }: GlassLabPageProps) {
  const [theme, setTheme] = React.useState<'light' | 'dark'>(() =>
    typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light',
  );
  const toggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('praxis-theme', next);
    } catch {
      /* Private mode: the change still applies to this page. */
    }
  };

  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('dropdown'))
    return <DropdownPositions />;

  return (
    <div data-testid="glass-lab-page" className={styles.page}>
      <header className={styles.header} data-testid="lab-header">
        <GlassChip data-testid="glass-lab-back-button" icon={<ArrowLeft size={16} />} onClick={() => onNavigateBack?.()}>
          Chat
        </GlassChip>
        <h1 className={styles.title}>Lab</h1>
        <GlassChip
          data-testid="glass-lab-theme-toggle"
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          icon={theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          onClick={toggleTheme}
        >
          {theme === 'dark' ? 'Light' : 'Dark'}
        </GlassChip>
      </header>

      <main className={styles.main} data-testid="lab-main">
        <Section id="lab-recipes" title="Glass recipes" note="The three materials and the chip, on a pattern loud enough to judge them.">
          <div className={styles.backdrop}>
            {RECIPES.map(({ material, note }) => (
              <GlassSurface key={material} material={material} className={styles.recipe}>
                <div className={styles.recipeBody}>
                  <span className={styles.recipeName}>{material}</span>
                  <span className={styles.recipeNote}>{note}</span>
                </div>
              </GlassSurface>
            ))}
            <div className={styles.capsules}>
              <GlassChip icon={<ArrowDown size={16} />}>Jump to latest</GlassChip>
            </div>
          </div>
        </Section>

        <Section id="lab-dropdowns" title="Dropdown placements" note="Nine anchors. Each opens the same menu and stays inside the viewport.">
          <DropdownPositions compact />
        </Section>

        <Section id="lab-models" title="500-model picker" note="The tray's model list with 500 local models. Only the visible rows are mounted.">
          <LabModels />
        </Section>

        <Section id="lab-scrim" title="Progressive blur" note="The chat's scrims on the left, a menu or sheet body's scroll fade on the right.">
          <div className={styles.scrims}>
            <figure className={styles.scrimCaption}>
              <figcaption>ProgressiveBlurScrim</figcaption>
              <div className={styles.scrimPanel}>
                <ProgressiveBlurScrim edge="top" height={72} />
                <div className={styles.scrimScroll} tabIndex={0} aria-label="Blur scrim sample">
                  <Passage />
                </div>
                <ProgressiveBlurScrim edge="bottom" height={112} />
              </div>
            </figure>
            <figure className={styles.scrimCaption}>
              <figcaption>ScrollBlur</figcaption>
              <div className={styles.scrimPanel}>
                <ScrollBlur height="100%">
                  <div className={styles.scrimScroll}>
                    <Passage />
                  </div>
                </ScrollBlur>
              </div>
            </figure>
          </div>
        </Section>

        <Section id="lab-motion" title="Motion" note="Every preset from @praxis/glass. Click a tile to replay it.">
          <div className={styles.motionGrid}>
            <MotionTile name="popIn" preset={popIn} />
            <MotionTile name="sheet" preset={sheet} />
            <MotionTile name="fade" preset={fade} />
            <MotionTile name="listItem" preset={listItem} />
            <MotionTile name="slideIn" preset={slideIn} />
            <PressTile />
          </div>
        </Section>
      </main>
    </div>
  );
}
