import { usePress } from '@praxis/glass';
import { m as motion } from 'framer-motion';
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

/** Centered greeting and suggestion chips for a new conversation. */
export function EmptyState({ onPick }: { onPick: (prompt: string, script: Script) => void }) {
  const pressProps = usePress();
  return (
    <div data-testid="chat-empty-state" className={styles.empty}>
      <h1 className={styles.greeting}>What are we working on?</h1>
      <p className={styles.lede}>Plan, research and build with live tools and connectors.</p>
      <div data-testid="starter-suggestions" className={styles.suggestions}>
        {SUGGESTIONS.map((item, idx) => (
          <motion.button
            key={item.label}
            type="button"
            className={styles.suggestion}
            data-testid={`starter-chip-${idx}`}
            onClick={() => onPick(item.prompt, item.script)}
            {...pressProps}
          >
            {item.label}
          </motion.button>
        ))}
      </div>
    </div>
  );
}
