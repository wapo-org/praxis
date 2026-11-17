import type { Attachment } from '@praxis/protocol';
import { FeatureApiClient } from './api-features';
import { PraxisApiError, type Transcription } from './api-transport';
import { localUploadPath } from './hosts';

export class UploadApiClient extends FeatureApiClient {
  async uploadAttachment(file: File, chatId?: string): Promise<Attachment> {
    const session = this.captureSession();
    const req = await this.request<{
      type: 'upload.url';
      uploadUrl: string;
      expiresAt: string;
      method?: 'POST' | 'PUT';
    }>('/v1/uploads', {
      method: 'POST',
      body: JSON.stringify({
        type: 'upload.request',
        name: file.name,
        mediaType: file.type || 'application/octet-stream',
        size: Math.max(1, file.size),
        ...(chatId ? { chatId } : {}),
      }),
      session,
    });

    const direct = this.isApiOriginUrl(req.uploadUrl);
    const viaApi = direct ? null : localUploadPath(req.uploadUrl);
    const uploadTargetUrl = req.uploadUrl.startsWith('/')
      ? this.url(req.uploadUrl)
      : viaApi
        ? this.url(viaApi)
        : req.uploadUrl;
    const isApiOrigin = direct || viaApi !== null;
    const uploadHeaders: Record<string, string> = {
      'Content-Type': file.type || 'application/octet-stream',
      ...(isApiOrigin ? this.headers(undefined, session) : {}),
    };

    const uploadRes = await fetch(uploadTargetUrl, {
      method: req.method ?? 'PUT',
      headers: uploadHeaders,
      body: file,
      credentials: isApiOrigin ? 'include' : 'omit',
      signal: session.signal,
    });

    session.signal.throwIfAborted();
    if (isApiOrigin && uploadRes.status === 401) this.reportUnauthorized(session.signal);
    if (!uploadRes.ok) {
      let code = 'upload_failed';
      let message = `Upload failed with HTTP ${uploadRes.status}`;
      let requestId: string | undefined;
      try {
        const err = (await uploadRes.json()) as {
          code?: string;
          message?: string;
          requestId?: string;
        };
        if (err.code) code = err.code;
        if (err.message) message = err.message;
        if (err.requestId) requestId = err.requestId;
      } catch {}
      throw new PraxisApiError(uploadRes.status, code, message, requestId);
    }

    let storageId = '';
    try {
      const receipt = (await uploadRes.json()) as { storageId?: string };
      if (typeof receipt.storageId === 'string' && receipt.storageId.trim()) {
        storageId = receipt.storageId.trim();
      }
    } catch {}

    if (!storageId) {
      throw new PraxisApiError(
        502,
        'upload_invalid_receipt',
        'Upload target did not return a valid storageId receipt',
      );
    }

    return this.request<Attachment>('/v1/uploads/complete', {
      method: 'POST',
      body: JSON.stringify({
        type: 'upload.complete',
        name: file.name,
        mediaType: file.type || 'application/octet-stream',
        size: Math.max(1, file.size),
        storageId,
        ...(chatId ? { chatId } : {}),
      }),
      session,
    });
  }

  async transcribeAudio(
    audioBlob: Blob,
    options?: { model?: string; language?: string },
  ): Promise<Transcription> {
    const buf = await audioBlob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]!);
    }
    const audioBase64 = typeof btoa === 'function' ? btoa(binary) : '';

    return this.request<Transcription>('/v1/transcribe', {
      method: 'POST',
      body: JSON.stringify({
        type: 'transcribe.request',
        audioBase64,
        mediaType: audioBlob.type || 'audio/webm',
        model: options?.model ?? 'whisper-large-v3-turbo',
        ...(options?.language ? { language: options.language } : {}),
      }),
    });
  }
}
