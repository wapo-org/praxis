import React from 'react';
import { createPortal } from 'react-dom';
export function DropdownPortal({
  enabled,
  container,
  children,
}: {
  enabled: boolean;
  container?: Element | null;
  children: React.ReactNode;
}) {
  return enabled && typeof document !== 'undefined' ? (
    createPortal(children, container ?? document.body)
  ) : (
    <>{children}</>
  );
}
