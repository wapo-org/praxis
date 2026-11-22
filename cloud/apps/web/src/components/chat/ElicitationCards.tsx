import {apiClient} from '../../lib/api';
import React from 'react';
import { Check, X } from '../../lib/icons';
import { safeLink } from '../../lib/links';
import { Switch } from '../ui/controls';
import type { AgentActivityViewProps } from './activityTypes';
import styles from './ElicitationCards.module.css';

type Elicitation = NonNullable<AgentActivityViewProps['pendingElicitations']>[number];
type Action = 'accept' | 'decline' | 'cancel';
type FieldSpec = {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  enumNames?: string[];
  oneOf?: { const?: unknown; title?: string }[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  format?: string;
  'x-sensitive'?: boolean;
};
type Field = { key: string; spec: FieldSpec; label: string; kind: 'text' | 'number' | 'integer' | 'boolean' | 'enum'; required: boolean; choices: { value: string; label: string }[] };
/** What the card shows once answered: the server drops the request, the card keeps one quiet line. */
type Settled = { action: Action; elicitation: Elicitation; summary: string };

const humanise = (key: string) =>
  key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());

function fieldsOf(elicitation: Elicitation): Field[] {
  const schema = (elicitation.schema ?? {}) as { properties?: Record<string, FieldSpec>; required?: unknown };
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  return Object.entries(schema.properties ?? {}).map(([key, raw]) => {
    const spec = raw ?? {};
    const choices = Array.isArray(spec.enum)
      ? spec.enum.map((value, i) => ({ value: String(value), label: spec.enumNames?.[i] ?? String(value) }))
      : Array.isArray(spec.oneOf) && spec.oneOf.every((o) => o && 'const' in o)
        ? spec.oneOf.map((o) => ({ value: String(o.const), label: o.title ?? String(o.const) }))
        : [];
    const kind: Field['kind'] = spec.format==='password'||spec['x-sensitive'] ? 'text' : choices.length
      ? 'enum'
      : spec.type === 'boolean'
        ? 'boolean'
        : spec.type === 'number' || spec.type === 'integer'
          ? spec.type
          : 'text';
    return { key, spec, kind, choices, required: required.has(key), label: spec.title?.trim() || spec.description?.trim() || humanise(key) };
  });
}

function initialValue(field: Field): unknown {
  if (field.spec.default !== undefined) return field.spec.default;
  return field.kind === 'boolean' ? false : undefined;
}

