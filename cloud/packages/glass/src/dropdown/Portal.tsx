import React from 'react';
import { createPortal } from 'react-dom';
export function DropdownPortal({
  enabled,
  children,
}: {
  enabled: boolean;
  children: React.ReactNode;
}) {
  return enabled && typeof document !== 'undefined' ? (
    createPortal(children, document.body)
  ) : (
    <>{children}</>
  );
}
