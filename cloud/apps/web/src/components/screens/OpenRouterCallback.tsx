import React from 'react';
import type { ModelKey } from '@praxis/protocol';
import { takeVerifier } from '../../lib/openrouter-pkce';
import { usePraxisStore } from '../../state/store.js';
import styles from './Screen.module.css';
import { ScreenBody, ScreenButton } from './ScreenUI.js';

type Connect = (input: { method: 'pkce'; code: string; codeVerifier: string }) => Promise<ModelKey>;

/**
 * One exchange per code, whoever asks. React may mount this page twice (StrictMode); the verifier is single
 * use, so the second mount must join the first exchange instead of finding the verifier gone.
 */
const exchanges = new Map<string, Promise<ModelKey>>();
function exchangeOnce(code: string, connect: Connect): Promise<ModelKey> {
  let exchange = exchanges.get(code);
  if (!exchange) {
    const codeVerifier = takeVerifier();
    exchange = codeVerifier
      ? connect({ method: 'pkce', code, codeVerifier })
      : Promise.reject(
          new Error(
            'This sign-in link was already used, or it was opened in a different tab than the one that started it. Start again from Settings.',
          ),
        );
    exchanges.set(code, exchange);
  }
  return exchange;
}

/** `/settings/openrouter/callback?code=…`: finishes the PKCE sign-in, then returns to Settings → Models. */
export function OpenRouterCallback({ search = window.location.search }: { search?: string }) {
  const store = usePraxisStore();
  const [error, setError] = React.useState<string | null>(null);
  const connect = React.useRef(store.connectModelKey);
  connect.current = store.connectModelKey;
  const finish = React.useRef(store.setActiveSheet);
  finish.current = store.setActiveSheet;

  React.useEffect(() => {
    let current = true;
    const code = new URLSearchParams(search).get('code');
    if (!code) {
      // No code means nothing can be completed; drop any verifier so it can't be paired with a later code.
      takeVerifier();
      setError('OpenRouter did not return a sign-in code. Start again from Settings.');
      return;
    }
    exchangeOnce(code, (input) => connect.current(input)).then(
      () => {
        if (current) finish.current('models');
      },
      (cause) => {
        if (current) setError(cause instanceof Error ? cause.message : 'OpenRouter sign-in failed.');
      },
    );
    return () => {
      current = false;
    };
  }, [search]);

  return (
    <ScreenBody>
      {error ? (
        <>
          <p className={styles.error} role="alert">
            {error}
          </p>
          <ScreenButton tone="primary" onClick={() => store.setActiveSheet('models')}>
            Back to Models
          </ScreenButton>
        </>
      ) : (
        <p className={styles.empty} role="status">
          Connecting OpenRouter…
        </p>
      )}
    </ScreenBody>
  );
}
