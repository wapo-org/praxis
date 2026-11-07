import React from 'react';
import { safeLink } from '../../lib/links';

import styles from './Activity.module.css';
import type { AgentActivityViewProps } from './activityTypes';
export function ElicitationCards({
  pendingElicitations = [],
  runId,
  onResolveElicitation,
  elicitationValues,
  setElicitationValues,
}: Pick<AgentActivityViewProps, 'pendingElicitations' | 'runId' | 'onResolveElicitation'> & {
  elicitationValues: Record<string, Record<string, unknown>>;
  setElicitationValues: React.Dispatch<
    React.SetStateAction<Record<string, Record<string, unknown>>>
  >;
}) {
  return (
    <>
      {pendingElicitations.map((elicitation) => {
        const schemaProps =
          (elicitation.schema?.properties as Record<
            string,
            {
              type?: string;
              title?: string;
              description?: string;
              default?: unknown;
            }
          >) ?? {};
        const propKeys = Object.keys(schemaProps);
        const currentForm = elicitationValues[elicitation.id] ?? {};

        const setFieldValue = (key: string, val: unknown) => {
          setElicitationValues((prev) => ({
            ...prev,
            [elicitation.id]: { ...(prev[elicitation.id] ?? {}), [key]: val },
          }));
        };

        return (
          <div
            key={elicitation.id}
            data-testid={`elicitation-card-${elicitation.id}`}
            className={styles.card}
          >
            <div className={styles.cardTitle}>
              <span>{elicitation.message || 'Additional details requested'}</span>
            </div>

            {elicitation.mode === 'url' && safeLink(elicitation.url) ? (
              <a
                href={safeLink(elicitation.url)}
                target="_blank"
                rel="noreferrer"
                className={styles.cardLink}
              >
                Open external authorization ({elicitation.url}) ↗
              </a>
            ) : propKeys.length > 0 ? (
              <div className={styles.cardFields}>
                {propKeys.map((key) => {
                  const spec = schemaProps[key] ?? {};
                  const val =
                    currentForm[key] !== undefined
                      ? String(currentForm[key])
                      : spec.default !== undefined
                        ? String(spec.default)
                        : '';
                  return (
                    <label key={key} className={styles.cardField}>
                      <span className={styles.cardFieldName}>{spec.title || key}</span>
                      {spec.description ? (
                        <span className={styles.cardFieldHint}>{spec.description}</span>
                      ) : null}
                      <input
                        type={spec.type === 'number' || spec.type === 'integer' ? 'number' : 'text'}
                        data-testid={`elicitation-input-${key}`}
                        className={styles.cardInput}
                        value={val}
                        placeholder={`Enter ${spec.title || key}...`}
                        onChange={(e) =>
                          setFieldValue(
                            key,
                            spec.type === 'number' || spec.type === 'integer'
                              ? Number(e.target.value)
                              : e.target.value,
                          )
                        }
                      />
                    </label>
                  );
                })}
              </div>
            ) : (
              <input
                type="text"
                data-testid="elicitation-input-response"
                className={styles.cardInput}
                placeholder="Type your response..."
                value={String(currentForm.response ?? '')}
                onChange={(e) => setFieldValue('response', e.target.value)}
              />
            )}

            <div className={styles.cardActions}>
              <button
                type="button"
                data-testid="elicitation-submit"
                data-tone="primary"
                className={styles.cardButton}
                onClick={() => {
                  if (!runId) return;
                  const payload =
                    Object.keys(currentForm).length > 0
                      ? currentForm
                      : propKeys.reduce<Record<string, unknown>>((acc, k) => {
                          acc[k] = schemaProps[k]?.default ?? 'confirmed';
                          return acc;
                        }, {});
                  onResolveElicitation?.(runId, elicitation.id, 'accept', payload);
                }}
              >
                Submit
              </button>
              <button
                type="button"
                data-testid="elicitation-decline"
                data-tone="secondary"
                className={styles.cardButton}
                onClick={() => runId && onResolveElicitation?.(runId, elicitation.id, 'decline')}
              >
                Decline
              </button>
              <button
                type="button"
                data-testid="elicitation-cancel"
                data-tone="danger"
                className={styles.cardButton}
                onClick={() => runId && onResolveElicitation?.(runId, elicitation.id, 'cancel')}
              >
                Cancel
              </button>
            </div>
          </div>
        );
      })}
    </>
  );
}
