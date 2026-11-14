import React from 'react';
import { normalizeTitle } from '../../lib/chatTitle';
import styles from './TitleText.module.css';

export function TitleText({ title }: { title: string }) {
  const clean = normalizeTitle(title);
  const [previous, setPrevious] = React.useState(clean);
  React.useEffect(() => {
    if (previous === clean) return;
    const id = setTimeout(() => setPrevious(clean), 300);
    return () => clearTimeout(id);
  }, [clean, previous]);
  return (
    <span className={styles.stack}>
      <span key={clean} className={styles.current}>
        {clean}
      </span>
      {previous !== clean ? (
        <span aria-hidden="true" className={styles.previous}>
          {previous}
        </span>
      ) : null}
    </span>
  );
}
