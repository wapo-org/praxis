import {apiClient} from '../../lib/api';
// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentActivityViewProps } from './activityTypes';
import { ElicitationCards } from './ElicitationCards';

type Elicitation = NonNullable<AgentActivityViewProps['pendingElicitations']>[number];
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const many: Elicitation = {
  id: 'e2',
  message: 'A few details',
  schema: {
    type: 'object',
    required: ['service', 'replicas'],
    properties: {
      service: { type: 'string', title: 'Service name' },
      replicas: { type: 'integer', title: 'Replicas', minimum: 1 },
      region: { type: 'string', title: 'Region', enum: ['eu-west', 'us-east'] },
      canary: { type: 'boolean', title: 'Canary first' },
    },
  },
} as Elicitation;

type Resolve = (runId: string, id: string, action: string, content?: Record<string, unknown>) => Promise<void>;
function mount(elicitation: Elicitation, resolve = vi.fn<Resolve>(async () => {})) {
  function Harness() {
    const [values, setValues] = React.useState<Record<string, Record<string, unknown>>>({});
    const [pending, setPending] = React.useState([elicitation]);
    return (
      <ElicitationCards
        pendingElicitations={pending}
        runId="r"
        elicitationValues={values}
        setElicitationValues={setValues}
        onResolveElicitation={async (...args) => {
          await resolve(...args);
          setPending([]);
        }}
      />
    );
  }
  act(() => root.render(<Harness />));
  return resolve;
}
const $ = <T extends Element = HTMLElement>(selector: string) => host.querySelector<T>(selector);
const type = (input: HTMLInputElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
const click = async (el: Element | null) => act(async () => (el as HTMLElement).click());

describe('the elicitation card (WP-I1)', () => {
  it('renders each field kind in our controls: pill inputs, enum chips, a switch', () => {
    mount(many);
    expect($('[data-field-kind="text"] input')).not.toBeNull();
    expect($<HTMLInputElement>('[data-testid="elicitation-input-replicas"]')!.type).toBe('number');
    expect([...host.querySelectorAll('[role="radio"]')].map((n) => n.textContent)).toEqual(['eu-west', 'us-east']);
    expect($('[role="switch"]')).not.toBeNull();
    // Cancel is not destructive: no danger tone.
    expect($('[data-testid="elicitation-cancel"]')!.getAttribute('data-tone')).toBe('quiet');
  });

  it('validates on Submit, shows the errors, and sends nothing until they are fixed', async () => {
    const resolve = mount(many);
    await click($('[data-testid="elicitation-submit"]'));
    expect(resolve).not.toHaveBeenCalled();
    expect($('[data-testid="elicitation-error-service"]')!.textContent).toBe('Required.');
    expect($('[data-testid="elicitation-error-replicas"]')!.textContent).toBe('Required.');
    type($<HTMLInputElement>('[data-testid="elicitation-input-replicas"]')!, '0');
    expect($('[data-testid="elicitation-error-replicas"]')!.textContent).toBe('At least 1.');
    type($<HTMLInputElement>('[data-testid="elicitation-input-replicas"]')!, '2.5');
    expect($('[data-testid="elicitation-error-replicas"]')!.textContent).toBe('Enter a whole number.');
    type($<HTMLInputElement>('[data-testid="elicitation-input-replicas"]')!, '3');
    type($<HTMLInputElement>('[data-testid="elicitation-input-service"]')!, 'checkout');
    await click(host.querySelector('[role="radio"]'));
    await click($('[role="switch"]'));
    await click($('[data-testid="elicitation-submit"]'));
    expect(resolve).toHaveBeenCalledWith('r', 'e2', 'accept', { service: 'checkout', replicas: 3, region: 'eu-west', canary: true });
    // Settled: one quiet line with what was sent.
    const settled = $('[data-testid="elicitation-settled-e2"]')!;
    expect(settled.getAttribute('data-action')).toBe('accept');
    expect(settled.textContent).toContain('Submitted');
    expect(settled.textContent).toContain('Service name: checkout');
  });

  it('declines and cancels without validating, and says so', async () => {
    for (const [action, word] of [['decline', 'Declined'], ['cancel', 'Cancelled']] as const) {
      const resolve = mount(many);
      await click($(`[data-testid="elicitation-${action}"]`));
      expect(resolve).toHaveBeenCalledWith('r', 'e2', action, undefined);
      expect($('[data-testid="elicitation-settled-e2"]')!.textContent).toContain(word);
      act(() => root.unmount());
      root = createRoot(host);
    }
  });

  it('shows no card for a URL-mode elicitation: app sign-in is the App Directory connect card', () => {
    mount({ id: 'u', message: 'Sign in', mode: 'url', url: 'https://github.com/login', schema: {} } as Elicitation);
    expect($('[data-testid="elicitation-card-u"]')).toBeNull();
    expect(host.querySelector('a')).toBeNull();
  });

  it('keeps the card and says so when sending fails', async () => {
    mount(many, vi.fn<Resolve>(async () => { throw Error('offline'); }));
    await click($('[data-testid="elicitation-decline"]'));
    expect($('[data-testid="elicitation-card-e2"]')).not.toBeNull();
    expect($('[role="alert"]')!.textContent).toContain('Could not send');
  });
});

it('never submits a credential to a server without saved-values support',async()=>{
 vi.spyOn(apiClient,'savedValues').mockRejectedValue(new Error('Endpoint unavailable'));
 const resolve=mount({id:'sensitive',message:'Credentials',schema:{type:'object',properties:{token:{type:'string',format:'password'}},required:['token']}} as Elicitation);
 await act(async()=>{await Promise.resolve();});
 expect($<HTMLInputElement>('[data-testid="elicitation-input-token"]')!.disabled).toBe(true);
 expect($<HTMLButtonElement>('[data-testid="elicitation-submit"]')!.disabled).toBe(true);
 await click($('[data-testid="elicitation-submit"]'));
 expect(resolve).not.toHaveBeenCalled();
 expect(host.textContent).toContain('Secure input is unavailable');
});
