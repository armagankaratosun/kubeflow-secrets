import type {
  NamespaceResponse,
  SecretDetail,
  SecretEventsResponse,
  SecretListResponse,
  SecretUpsertRequest,
  SecretYAMLResponse,
} from "./types";

interface APIErrorPayload {
  error?: string;
}

function resolveAPIBase(): string {
  return window.location.pathname.startsWith("/secrets") ? "/secrets" : "";
}

function toMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown error";
}

export class APIClient {
  private readonly basePath: string;

  constructor(basePath = resolveAPIBase()) {
    this.basePath = basePath;
  }

  private toURL(path: string): string {
    if (!path.startsWith("/")) {
      return path;
    }
    return `${this.basePath}${path}`;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(this.toURL(path), init);
    const payload = (await response.json().catch(() => ({}))) as APIErrorPayload & T;

    if (!response.ok) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }

    return payload;
  }

  async getNamespaces(): Promise<string[]> {
    const payload = await this.request<NamespaceResponse>("/api/namespaces");
    return Array.isArray(payload.namespaces) ? payload.namespaces : [];
  }

  async listSecrets(namespace: string): Promise<SecretListResponse> {
    const query = encodeURIComponent(namespace);
    return this.request<SecretListResponse>(`/api/secrets?namespace=${query}`);
  }

  async getSecret(name: string): Promise<SecretDetail> {
    return this.request<SecretDetail>(`/api/secrets/${encodeURIComponent(name)}`);
  }

  async getSecretEvents(name: string): Promise<SecretEventsResponse> {
    return this.request<SecretEventsResponse>(
      `/api/secrets/${encodeURIComponent(name)}/events`,
    );
  }

  async getSecretYAML(name: string): Promise<SecretYAMLResponse> {
    return this.request<SecretYAMLResponse>(
      `/api/secrets/${encodeURIComponent(name)}/yaml`,
    );
  }

  async createSecret(payload: SecretUpsertRequest): Promise<void> {
    await this.request("/api/secrets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  async updateSecret(name: string, payload: SecretUpsertRequest): Promise<void> {
    await this.request(`/api/secrets/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  async deleteSecret(name: string): Promise<void> {
    await this.request(`/api/secrets/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  }

  message(err: unknown): string {
    return toMessage(err);
  }
}
