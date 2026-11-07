import { App } from './App';
import { PraxisStoreProvider } from './state/store';
import type { NavigateFunction } from 'react-router-dom';
export default function AuthenticatedApp({ onNavigate }: { onNavigate: NavigateFunction }) {
  return (
    <PraxisStoreProvider onNavigate={onNavigate}>
      <App />
    </PraxisStoreProvider>
  );
}
