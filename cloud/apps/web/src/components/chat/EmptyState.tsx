import { DURATION, EASE_STANDARD, STAGGER, usePress, useReducedMotion } from '@praxis/glass';
import { motion } from 'framer-motion';
import styles from './ChatScreen.module.css';

type Script = 'text' | 'tools' | 'approval' | 'elicitation';

const SUGGESTIONS: Array<{ label: string; prompt: string; script: Script }> = [
  {
    label: 'Editorial note on liquid glass',
    prompt: 'Write a concise editorial note on Snell’s law refraction in liquid glass UI.',
    script: 'text',
  },
  {
    label: 'Search workspace & build table',
    prompt: 'Search the workspace with tools and summarize the findings in a GFM table.',
    script: 'tools',
  },
  {
    label: 'Test tool approval flow',
    prompt: 'Run a shell command that requires tool approval before executing.',
    script: 'approval',
  },
  {
    label: 'Ask clarifying question',
    prompt: 'Start an elicitation form to clarify deployment parameters.',
    script: 'elicitation',
  },
];

export function EmptyState({ onPick }: { onPick: (prompt: string, script: Script) => void }) {
  const pressProps = usePress();
  const reduced = useReducedMotion();
  const revealInitial = reduced ? false : { opacity: 0, y: 12 };
  const revealAnimate = { opacity: 1, y: 0 };

  return (
    <div data-testid="chat-empty-state" className={styles.empty}>
      <motion.h1
        className={styles.greeting}
        initial={revealInitial}
        animate={revealAnimate}
        transition={{ duration: DURATION.slow, ease: EASE_STANDARD }}
      >
        What are we working on?
      </motion.h1>
      <motion.p
        className={styles.lede}
        initial={revealInitial}
        animate={revealAnimate}
        transition={{ duration: DURATION.slow, delay: STAGGER, ease: EASE_STANDARD }}
      >
        Plan, research and build with live tools and connectors.
      </motion.p>
      <div className={styles.suggestionsReveal}>
        <div data-testid="starter-suggestions" className={styles.suggestions}>
          {SUGGESTIONS.map((item, idx) => (
            <motion.button
              key={item.label}
              type="button"
              className={styles.suggestion}
              data-testid={`starter-chip-${idx}`}
              onClick={() => onPick(item.prompt, item.script)}
              {...pressProps}
              initial={revealInitial}
              animate={revealAnimate}
              transition={{ duration: DURATION.slow, delay: STAGGER * (idx + 2), ease: EASE_STANDARD }}
            >
              {item.label}
            </motion.button>
          ))}
        </div>
      </div>
    </div>
  );
}
