import React from 'react';

export function ChatScreen({ onOpenGlassLab }: { onOpenGlassLab?: () => void }) {
  return <div data-testid="chat-screen-placeholder" onClick={onOpenGlassLab} />;
}
