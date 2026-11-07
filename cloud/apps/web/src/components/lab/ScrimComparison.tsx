import { ProgressiveBlurScrim } from '@praxis/glass';
import styles from './ScrimComparison.module.css';
export function ScrimComparison() {
  return (
    <section className={styles.card}>
      <h2>Progressive blur</h2>
      <div className={styles.viewport}>
        <div className={styles.rows}>
          {Array.from({ length: 20 }, (_, i) => (
            <p key={i}>Conversation {i + 1} · A clear view of what comes next</p>
          ))}
        </div>
        <ProgressiveBlurScrim edge="top" height={48} />
        <ProgressiveBlurScrim edge="bottom" height={48} />
      </div>
    </section>
  );
}
