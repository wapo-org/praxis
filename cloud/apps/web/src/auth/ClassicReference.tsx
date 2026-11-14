// Development capture fixture: both sides use the actual Radix classic component.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Theme } from '@radix-ui/themes';
import styles from '../components/screens/AccountGate.module.css';
export function mountReference() {
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  createRoot(host).render(<Theme radius="full" accentColor="gray"><div style={{ display: 'flex', gap: 64, padding: 80, alignItems: 'center' }}><section className={styles.screen} style={{ minHeight: 0, padding: 24 }}><h2>Praxis</h2><Button variant="classic" radius="full">Sign in</Button></section><section><h2>Radix Themes reference</h2><Button variant="classic" radius="full" style={{ minHeight: 42 }}>Sign in</Button></section></div></Theme>);
}
