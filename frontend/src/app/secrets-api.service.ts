import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

import type {
  NamespaceResponse,
  SecretDetail,
  SecretEventsResponse,
  SecretListResponse,
  SecretUpsertRequest,
  SecretYAMLResponse,
} from './models';

interface APIErrorPayload {
  error?: string;
}

function resolveAPIBase(): string {
  return window.location.pathname.startsWith('/secrets') ? '/secrets' : '';
}

@Injectable({ providedIn: 'root' })
export class SecretsAPIService {
  private readonly basePath = resolveAPIBase();
  private readonly http = inject(HttpClient);

  private toURL(path: string): string {
    if (!path.startsWith('/')) {
      return path;
    }
    return `${this.basePath}${path}`;
  }

  private async request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    try {
      const response = await firstValueFrom(
        this.http.request<T>(init?.method ?? 'GET', this.toURL(path), {
          body: init?.body,
        }),
      );
      return response;
    } catch (error: unknown) {
      if (error instanceof HttpErrorResponse) {
        const payload = error.error as APIErrorPayload | null;
        throw new Error(payload?.error || `HTTP ${error.status}`);
      }
      throw error;
    }
  }

  async getNamespaces(): Promise<string[]> {
    const payload = await this.request<NamespaceResponse>('/api/namespaces');
    return Array.isArray(payload.namespaces) ? payload.namespaces : [];
  }

  listSecrets(namespace: string): Promise<SecretListResponse> {
    const query = encodeURIComponent(namespace);
    return this.request<SecretListResponse>(`/api/secrets?namespace=${query}`);
  }

  getSecret(name: string): Promise<SecretDetail> {
    return this.request<SecretDetail>(`/api/secrets/${encodeURIComponent(name)}`);
  }

  getSecretEvents(name: string): Promise<SecretEventsResponse> {
    return this.request<SecretEventsResponse>(`/api/secrets/${encodeURIComponent(name)}/events`);
  }

  getSecretYAML(name: string): Promise<SecretYAMLResponse> {
    return this.request<SecretYAMLResponse>(`/api/secrets/${encodeURIComponent(name)}/yaml`);
  }

  createSecret(payload: SecretUpsertRequest): Promise<void> {
    return this.request('/api/secrets', { method: 'POST', body: payload });
  }

  updateSecret(name: string, payload: SecretUpsertRequest): Promise<void> {
    return this.request(`/api/secrets/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: payload,
    });
  }

  deleteSecret(name: string): Promise<void> {
    return this.request(`/api/secrets/${encodeURIComponent(name)}`, { method: 'DELETE' });
  }
}
