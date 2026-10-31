import React from 'react';
import { safeLink } from '../../lib/links';

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
            [elicitation.id]: {
              ...(prev[elicitation.id] ?? {}),
              [key]: val,
            },
          }));
        };

        return (
          <div
            key={elicitation.id}
            data-testid={`elicitation-card-${elicitation.id}`}
            style={{
              width: '100%',
              borderRadius: 16,
              padding: 16,
              background: 'var(--paper-surface)',
              border: '1px solid var(--paper-accent)',
              boxShadow: '0 8px 24px rgba(47, 122, 77, 0.10)',
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <div
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: 'var(--paper-ink)',
              }}
            >
              {elicitation.message || 'Additional details requested'}
            </div>

            {elicitation.mode === 'url' && safeLink(elicitation.url) ? (
              <a
                href={safeLink(elicitation.url)}
                target="_blank"
                rel="noreferrer"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  color: 'var(--paper-accent)',
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                Open external authorization ({elicitation.url}) ↗
              </a>
            ) : propKeys.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {propKeys.map((key) => {
                  const spec = schemaProps[key] ?? {};
                  const val =
                    currentForm[key] !== undefined
                      ? String(currentForm[key])
                      : spec.default !== undefined
                        ? String(spec.default)
                        : '';
                  return (
                    <label
                      key={key}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4,
                        fontSize: 12.5,
                        color: 'var(--paper-ink-2)',
                      }}
                    >
                      <span style={{ fontWeight: 500, color: 'var(--paper-ink)' }}>
                        {spec.title || key}
                      </span>
                      {spec.description && (
                        <span
                          style={{
                            fontSize: 11.5,
                            color: 'var(--paper-ink-3)',
                          }}
                        >
                          {spec.description}
                        </span>
                      )}
                      <input
                        type={spec.type === 'number' || spec.type === 'integer' ? 'number' : 'text'}
                        data-testid={`elicitation-input-${key}`}
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
                        style={{
                          padding: '8px 11px',
                          borderRadius: 10,
                          border: '0.5px solid var(--paper-hairline)',
                          background: 'var(--paper-canvas)',
                          color: 'var(--paper-ink)',
                          fontSize: 13.5,
                        }}
                      />
                    </label>
                  );
                })}
              </div>
            ) : (
              <input
                type="text"
                data-testid="elicitation-input-response"
                placeholder="Type your response..."
                value={String(currentForm.response ?? '')}
                onChange={(e) => setFieldValue('response', e.target.value)}
                style={{
                  padding: '8px 11px',
                  borderRadius: 10,
                  border: '0.5px solid var(--paper-hairline)',
                  background: 'var(--paper-canvas)',
                  color: 'var(--paper-ink)',
                  fontSize: 13.5,
                }}
              />
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                data-testid="elicitation-submit"
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
                style={{
                  padding: '7px 14px',
                  borderRadius: 10,
                  border: 'none',
                  background: 'var(--paper-accent)',
                  color: 'var(--paper-canvas)',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Submit
              </button>
              <button
                type="button"
                data-testid="elicitation-decline"
                onClick={() => runId && onResolveElicitation?.(runId, elicitation.id, 'decline')}
                style={{
                  padding: '7px 14px',
                  borderRadius: 10,
                  border: '0.5px solid var(--paper-hairline)',
                  background: 'var(--paper-fill-1)',
                  color: 'var(--paper-ink)',
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                Decline
              </button>
              <button
                type="button"
                data-testid="elicitation-cancel"
                onClick={() => runId && onResolveElicitation?.(runId, elicitation.id, 'cancel')}
                style={{
                  padding: '7px 14px',
                  borderRadius: 10,
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--paper-ink-3)',
                  fontSize: 13,
                  cursor: 'pointer',
                }}
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
