import React from 'react';
import type { SubLevelInfo } from './context';
import { SUB_CONTENT_MARKER, SUB_MARKER, SUB_TRIGGER_MARKER } from './context';
import type { SubProps } from './Sub';
import type { SubContentProps } from './SubContent';
import type { SubTriggerProps } from './SubTrigger';
export function getSubIdentifier(props: SubProps): string {
  if (props.id) return props.id;
  if (typeof props.label === 'string' && props.label) return props.label;
  let text = '';
  React.Children.forEach(props.children, (child) => {
    if (!React.isValidElement(child)) return;
    const childType = child.type as { [SUB_TRIGGER_MARKER]?: boolean };
    if (childType?.[SUB_TRIGGER_MARKER]) {
      const triggerProps = child.props as SubTriggerProps;
      if (typeof triggerProps.children === 'string') {
        text = triggerProps.children;
      }
    }
  });
  return text || 'submenu';
}

export function extractSubMeta(subElement: React.ReactElement<SubProps>): {
  label: React.ReactNode;
  icon?: React.ReactNode;
  subtitle?: React.ReactNode;
  contentChildren: React.ReactNode;
} {
  let label: React.ReactNode = subElement.props.label;
  let icon: React.ReactNode = subElement.props.icon;
  let subtitle: React.ReactNode = subElement.props.subtitle;
  let contentChildren: React.ReactNode = null;

  React.Children.forEach(subElement.props.children, (child) => {
    if (!React.isValidElement(child)) return;
    const childType = child.type as {
      [SUB_TRIGGER_MARKER]?: boolean;
      [SUB_CONTENT_MARKER]?: boolean;
    };
    if (childType?.[SUB_TRIGGER_MARKER]) {
      const triggerProps = child.props as SubTriggerProps;
      if (label === undefined) label = triggerProps.children;
      if (icon === undefined) icon = triggerProps.icon;
      if (subtitle === undefined) subtitle = triggerProps.subtitle;
    } else if (childType?.[SUB_CONTENT_MARKER]) {
      const contentProps = child.props as SubContentProps;
      contentChildren = contentProps.children;
    }
  });

  return {
    label: label ?? subElement.props.id ?? 'Submenu',
    icon,
    subtitle,
    contentChildren,
  };
}

export function findSubInChildren(
  nodes: React.ReactNode,
  targetId: string,
): React.ReactElement<SubProps> | null {
  let found: React.ReactElement<SubProps> | null = null;
  const walk = (children: React.ReactNode) => {
    React.Children.forEach(children, (child) => {
      if (found || !React.isValidElement(child)) return;
      const childType = child.type as { [SUB_MARKER]?: boolean };
      if (childType?.[SUB_MARKER]) {
        const subEl = child as React.ReactElement<SubProps>;
        if (getSubIdentifier(subEl.props) === targetId) {
          found = subEl;
          return;
        }
      }
      const childProps = child.props as { children?: React.ReactNode };
      if (childProps?.children && !childType?.[SUB_MARKER]) {
        walk(childProps.children);
      }
    });
  };
  walk(nodes);
  return found;
}

export function resolveMorphTrail(
  rootChildren: React.ReactNode,
  activeSubPath: string[],
): {
  trail: SubLevelInfo[];
  activeChildren: React.ReactNode;
} {
  const trail: SubLevelInfo[] = [];
  let currentChildren: React.ReactNode = rootChildren;

  for (let depth = 0; depth < activeSubPath.length; depth++) {
    const targetId = activeSubPath[depth];
    if (!targetId) break;
    const subEl = findSubInChildren(currentChildren, targetId);
    if (!subEl) break;
    const meta = extractSubMeta(subEl);
    trail.push({
      id: targetId,
      label: meta.label,
      icon: meta.icon,
      subtitle: meta.subtitle,
      children: meta.contentChildren,
    });
    currentChildren = meta.contentChildren;
  }

  return { trail, activeChildren: currentChildren };
}
