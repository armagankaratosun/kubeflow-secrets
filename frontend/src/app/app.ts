import { Component, HostListener, OnDestroy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatTabsModule } from '@angular/material/tabs';

import { SecretsAPIService } from './secrets-api.service';
import { NamespaceSyncService } from './namespace-sync.service';
import {
  buildFilterID,
  detailManagedByLabel,
  parseJSONStringMap,
  prettyJSON,
  resolveErrorMessage,
  stringMapKeys,
  stringMapToLines,
} from './secret-utils';
import type {
  DetailTab,
  EditorMode,
  FilterField,
  PageView,
  SecretDetail,
  SecretEvent,
  SecretFilter,
  SecretListItem,
  SecretUpsertRequest,
} from './models';

interface OverviewItem {
  label: string;
  value: string;
}

interface FilterFieldOption {
  value: FilterField;
  label: string;
}

@Component({
  selector: 'app-root',
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatDividerModule,
    MatIconModule,
    MatTabsModule,
  ],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class AppComponent implements OnInit, OnDestroy {
  namespace = '';
  secrets: SecretListItem[] = [];
  loading = false;

  view: PageView = 'list';
  detailTab: DetailTab = 'overview';
  activeSecret = '';
  detail: SecretDetail | null = null;
  events: SecretEvent[] = [];
  yaml = '';

  statusMessage = '';
  statusError = false;
  detailStatusMessage = '';
  detailStatusError = false;

  filterField: FilterField = 'name';
  filterValue = '';
  filters: SecretFilter[] = [];

  editorOpen = false;
  editorMode: EditorMode = 'create';
  editorTitle = 'New Secret';
  editorSubtitle = 'Create a managed secret in your Kubeflow profile namespace.';
  editorError = '';
  editorName = '';
  editorType = 'Opaque';
  editorStringData = '{\n  "username": "example",\n  "password": "secret"\n}';
  editorData = '{}';

  deleteOpen = false;
  deleteError = '';

  readonly filterFieldOptions: FilterFieldOption[] = [
    { value: 'name', label: 'Name' },
    { value: 'type', label: 'Type' },
    { value: 'createdAt', label: 'Created at' },
  ];

  private readonly api = inject(SecretsAPIService);
  private readonly namespaceSync = inject(NamespaceSyncService);

  private availableNamespaces: string[] = [];
  private namespaceSwitchInProgress = false;

  ngOnInit(): void {
    this.namespaceSync.start((namespace) => this.applyExternalNamespaceSelection(namespace));
    void this.bootstrap();
  }

  ngOnDestroy(): void {
    this.namespaceSync.stop();
  }

  @HostListener('document:keydown.escape')
  handleEscape(): void {
    if (this.editorOpen) {
      this.closeEditor();
    }
    if (this.deleteOpen) {
      this.closeDeleteDialog();
    }
  }

  get hasActiveFilters(): boolean {
    return this.filters.length > 0;
  }

  get filteredSecrets(): SecretListItem[] {
    if (!this.filters.length) {
      return this.secrets;
    }

    return this.secrets.filter((secret) =>
      this.filters.every((filter) => this.matchesFilter(secret, filter)),
    );
  }

  get detailName(): string {
    return this.activeSecret || '-';
  }

  get detailTabIndex(): number {
    switch (this.detailTab) {
      case 'overview':
        return 0;
      case 'events':
        return 1;
      case 'yaml':
        return 2;
      default:
        return 0;
    }
  }

  get overviewItems(): OverviewItem[] {
    if (!this.detail) {
      return [];
    }

    return [
      { label: 'Name', value: this.detail.name },
      { label: 'Namespace', value: this.detail.namespace },
      { label: 'Type', value: this.detail.type },
      { label: 'Created at', value: this.formatDate(this.detail.creationTimestamp) },
      { label: 'Managed label', value: detailManagedByLabel(this.detail) },
      { label: 'String data keys', value: stringMapKeys(this.detail.stringData) },
      { label: 'Data keys', value: stringMapKeys(this.detail.data) },
      { label: 'Labels', value: stringMapToLines(this.detail.labels) },
      { label: 'Annotations', value: stringMapToLines(this.detail.annotations) },
    ];
  }

  get hasOverviewData(): boolean {
    return this.overviewItems.length > 0;
  }

  setStatus(message: string, isError = false): void {
    this.statusMessage = message;
    this.statusError = isError;
  }

  setDetailStatus(message: string, isError = false): void {
    this.detailStatusMessage = message;
    this.detailStatusError = isError;
  }

  setLoading(loading: boolean): void {
    this.loading = loading;
  }

  setView(view: PageView): void {
    this.view = view;
  }

  setActiveTab(tab: DetailTab): void {
    this.detailTab = tab;
  }

  onDetailTabIndexChange(index: number): void {
    switch (index) {
      case 1:
        this.setActiveTab('events');
        return;
      case 2:
        this.setActiveTab('yaml');
        return;
      default:
        this.setActiveTab('overview');
    }
  }

  formatDate(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
  }

  applyFilter(): void {
    const value = this.filterValue.trim();
    if (!value) {
      return;
    }

    this.filters.push({
      id: buildFilterID(),
      field: this.filterField,
      value,
    });
    this.filterValue = '';
  }

  removeFilter(filterID: string): void {
    this.filters = this.filters.filter((item) => item.id !== filterID);
  }

  fieldLabel(field: FilterField): string {
    switch (field) {
      case 'name':
        return 'Name';
      case 'type':
        return 'Type';
      case 'createdAt':
        return 'Created at';
      default:
        return field;
    }
  }

  clearFilters(): void {
    this.filters = [];
  }

  async refresh(): Promise<void> {
    await this.loadSecrets();
    if (this.view === 'detail' && this.activeSecret) {
      await this.loadSecretDetails(this.activeSecret);
    }
  }

  async openSecretDetails(name: string): Promise<void> {
    this.activeSecret = name;
    this.setView('detail');
    this.setActiveTab('overview');
    await this.loadSecretDetails(name);
  }

  backToList(): void {
    this.setView('list');
  }

  openCreateDialog(): void {
    if (!this.namespace) {
      this.setStatus('No namespace resolved for current user.', true);
      return;
    }

    this.editorMode = 'create';
    this.editorTitle = 'New Secret';
    this.editorSubtitle = 'Create a managed secret in your Kubeflow profile namespace.';
    this.editorError = '';
    this.editorName = '';
    this.editorType = 'Opaque';
    this.editorStringData = '{\n  "username": "example",\n  "password": "secret"\n}';
    this.editorData = '{}';
    this.editorOpen = true;
  }

  async openEditDialog(name: string): Promise<void> {
    this.editorError = '';
    this.setLoading(true);
    try {
      const detail = await this.api.getSecret(name);
      this.editorMode = 'edit';
      this.activeSecret = detail.name;
      this.editorTitle = 'Edit Secret';
      this.editorSubtitle = 'Update values for this managed secret.';
      this.editorName = detail.name || '';
      this.editorType = detail.type || 'Opaque';
      this.editorStringData = prettyJSON(detail.stringData);
      this.editorData = prettyJSON(detail.data);
      this.editorOpen = true;
    } catch (error: unknown) {
      this.setStatus(`Failed to load secret ${name}: ${resolveErrorMessage(error)}`, true);
    } finally {
      this.setLoading(false);
    }
  }

  closeEditor(): void {
    this.editorOpen = false;
  }

  onEditorOverlayClick(event: Event): void {
    if (event.target === event.currentTarget) {
      this.closeEditor();
    }
  }

  openDeleteDialog(secretName: string): void {
    this.activeSecret = secretName;
    this.deleteError = '';
    this.deleteOpen = true;
  }

  closeDeleteDialog(): void {
    this.deleteOpen = false;
    this.deleteError = '';
  }

  onDeleteOverlayClick(event: Event): void {
    if (event.target === event.currentTarget) {
      this.closeDeleteDialog();
    }
  }

  async saveSecret(): Promise<void> {
    const name = this.editorName.trim();
    if (!name) {
      this.editorError = 'Name is required.';
      return;
    }

    let stringData: Record<string, string>;
    let data: Record<string, string>;
    try {
      stringData = parseJSONStringMap(this.editorStringData || '{}', 'String Data');
      data = parseJSONStringMap(this.editorData || '{}', 'Data');
    } catch (error: unknown) {
      this.editorError = resolveErrorMessage(error);
      return;
    }

    if (!Object.keys(stringData).length && !Object.keys(data).length) {
      this.editorError = 'Provide at least one key in String Data or Data.';
      return;
    }

    const payload: SecretUpsertRequest = {
      namespace: this.namespace,
      name,
      type: this.editorType,
      stringData,
      data,
    };

    const isCreate = this.editorMode === 'create';
    this.editorError = '';
    this.setStatus(`${isCreate ? 'Creating' : 'Updating'} secret ${name}...`);
    this.setLoading(true);

    try {
      if (isCreate) {
        await this.api.createSecret(payload);
      } else {
        await this.api.updateSecret(name, payload);
      }

      this.closeEditor();
      await this.loadSecrets();
      this.setStatus(`Secret ${name} ${isCreate ? 'created' : 'updated'} in ${this.namespace}.`);
      if (this.view === 'detail' && this.activeSecret === name) {
        await this.loadSecretDetails(name);
      }
    } catch (error: unknown) {
      const message = resolveErrorMessage(error);
      this.editorError = message;
      this.setStatus(`Failed to save secret ${name}: ${message}`, true);
    } finally {
      this.setLoading(false);
    }
  }

  async deleteSecret(): Promise<void> {
    const name = this.activeSecret;
    if (!name) {
      this.deleteError = 'No secret selected.';
      return;
    }

    this.deleteError = '';
    this.setStatus(`Deleting secret ${name}...`);
    this.setLoading(true);
    try {
      await this.api.deleteSecret(name);
      this.closeDeleteDialog();
      if (this.view === 'detail' && this.activeSecret === name) {
        this.setView('list');
        this.setDetailStatus('');
      }
      await this.loadSecrets();
      this.setStatus(`Secret ${name} deleted from ${this.namespace}.`);
    } catch (error: unknown) {
      const message = resolveErrorMessage(error);
      this.deleteError = message;
      this.setStatus(`Failed to delete secret ${name}: ${message}`, true);
    } finally {
      this.setLoading(false);
    }
  }

  trackSecret(_index: number, item: SecretListItem): string {
    return item.name;
  }

  trackFilter(_index: number, item: SecretFilter): string {
    return item.id;
  }

  trackOverview(_index: number, item: OverviewItem): string {
    return item.label;
  }

  trackEvent(index: number, event: SecretEvent): string {
    return `${event.lastSeen}-${event.reason}-${index}`;
  }

  private async bootstrap(): Promise<void> {
    this.setView('list');
    this.setActiveTab('overview');
    this.setStatus('Resolving profile namespace...');

    try {
      await this.loadNamespace();
      await this.loadSecrets();
    } catch (error: unknown) {
      this.setStatus(resolveErrorMessage(error), true);
    }
  }

  private async loadNamespace(): Promise<void> {
    const namespaces = await this.api.getNamespaces();
    if (!namespaces.length) {
      throw new Error('No namespace resolved for current user.');
    }

    this.availableNamespaces = namespaces;

    const requestedNamespace = this.namespaceSync.currentNamespaceFromURL();
    const namespace =
      requestedNamespace && namespaces.includes(requestedNamespace)
        ? requestedNamespace
        : namespaces[0];

    if (!namespace) {
      throw new Error('No namespace resolved for current user.');
    }

    this.namespace = namespace;
    this.namespaceSync.setCurrentNamespace(namespace);
  }

  private async loadSecrets(): Promise<void> {
    if (!this.namespace) {
      return;
    }

    this.setStatus(`Loading managed secrets from ${this.namespace}...`);
    this.setLoading(true);
    try {
      const payload = await this.api.listSecrets(this.namespace);
      this.secrets = Array.isArray(payload.items) ? payload.items : [];
      this.setStatus(`Loaded ${this.secrets.length} managed secret(s) from ${this.namespace}.`);
    } catch (error: unknown) {
      this.secrets = [];
      this.setStatus(`Failed to load secrets: ${resolveErrorMessage(error)}`, true);
    } finally {
      this.setLoading(false);
    }
  }

  private async loadSecretDetails(name: string): Promise<void> {
    this.setDetailStatus(`Loading details for secret ${name}...`);
    this.setLoading(true);

    try {
      const [detail, eventsPayload, yamlPayload] = await Promise.all([
        this.api.getSecret(name),
        this.api.getSecretEvents(name),
        this.api.getSecretYAML(name),
      ]);

      this.detail = detail;
      this.events = Array.isArray(eventsPayload.items) ? eventsPayload.items : [];
      this.yaml = yamlPayload.yaml || '';
      this.setDetailStatus(`Loaded details for ${name}.`);
    } catch (error: unknown) {
      this.detail = {
        name,
        namespace: this.namespace,
        type: '-',
        creationTimestamp: '',
        labels: {},
        annotations: {},
        data: {},
        stringData: {},
      };
      this.events = [];
      this.yaml = '# Failed to load YAML';
      this.setDetailStatus(`Failed to load details: ${resolveErrorMessage(error)}`, true);
    } finally {
      this.setLoading(false);
    }
  }

  private matchesFilter(secret: SecretListItem, filter: SecretFilter): boolean {
    const query = filter.value.trim().toLowerCase();
    if (!query) {
      return true;
    }

    switch (filter.field) {
      case 'name':
        return secret.name.toLowerCase().includes(query);
      case 'type':
        return secret.type.toLowerCase().includes(query);
      case 'createdAt':
        return (
          this.formatDate(secret.creationTimestamp).toLowerCase().includes(query) ||
          secret.creationTimestamp.toLowerCase().includes(query)
        );
      default:
        return true;
    }
  }

  private async applyExternalNamespaceSelection(namespace: string): Promise<void> {
    const targetNamespace = namespace.trim();
    if (!targetNamespace || targetNamespace === this.namespace || this.namespaceSwitchInProgress) {
      return;
    }

    this.namespaceSwitchInProgress = true;
    try {
      const namespaces =
        this.availableNamespaces.length > 0
          ? this.availableNamespaces
          : await this.api.getNamespaces();
      this.availableNamespaces = namespaces;

      if (!namespaces.includes(targetNamespace)) {
        this.setStatus(`Namespace ${targetNamespace} is not available for current user.`, true);
        return;
      }

      this.namespace = targetNamespace;
      this.namespaceSync.setCurrentNamespace(targetNamespace);
      this.filters = [];

      if (this.view === 'detail') {
        this.backToList();
        this.activeSecret = '';
        this.detail = null;
        this.events = [];
        this.yaml = '';
        this.setDetailStatus('');
      }

      await this.loadSecrets();
    } catch (error: unknown) {
      this.setStatus(`Failed to switch namespace: ${resolveErrorMessage(error)}`, true);
    } finally {
      this.namespaceSwitchInProgress = false;
    }
  }
}
