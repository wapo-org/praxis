import { GlassDropdown, GlassSurface } from '@praxis/glass';
import { useMemo } from 'react';
import { Copy, Download, MoreHorizontal, Share, Globe } from '../../lib/icons';
import styles from './MorphLab.module.css';

function ReferenceMenu() {
  return (
    <GlassDropdown.Content minWidth={236}>
      <GlassDropdown.Item icon={<Copy size={16} />}>Copy</GlassDropdown.Item>
      <GlassDropdown.Item icon={<Download size={16} />}>Save as TXT</GlassDropdown.Item>
      <GlassDropdown.Item icon={<Download size={16} />}>Save as PDF</GlassDropdown.Item>
      <GlassDropdown.Separator />
      <GlassDropdown.Item icon={<Globe size={16} />}>Ask Siri</GlassDropdown.Item>
    </GlassDropdown.Content>
  );
}

/** A button with its own glass: that glass becomes the menu. */
function Separate({ testId, align }: { testId: string; align: 'start' | 'end' }) {
  return (
    <GlassDropdown portal align={align}>
      <GlassDropdown.Trigger data-testid={testId} aria-label="Share" hideChevron>
        <Share size={18} />
      </GlassDropdown.Trigger>
      <ReferenceMenu />
    </GlassDropdown>
  );
}

/** A button with text has its own glass but stays in place: only icon buttons morph. */
function Labelled({ testId, align }: { testId: string; align: 'start' | 'end' }) {
  return (
    <GlassDropdown portal align={align}>
      <GlassDropdown.Trigger data-testid={testId}>Export</GlassDropdown.Trigger>
      <ReferenceMenu />
    </GlassDropdown>
  );
}

/** A button sharing glass with a neighbour: the capsule stays, and the menu grows from a blob. */
function Attached({ testId, align }: { testId: string; align: 'start' | 'end' }) {
  return (
    <GlassSurface
      material="regular"
      shape="capsule"
      className={styles.capsule}
      data-testid={`${testId}-capsule`}
    >
      <button type="button" className={styles.capsuleButton} aria-label="Share">
        <Share size={18} />
      </button>
      <GlassDropdown portal align={align}>
        <GlassDropdown.Trigger asChild>
          <button
            type="button"
            className={styles.capsuleButton}
            aria-label="More"
            data-testid={testId}
          >
            <MoreHorizontal size={18} />
          </button>
        </GlassDropdown.Trigger>
        <ReferenceMenu />
      </GlassDropdown>
    </GlassSurface>
  );
}

/** A long-label menu: the cap holds, labels truncate. */
function Wide() {
  return (
    <GlassDropdown portal align="start">
      <GlassDropdown.Trigger data-testid="wide-menu">Notes</GlassDropdown.Trigger>
      <GlassDropdown.Content minWidth={420}>
        {[
          'Review the project plan and summarize the next steps for the entire team',
          'Compare the latest release checklist against the previous milestone',
          'Collect research notes and prepare a concise weekly progress summary',
        ].map((note) => (
          <GlassDropdown.Item key={note} icon={<Copy size={16} />}>
            {note}
          </GlassDropdown.Item>
        ))}
      </GlassDropdown.Content>
    </GlassDropdown>
  );
}

function Nested({ testId, mode }: { testId: string; mode: 'morph' | 'cascade' }) {
  const rows = ['Save as TXT', 'Save as PDF', 'Save as Markdown', 'Save as HTML'];
  return (
    <GlassDropdown portal align="start" submenuMode={mode} closeOnSelect={false}>
      <GlassDropdown.Trigger data-testid={testId}>
        {mode === 'morph' ? 'In place' : 'Cascade'}
      </GlassDropdown.Trigger>
      <GlassDropdown.Content minWidth={236}>
        <GlassDropdown.Item icon={<Copy size={16} />}>Copy</GlassDropdown.Item>
        <GlassDropdown.Sub id={`${testId}-sub`} label="Save as" icon={<Download size={16} />}>
          <GlassDropdown.SubTrigger icon={<Download size={16} />}>Save as</GlassDropdown.SubTrigger>
          <GlassDropdown.SubContent>
            {rows.map((row) => (
              <GlassDropdown.Item key={row}>{row}</GlassDropdown.Item>
            ))}
          </GlassDropdown.SubContent>
        </GlassDropdown.Sub>
        <GlassDropdown.Separator />
        <GlassDropdown.Item icon={<Globe size={16} />}>Ask Siri</GlassDropdown.Item>
      </GlassDropdown.Content>
    </GlassDropdown>
  );
}

/** The menu morph's test scene: both button classes in the corners, over dense text, as in the reference. */
export function MorphLab() {
  const text = useMemo(
    () =>
      Array.from(
        { length: 60 },
        (_, i) =>
          `{"offset":${i * 1420},"duration":${2000 + i * 37},"text":"The menu grows out of the button, over dense text."},`,
      ).join('\n'),
    [],
  );
  return (
    <main className={styles.scene} data-testid="morph-lab">
      <p className={styles.text}>{text}</p>
      <div className={`${styles.corner} ${styles.topEnd}`}>
        <Labelled testId="text-top" align="end" />
        <Attached testId="attached-top" align="end" />
        <Separate testId="separate-top" align="end" />
      </div>
      <div className={`${styles.corner} ${styles.middle}`}>
        <Wide />
        <Nested testId="nested-morph" mode="morph" />
        <Nested testId="nested-cascade" mode="cascade" />
      </div>
      <div className={`${styles.corner} ${styles.bottomStart}`}>
        <Separate testId="separate-bottom" align="start" />
        <Attached testId="attached-bottom" align="start" />
      </div>
    </main>
  );
}
