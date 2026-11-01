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



export class ApiTransport {
  onUnauthorized?: () => void;
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

  async request<T>(
    path: string,
    init?: RequestInit & { headers?: Record<string, string> },
  ): Promise<T> {
    const headers: Record<string, string> = {
      ...(init?.body && typeof init.body === 'string'
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...this.headers(init?.headers),
    };

    const res = await fetch(this.url(path), {
      ...init,
      credentials: 'include',
      headers,
    });

    if (res.status === 401) this.onUnauthorized?.();
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
      if (res.status === 404) message = `Not available: ${path}`;
      throw new PraxisApiError(res.status, code, message, requestId);
    }

    return (await res.json()) as T;
  }

}
