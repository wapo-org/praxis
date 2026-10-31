import React from 'react';
import { GlassSurface } from '@praxis/glass';
import { usePraxisStore } from '../../state/store';

export function ChatHeader({ onOpenGlassLab }: { onOpenGlassLab?: () => void }) {
  const { activeChat, models, selectedModelId, selectedProviderId, setActiveSheet, createNewChat } = usePraxisStore();
  const model = models.find(m => m.id === selectedModelId && m.providerId === selectedProviderId);
  return <header className="chat-header" data-testid="chat-top-bar">
    <GlassSurface radius={999} className="chat-header-circle">
      <button aria-label="History" data-testid="nav-history-button" onClick={() => setActiveSheet('history')}>☰</button>
    </GlassSurface>
    <button className="chat-header-title" data-testid="nav-chat-title-pill" onClick={() => setActiveSheet('settings')} aria-label="Chat and model settings">
      <strong>{activeChat?.title || 'New chat'}</strong><span>{model?.displayName || 'Select model'}</span>
    </button>
    <GlassSurface radius={999} className="chat-header-circle">
      <button aria-label="New chat" data-testid="nav-new-chat-button" onClick={() => void createNewChat('New chat')}>✎</button>
    </GlassSurface>
    <div className="chat-header-desktop">
      {onOpenGlassLab && <button onClick={onOpenGlassLab}>✦ Lab</button>}
      <button data-testid="nav-settings-button" aria-label="Settings" onClick={() => setActiveSheet('settings')}>⚙</button>
    </div>
  </header>;
}
