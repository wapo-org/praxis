import React from 'react';
import type { Attachment } from '@praxis/protocol';
import { apiClient, type Preferences } from '../lib/api';

export function useMediaActions({ activeChatId, preferences, setAttachmentsById, setErrorBanner }: {
  activeChatId: string | null;
  preferences: Preferences | null;
  setAttachmentsById: React.Dispatch<React.SetStateAction<Record<string, Attachment>>>;
  setErrorBanner: React.Dispatch<React.SetStateAction<string | null>>;
}) {
  const uploadFiles = React.useCallback(
    async (files: File[]): Promise<Attachment[]> => {
      const uploaded: Attachment[] = [];
      for (const file of files) {
        try {
          const att = await apiClient.uploadAttachment(file, activeChatId ?? undefined);
          uploaded.push(att);
          setAttachmentsById((prev) => ({ ...prev, [att.id]: att }));
        } catch (err) {
          setErrorBanner(err instanceof Error ? err.message : 'Upload failed');
          throw err;
        }
      }
      return uploaded;
    },
    [activeChatId],
  );

  const transcribeAudioBlob = React.useCallback(
    async (blob: Blob): Promise<string> => {
      try {
        const res = await apiClient.transcribeAudio(blob, {
          model: preferences?.voice?.model ?? 'whisper-large-v3-turbo',
          language: preferences?.voice?.language,
        });
        return res.text;
      } catch (err) {
        setErrorBanner(err instanceof Error ? err.message : 'Transcription failed');
        throw err;
      }
    },
    [preferences],
  );

  return { uploadFiles, transcribeAudioBlob };
}
