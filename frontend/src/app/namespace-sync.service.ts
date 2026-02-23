import { Injectable } from '@angular/core';

const appConnectedEvent = 'iframe-connected';
const namespaceSelectedEvent = 'namespace-selected';
const allNamespacesEvent = 'all-namespaces';

interface DashboardMessage {
  type?: string;
  value?: unknown;
}

type NamespaceChangeHandler = (namespace: string) => void | Promise<void>;

@Injectable({ providedIn: 'root' })
export class NamespaceSyncService {
  private namespacePoller: ReturnType<typeof setInterval> | null = null;
  private lastObservedNamespace = '';
  private onNamespaceChange: NamespaceChangeHandler | null = null;

  private readonly messageHandler = (event: MessageEvent): void => {
    const data = event.data as DashboardMessage | null;
    if (!data || typeof data !== 'object') {
      return;
    }

    switch (data.type) {
      case namespaceSelectedEvent:
        if (typeof data.value === 'string') {
          this.emitNamespaceChange(data.value);
        }
        break;
      case allNamespacesEvent:
        if (Array.isArray(data.value) && data.value.length > 0) {
          const preferred = this.currentNamespaceFromURL();
          const candidate =
            preferred.trim() !== '' ? preferred : String(data.value[0] ?? '').trim();
          if (candidate !== '') {
            this.emitNamespaceChange(candidate);
          }
        }
        break;
      default:
        break;
    }
  };

  start(handler: NamespaceChangeHandler): void {
    this.stop();
    this.onNamespaceChange = handler;
    this.lastObservedNamespace = this.currentNamespaceFromURL();

    window.addEventListener('message', this.messageHandler);
    this.notifyDashboardConnected();

    this.namespacePoller = setInterval(() => {
      const observedNamespace = this.currentNamespaceFromURL();
      if (observedNamespace === '' || observedNamespace === this.lastObservedNamespace) {
        return;
      }

      this.emitNamespaceChange(observedNamespace);
    }, 300);
  }

  stop(): void {
    window.removeEventListener('message', this.messageHandler);
    if (this.namespacePoller !== null) {
      clearInterval(this.namespacePoller);
      this.namespacePoller = null;
    }
    this.onNamespaceChange = null;
  }

  currentNamespaceFromURL(): string {
    const params = new URLSearchParams(window.location.search);
    return (params.get('namespace') ?? params.get('ns') ?? '').trim();
  }

  setCurrentNamespace(namespace: string): void {
    this.lastObservedNamespace = namespace.trim();
  }

  private emitNamespaceChange(namespace: string): void {
    const trimmedNamespace = namespace.trim();
    if (trimmedNamespace === '') {
      return;
    }

    this.lastObservedNamespace = trimmedNamespace;
    if (this.onNamespaceChange) {
      void this.onNamespaceChange(trimmedNamespace);
    }
  }

  private notifyDashboardConnected(): void {
    const payload = { type: appConnectedEvent };
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(payload, '*');
    }

    if (window.opener && window.opener.parent) {
      window.opener.parent.postMessage(payload, '*');
    }
  }
}
