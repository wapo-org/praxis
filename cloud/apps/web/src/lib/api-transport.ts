import { z } from 'zod';
import {
  ConsentSchema,
  PreferencesSchema,
  RegistryEntrySchema,
  RegistrySchema,
  ToolActivitySchema,
  ToolCompletionSchema,
  ToolSpecSchema,
  TranscriptionSchema,
} from '@praxis/protocol';

export type ToolActivity = z.infer<typeof ToolActivitySchema>;
export type ToolCompletion = z.infer<typeof ToolCompletionSchema>;

export type Consent = z.infer<typeof ConsentSchema>;
export type Preferences = z.infer<typeof PreferencesSchema>;
export type Registry = z.infer<typeof RegistrySchema>;
export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;
export type ToolSpec = z.infer<typeof ToolSpecSchema>;
export type Transcription = z.infer<typeof TranscriptionSchema>;

export interface PageResult<T> {
  type: 'page';
  items: T[];
  nextCursor: string | null;
}

export class PraxisApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;

  constructor(status: number, code: string, message: string, requestId?: string) {
    super(message);
    this.name = 'PraxisApiError';
    this.status = status;
    this.code = status === 404 && code === 'http_error' ? 'not_found' : code;
    this.requestId = requestId;
  }
}

export interface ApiClientConfig {
  baseUrl?: string;
  bearerToken?: string;
}

// Multi-request operations pass the session signal that started them: a refresh keeps it live, an owner change aborts it.
export type ApiRequestInit = RequestInit & { headers?: Record<string, string>; session?: AbortSignal };

export class ApiTransport {
  onUnauthorized?: () => void;
  // Cookie clients start unbound; a closed verified session requires an explicit owner before dispatch can resume.
  private sessionIdentity: string | null | undefined;
  private sessionController = new AbortController();

  getSessionSignal(): AbortSignal {
    return this.sessionController.signal;
  }

  setSessionIdentity(userId: string | null): void {
    if (userId !== null && userId === this.sessionIdentity && !this.sessionController.signal.aborted) return;
    this.sessionController.abort();
    this.sessionIdentity = userId;
    if (userId !== null) this.sessionController = new AbortController();
  }

  async freshToken(): Promise<string> {
    const signal = this.getSessionSignal();
    signal.throwIfAborted();
    return this.bearerToken;
  }
  private baseUrl: string;
  private bearerToken: string;

  constructor(config?: ApiClientConfig) {
    const envBase =
      typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE_URL
        ? String(import.meta.env.VITE_API_BASE_URL)
        : '';
    this.baseUrl = (config?.baseUrl ?? envBase).replace(/\/$/, '');
    this.bearerToken = config?.bearerToken ?? '';
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getBearerToken(): string {
    return this.bearerToken;
  }

  setBearerToken(token: string): void {
    this.bearerToken = token;
  }

  protected url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  protected isApiOriginUrl(targetUrl: string): boolean {
    if (targetUrl.startsWith('/')) return true;
    try {
      const fallbackOrigin =
        typeof window !== 'undefined' && window.location?.origin
          ? window.location.origin
          : 'http://127.0.0.1';
      const apiOrigin = this.baseUrl
        ? new URL(this.baseUrl, fallbackOrigin).origin
        : fallbackOrigin;
      const parsedTarget = new URL(targetUrl, apiOrigin);
      return parsedTarget.origin === apiOrigin;
    } catch {
      return false;
    }
  }

  protected headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {
      ...(this.bearerToken ? { Authorization: `Bearer ${this.bearerToken}` } : {}),
      ...extra,
    };
    return h;
  }

  // A 401 from a scope that has since ended belongs to the old owner and must not sign out the current one.
  protected reportUnauthorized(signal: AbortSignal): void {
    signal.throwIfAborted();
    this.onUnauthorized?.();
  }

  async request<T>(path: string, init?: ApiRequestInit): Promise<T> {
    const { session, ...fetchInit } = init ?? {};
    const sessionSignal = session ?? this.getSessionSignal();
    const signal = fetchInit.signal ? AbortSignal.any([sessionSignal, fetchInit.signal]) : sessionSignal;
    signal.throwIfAborted();
    await this.freshToken();
    signal.throwIfAborted();
    const headers: Record<string, string> = {
      ...(fetchInit.body && typeof fetchInit.body === 'string'
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...this.headers(fetchInit.headers),
    };

    const res = await fetch(this.url(path), {
      ...fetchInit,
      credentials: 'include',
      headers,
      signal,
    });

    signal.throwIfAborted();
    if (res.status === 401) this.reportUnauthorized(signal);
    if (!res.ok) {
      let code = 'http_error';
      let message = `HTTP ${res.status}`;
      let requestId: string | undefined;
      try {
        const err = (await res.json()) as {
          code?: string;
          message?: string;
          requestId?: string;
        };
        if (err.code) code = err.code;
        if (err.message) message = err.message;
        if (err.requestId) requestId = err.requestId;
      } catch {}
      if (res.status === 404 && path === '/v1/runs') message = 'This chat or its model is no longer available after the server restarted. Refresh the page, choose an available model, and start a new chat.';
      else if (res.status === 404) message = 'This item is no longer available. Refresh the page and try again.';
      throw new PraxisApiError(res.status, code, message, requestId);
    }

    const result = await res.json() as T;
    signal.throwIfAborted();
    return result;
  }

}
