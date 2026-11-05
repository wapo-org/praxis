import React from 'react';
import { ExternalLink } from '../../lib/icons';
import { safeLink } from '../../lib/links';
import type { ActiveElicitation } from '../../state/types';
import { humanizeToolName } from './activityLine';
import type { AgentActivityViewProps } from './activityTypes';
import styles from './InlineCard.module.css';

type FieldSpec = { type?: string; title?: string; description?: string; default?: unknown };

const isNumeric = (spec: FieldSpec) => spec.type === 'number' || spec.type === 'integer';

/** The answer to send: what was typed, else each field's schema default. Nothing is invented. */
export function elicitationPayload(specs: Record<string, FieldSpec>, values: Record<string, string>) {
  const payload: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(specs)) {
    const typed = values[key];
    if (typed !== undefined && typed !== '') payload[key] = isNumeric(spec) ? Number(typed) : typed;
    else if (spec.default !== undefined) payload[key] = spec.default;
  }
  if (values.response && !specs.response) payload.response = values.response;
  return payload;
}

/** Inline clarifying question: same card as an approval, a real form so Enter submits. */
export function ElicitationCard({
  elicitation,
  runId,
  onResolveElicitation,
}: { elicitation: ActiveElicitation } & Pick<AgentActivityViewProps, 'runId' | 'onResolveElicitation'>) {
  const [values, setValues] = React.useState<Record<string, string>>({});
  const specs = (elicitation.schema?.properties as Record<string, FieldSpec> | undefined) ?? {};
  const required = new Set((elicitation.schema?.required as string[] | undefined) ?? []);
  const keys = Object.keys(specs);
  const link = elicitation.mode === 'url' ? safeLink(elicitation.url) : undefined;
  const set = (key: string, value: string) => setValues((previous) => ({ ...previous, [key]: value }));
  const answer = (action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>) => {
    if (runId) onResolveElicitation?.(runId, elicitation.id, action, content);
  };
  const host = link ? new URL(link).host : '';
  return (
    <form
      className={styles.card}
      data-testid={`elicitation-card-${elicitation.id}`}
      aria-label={elicitation.message || 'Additional details requested'}
      onSubmit={(event) => {
        event.preventDefault();
        answer('accept', link ? undefined : elicitationPayload(specs, values));
      }}
    >
      <div className={styles.copy}>
        {elicitation.connectorName ? <p className={styles.reason} data-muted="true">{elicitation.connectorName}</p> : null}
        <h3 className={styles.title}>{elicitation.message || 'Additional details requested'}</h3>
        {link ? <p className={styles.reason} data-muted="true">Opens {host || 'the link'}, then comes back here.</p> : null}
      </div>

      {link ? null : keys.length > 0 ? (
        <div className={styles.fields}>
          {keys.map((key) => {
            const spec = specs[key] ?? {};
            return (
              <label key={key} className={styles.field}>
                <span>{spec.title || humanizeToolName(key)}</span>
                {spec.description ? <span className={styles.fieldDetail}>{spec.description}</span> : null}
                <input
                  className={styles.input}
                  type={isNumeric(spec) ? 'number' : 'text'}
                  data-testid={`elicitation-input-${key}`}
                  required={required.has(key) && spec.default === undefined}
                  value={values[key] ?? (spec.default !== undefined ? String(spec.default) : '')}
                  onChange={(event) => set(key, event.target.value)}
                />
              </label>
            );
          })}
        </div>
      ) : (
        <input
          className={styles.input}
          type="text"
          aria-label="Your response"
          data-testid="elicitation-input-response"
          placeholder="Type your response…"
          value={values.response ?? ''}
          onChange={(event) => set('response', event.target.value)}
        />
      )}

      <div className={styles.actions}>
        {link ? (
          <a className={styles.button} data-tone="primary" data-testid="elicitation-open-url" href={link} target="_blank" rel="noreferrer">
            Open sign-in page
            <ExternalLink size={16} />
          </a>
        ) : null}
        <button type="submit" className={styles.button} data-tone={link ? 'secondary' : 'primary'} data-testid="elicitation-submit">
          {link ? 'Done' : 'Submit'}
        </button>
        <button type="button" className={styles.button} data-tone="secondary" data-testid="elicitation-decline" onClick={() => answer('decline')}>
          Decline
        </button>
        <span className={styles.spacer} />
        <button type="button" className={styles.button} data-tone="ghost" data-testid="elicitation-cancel" onClick={() => answer('cancel')}>
          Cancel
        </button>
      </div>
    </form>
  );
}
