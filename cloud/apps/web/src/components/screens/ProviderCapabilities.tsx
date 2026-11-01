import React from 'react';
import type { Capabilities } from '@praxis/protocol';
import { Card, Section, Toggle } from './ScreenUI';
const rows: [Exclude<keyof Capabilities, 'type'>, string][] = [
  ['tools', 'Tool calling'], ['parallelToolCalls', 'Parallel tool calls'], ['vision', 'Images (vision)'],
  ['documents', 'PDF documents'], ['imagesInToolResults', 'Images in tool results'], ['reasoningEffort', 'Reasoning effort'],
  ['streamUsage', 'Streams token usage'], ['explicitPromptCaching', 'Prompt caching (explicit)'], ['serverWebSearch', 'Hosted web search'],
  ['midConversationSystem', 'Mid-chat system messages'], ['serverCompaction', 'Server compaction'], ['toolSearch', 'Tool search'],
];
export function ProviderCapabilities({ value, onChange }: { value: Capabilities; onChange: (value: Capabilities) => void }) {
  return <Section title="Capabilities" hint="Enable only the features this endpoint supports."><Card>{rows.map(([key, label]) => <Toggle key={key} label={label} checked={value[key]} onChange={checked => onChange({ ...value, [key]: checked })} />)}</Card></Section>;
}
