import React from 'react';
import type { SubContextValue } from './context';
import {
  DepthContext,
  SUB_CONTENT_MARKER,
  SUB_MARKER,
  SubContext,
  useGlassDropdownContext,
} from './context';
import { getSubIdentifier } from './morph';
export interface SubProps {
  id?: string;
  label?: React.ReactNode;
  icon?: React.ReactNode;
  subtitle?: React.ReactNode;
  children?: React.ReactNode;
}

function Sub(props: SubProps) {
  const { label, icon, subtitle, children } = props;
  const ctx = useGlassDropdownContext('Sub');
  const depth = React.useContext(DepthContext);
  const subId = getSubIdentifier(props);
  const isOpen = ctx.activeSubPath[depth] === subId;
  const [openSide, setOpenSide] = React.useState<'left' | 'right'>('right');
  const triggerElRef = React.useRef<HTMLButtonElement | null>(null);

  const registerSubTriggerEl = React.useCallback(
    (el: HTMLButtonElement | null) => {
      triggerElRef.current = el;
    },
    [],
  );
  const getSubTriggerEl = React.useCallback(() => triggerElRef.current, []);

  const subCtx = React.useMemo<SubContextValue>(
    () => ({
      subId,
      depth,
      isOpen,
      openSide,
      setOpenSide,
      registerSubTriggerEl,
      getSubTriggerEl,
      label,
      icon,
      subtitle,
    }),
    [
      subId,
      depth,
      isOpen,
      openSide,
      registerSubTriggerEl,
      getSubTriggerEl,
      label,
      icon,
      subtitle,
    ],
  );

  const triggerNodes: React.ReactNode[] = [];
  const contentNodes: React.ReactNode[] = [];

  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;
    const childType = child.type as { [SUB_CONTENT_MARKER]?: boolean };
    if (childType?.[SUB_CONTENT_MARKER]) {
      contentNodes.push(child);
    } else {
      triggerNodes.push(child);
    }
  });

  return (
    <SubContext.Provider value={subCtx}>
      <div
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
        }}
      >
        {triggerNodes}
        {ctx.submenuMode === 'cascade' ? contentNodes : null}
      </div>
    </SubContext.Provider>
  );
}
(Sub as unknown as { [SUB_MARKER]: boolean })[SUB_MARKER] = true;

export { Sub };
