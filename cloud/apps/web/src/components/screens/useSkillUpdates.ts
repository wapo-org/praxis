import React from 'react';
import { apiClient } from '../../lib/api';
import type { SkillUpdate } from '../../lib/api-x1';
import { usePraxisStore } from '../../state/store';
export function useSkillUpdates() {
  const store = usePraxisStore();
  const [items, setItems] = React.useState<SkillUpdate[]>([]),
    [busy, setBusy] = React.useState(false),
    [error, setError] = React.useState<string | null>(null),
    [checked, setChecked] = React.useState(false);
  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      const page = await apiClient.listSkillUpdates();
      setItems(page.items);
      setChecked(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check for updates');
    } finally {
      setBusy(false);
    }
  };
  React.useEffect(() => {
    void check();
  }, []);
  const apply = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await apiClient.updateRegistrySkill(id);
      await store.refreshAll();
      setItems((old) => old.filter((item) => item.skillId !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update skill');
    } finally {
      setBusy(false);
    }
  };
  return { items, busy, error, checked, check, apply };
}