/** MCP's primitive schema checks, phrased for people. Returns the message for the first problem only. */
function problemWith(field: Field, value: unknown): string | null {
  const empty = value === undefined || value === null || value === '';
  if (empty) return field.required ? 'Required.' : null;
  if (field.kind === 'number' || field.kind === 'integer') {
    const n = Number(value);
    if (!Number.isFinite(n)) return 'Enter a number.';
    if (field.kind === 'integer' && !Number.isInteger(n)) return 'Enter a whole number.';
    if (field.spec.minimum !== undefined && n < field.spec.minimum) return `At least ${field.spec.minimum}.`;
    if (field.spec.maximum !== undefined && n > field.spec.maximum) return `At most ${field.spec.maximum}.`;
  }
  if (field.kind === 'text') {
    const text = String(value);
    if (field.spec.minLength !== undefined && text.length < field.spec.minLength) return `At least ${field.spec.minLength} characters.`;
    if (field.spec.maxLength !== undefined && text.length > field.spec.maxLength) return `At most ${field.spec.maxLength} characters.`;
    if (field.spec.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return 'Enter an email address.';
    if (field.spec.format === 'uri' && !safeLink(text)) return 'Enter a link.';
  }
  return null;
}

function summarise(fields: Field[], content: Record<string, unknown>) {
  return fields
    .filter((f) => content[f.key] !== undefined && content[f.key] !== '')
    .map((f) => {
      const v = content[f.key];
      if(f.spec.format==='password'||f.spec['x-sensitive'])return f.label+': Provided securely';
      const shown = f.kind === 'boolean' ? (v ? 'Yes' : 'No') : f.kind === 'enum' ? (f.choices.find((c) => c.value === String(v))?.label ?? String(v)) : String(v);
      return fields.length === 1 ? shown : `${f.label}: ${shown}`;
    })
    .join(' · ');
}

export function ElicitationCards({
  pendingElicitations = [],
  runId,
  onResolveElicitation,
  elicitationValues,
  setElicitationValues,
}: Pick<AgentActivityViewProps, 'pendingElicitations' | 'runId' | 'onResolveElicitation'> & {
  elicitationValues: Record<string, Record<string, unknown>>;
  setElicitationValues: React.Dispatch<React.SetStateAction<Record<string, Record<string, unknown>>>>;
}) {
  const [settled, setSettled] = React.useState<Record<string, Settled>>({});
  // App sign-in is the App Directory's connect card now (PRA-49); URL elicitations from MCP servers are not shown.
  const forms = pendingElicitations;
  const pendingIds = new Set(forms.map((e) => e.id));
  const answered = Object.entries(settled).filter(([id]) => !pendingIds.has(id));
  return (
    <>
      {forms.map((elicitation) => (
        <ElicitationCard
          key={elicitation.id}
          elicitation={elicitation}
          runId={runId}
          values={elicitationValues[elicitation.id] ?? {}}
          setValue={(key, value) =>
            setElicitationValues((prev) => ({ ...prev, [elicitation.id]: { ...prev[elicitation.id], [key]: value } }))
          }
          onResolve={onResolveElicitation}
          onSettled={(entry) => setSettled((prev) => {const next={...prev};if(entry)next[elicitation.id]=entry;else delete next[elicitation.id];return next;})}
          settled={settled[elicitation.id]}
        />
      ))}
      {answered.map(([id, entry]) => (
        <SettledLine key={id} entry={entry} />
      ))}
    </>
  );
}

const ACTION_COPY: Record<Action, string> = { accept: 'Submitted', decline: 'Declined', cancel: 'Cancelled' };

function SettledLine({ entry }: { entry: Settled }) {
  return (
    <p className={styles.settled} data-testid={`elicitation-settled-${entry.elicitation.id}`} data-action={entry.action} role="status">
      <span className={styles.settledIcon} aria-hidden="true">
        {entry.action === 'accept' ? <Check size={16} /> : <X size={16} />}
      </span>
      <span className={styles.settledText}>
        <span className={styles.settledVerb}>{ACTION_COPY[entry.action]}</span>
        {entry.summary ? <span className={styles.settledSummary}>{entry.summary}</span> : null}
      </span>
    </p>
  );
}

function ElicitationCard({
  elicitation,
  runId,
  values,
  setValue,
  onResolve,
  onSettled,
  settled,
}: {
  elicitation: Elicitation;
  runId?: string;
  values: Record<string, unknown>;
  setValue: (key: string, value: unknown) => void;
  onResolve: AgentActivityViewProps['onResolveElicitation'];
  onSettled: (entry: Settled | null) => void;
  settled?: Settled;
}) {
  const fields = fieldsOf(elicitation);
  const urlMode = elicitation.mode === 'url';
  const free = fields.length === 0;
  const [shown, setShown] = React.useState(false); // errors appear after the first submit, then follow the input
  const [busy, setBusy] = React.useState<Action | null>(null);
  const [failed, setFailed] = React.useState('');
  const [savedSecrets,setSavedSecrets]=React.useState<{id:string;name:string;kind:'secret'|'variable';value?:unknown}[]>([]);
  const [savedStatus,setSavedStatus]=React.useState<'loading'|'ready'|'unavailable'>('loading');
  const hasSensitive=fields.some(f=>f.spec.format==='password'||f.spec['x-sensitive']);
  const loadSaved=React.useCallback(async()=>{
    setSavedStatus('loading');
    try{const result=await apiClient.savedValues();setSavedSecrets(result.items);setSavedStatus('ready');}
    catch{setSavedStatus('unavailable');}
  },[elicitation.id]);
  React.useEffect(()=>{void loadSaved();},[loadSaved]);
  const [revealed,setRevealed]=React.useState<Record<string,boolean>>({});
  const idBase = `elicit-${React.useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const valueOf = (field: Field) => (values[field.key] !== undefined ? values[field.key] : initialValue(field));
  const problems = Object.fromEntries(fields.map((f) => [f.key, problemWith(f, valueOf(f))]));
  const invalid = fields.some((f) => problems[f.key]);
  const done = settled ?? null;

  const resolve = async (action: Action, saveAll=false) => {
    if (!runId || busy || done) return;
    if(action==='accept'&&(hasSensitive||saveAll)&&savedStatus!=='ready'){
      setFailed(hasSensitive?'Secure input is unavailable. Retry loading saved values.':'Saving is unavailable. Retry loading saved values.');
      return;
    }
    let content: Record<string, unknown> | undefined;
    if (action === 'accept') {
      setShown(true);
      if (invalid) {
        const first = fields.find((f) => problems[f.key]);
        if (first) document.getElementById(`${idBase}-${first.key}`)?.focus();
        return;
      }
      if (free) content = { response: String(values.response ?? '').trim() || 'confirmed' };
      else
        content = Object.fromEntries(
          fields
            .map((f) => {
              const v = valueOf(f);
              if (v === undefined || v === '') return [f.key, undefined];
              return [f.key, f.kind === 'number' || f.kind === 'integer' ? Number(v) : v];
            })
            .filter(([, v]) => v !== undefined),
        );
    }
    setBusy(action);
    setFailed('');
    try {
      if(content){for(const f of fields)if(saveAll||f.spec.format==='password'||f.spec['x-sensitive'])content['__save_'+f.key]=saveAll||values['__save_'+f.key]===true;if(saveAll&&free)content.__save_response=true;}
      onSettled({ action, elicitation, summary: action === 'accept' && content ? (free ? String(content.response ?? '') : summarise(fields, content)) : '' });
      await onResolve?.(runId, elicitation.id, action, content);
      for(const f of fields)if(f.spec.format==='password'||f.spec['x-sensitive'])setValue(f.key,'');
    } catch {
      onSettled(null);
      setFailed('Could not send your answer. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const submitOnEnter = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void resolve('accept');
    }
  };

  if(done)return <SettledLine entry={done}/>;

  return (
    <section
      data-testid={`elicitation-card-${elicitation.id}`}
      data-state={busy ? 'sending' : 'open'}
      className={styles.card}
      aria-labelledby={`${idBase}-message`}
      aria-busy={busy ? true : undefined}
    >
      <p id={`${idBase}-message`} className={styles.message}>
        {elicitation.message || 'Additional details requested'}
      </p>
      {elicitation.connectorName ? <p className={styles.source}>Asked by {elicitation.connectorName}</p> : null}

      <div className={styles.body} data-testid="elicitation-form-surface">
      {savedStatus==='unavailable'?<div className={styles.hint}>
        <p>{hasSensitive?'Secure input is unavailable on this server. Update the server or retry.':'To save answers, update the server or retry loading saved values.'}</p>
        <button type="button" className={styles.secondary} onClick={()=>void loadSaved()}>Retry saved values</button>
      </div>:null}
      {urlMode ? <p className={styles.message}>This request needs an external sign-in response.</p> : free ? (
        <div className={styles.field}>
          <input
            id={`${idBase}-response`}
            type="text"
            data-testid="elicitation-input-response"
            aria-label="Your response"
            className={styles.input}
            placeholder="Type your response"
            value={String(values.response ?? '')}
            disabled={!!busy}
            onChange={(e) => setValue('response', e.target.value)}
            onKeyDown={submitOnEnter}
          />
        </div>
      ) : (
        <div className={styles.fields}>
          {fields.map((field) => {
            const id = `${idBase}-${field.key}`;
            const problem = shown ? problems[field.key] : null;
            const hint = field.spec.title && field.spec.description ? field.spec.description : '';
            const described = [hint ? `${id}-hint` : '', problem ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
            const value = valueOf(field);
            return (
              <div key={field.key} className={styles.field} data-field-kind={field.kind} data-invalid={problem ? true : undefined}>
                {field.kind === 'boolean' ? (
                  <label className={styles.toggleRow}>
                    <span className={styles.toggleCopy}>
                      <span className={styles.label}>{field.label}</span>
                      {hint ? (
                        <span id={`${id}-hint`} className={styles.fieldHint}>
                          {hint}
                        </span>
                      ) : null}
                    </span>
                    <span data-testid={`elicitation-input-${field.key}`}>
                      <Switch label={field.label} checked={!!value} disabled={!!busy} onChange={(next) => setValue(field.key, next)} />
                    </span>
                  </label>
                ) : (
                  <>
                    <label htmlFor={field.kind === 'enum' ? undefined : id} id={`${id}-label`} className={styles.label}>
                      {field.label}
                    </label>
                    {hint ? (
                      <span id={`${id}-hint`} className={styles.fieldHint}>
                        {hint}
                      </span>
                    ) : null}
                    {field.kind === 'enum' ? (
                      <div
                        id={id}
                        role="radiogroup"
                        aria-labelledby={`${id}-label`}
                        aria-describedby={described}
                        aria-required={field.required || undefined}
                        aria-invalid={problem ? true : undefined}
                        className={styles.choices}
                        data-testid={`elicitation-input-${field.key}`}
                        tabIndex={-1}
                      >
                        {field.choices.map((choice) => (
                          <button
                            key={choice.value}
                            type="button"
                            role="radio"
                            aria-checked={String(value) === choice.value}
                            className={styles.choice}
                            disabled={!!busy}
                            onClick={() => setValue(field.key, field.spec.enum ? (field.spec.enum.find((v) => String(v) === choice.value) ?? choice.value) : choice.value)}
                          >
                            {choice.label}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <input
                        id={id}
                        type={(field.spec.format==='password'||field.spec['x-sensitive'])&&!revealed[field.key]?'password':field.kind === 'text' ? (field.spec.format === 'email' ? 'email' : 'text') : 'number'}
                        autoComplete={field.spec.format==='password'||field.spec['x-sensitive']?'off':undefined}
                        inputMode={field.kind === 'integer' ? 'numeric' : field.kind === 'number' ? 'decimal' : undefined}
                        step={field.kind === 'integer' ? 1 : field.kind === 'number' ? 'any' : undefined}
                        data-testid={`elicitation-input-${field.key}`}
                        className={styles.input}
                        value={value === undefined || value === null ? '' : String(value)}
                        placeholder={field.kind === 'text' ? field.label : undefined}
                        aria-required={field.required || undefined}
                        aria-invalid={problem ? true : undefined}
                        aria-describedby={described}
                        disabled={!!busy||((field.spec.format==='password'||field.spec['x-sensitive'])&&savedStatus!=='ready')}
                        onChange={(e) => setValue(field.key, e.target.value)}
                        onKeyDown={submitOnEnter}
                      />
                    )}
                    {field.spec.format==='password'||field.spec['x-sensitive'] ? <>
                      <button type="button" className={styles.quiet} aria-pressed={!!revealed[field.key]} onClick={()=>setRevealed(p=>({...p,[field.key]:!p[field.key]}))}>{revealed[field.key]?'Hide':'Reveal'} {field.label}</button>
                      {savedSecrets.filter(secret=>secret.kind==='secret'&&secret.name===field.key).map(secret=><button key={secret.id} type="button" className={styles.secondary} onClick={()=>setValue(field.key,'{{secret:'+secret.id+'}}')}>Use saved {secret.name}</button>)}
                      <label className={styles.label}><input type="checkbox"  checked={values['__save_'+field.key]===true} onChange={e=>setValue('__save_'+field.key,e.target.checked)}/> Save to account</label>
                    </> : null}
                    {!(field.spec.format==='password'||field.spec['x-sensitive'])?savedSecrets.filter(item=>item.kind==='variable'&&item.name===field.key).map(item=><button key={item.id} type="button" className={styles.secondary} onClick={()=>setValue(field.key,item.value)}>Use saved {item.name}</button>):null}
                  </>
                )}
                {problem ? (
                  <span id={`${id}-error`} className={styles.fieldError} data-testid={`elicitation-error-${field.key}`}>
                    {problem}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {failed ? (
        <p className={styles.error} role="alert">
          {failed}
        </p>
      ) : null}

      <div className={styles.actions}>
        <button
          type="button"
          data-testid="elicitation-submit"
          data-tone="primary"
          className={styles.primary}
          disabled={!!busy || (hasSensitive && savedStatus !== 'ready')}
          onClick={() => void resolve('accept')}
        >
          {busy === 'accept' ? 'Sending…' : 'Submit'}
        </button>
        <button
          type="button"
          className={styles.secondary}
          data-testid="elicitation-submit-save"
          disabled={!!busy || savedStatus !== 'ready'}
          onClick={() => void resolve('accept', true)}
        >
          Submit and save
        </button>
        <button
          type="button"
          data-testid="elicitation-decline"
          data-tone="secondary"
          className={styles.secondary}
          disabled={!!busy}
          onClick={() => void resolve('decline')}
        >
          Decline
        </button>
        <button
          type="button"
          data-testid="elicitation-cancel"
          data-tone="quiet"
          className={styles.quiet}
          disabled={!!busy}
          onClick={() => void resolve('cancel')}
        >
          Cancel
        </button>
      </div>
      </div>
    </section>
  );
}
