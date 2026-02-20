export type SecretType = "Opaque" | "kubernetes.io/dockerconfigjson" | string;

export type EditorMode = "create" | "edit";
export type PageView = "list" | "detail";
export type DetailTab = "overview" | "events" | "yaml";
export type FilterField = "name" | "type" | "createdAt";

export interface SecretFilter {
  id: string;
  field: FilterField;
  value: string;
}

export interface SecretListItem {
  name: string;
  namespace: string;
  type: SecretType;
  creationTimestamp: string;
}

export interface SecretDetail {
  name: string;
  namespace: string;
  type: SecretType;
  creationTimestamp: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  data: Record<string, string>;
  stringData: Record<string, string>;
}

export interface SecretEvent {
  type: string;
  reason: string;
  message: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  source: string;
}

export interface NamespaceResponse {
  namespaces: string[];
}

export interface SecretListResponse {
  items: SecretListItem[];
}

export interface SecretEventsResponse {
  items: SecretEvent[];
}

export interface SecretYAMLResponse {
  yaml: string;
}

export interface SecretUpsertRequest {
  namespace: string;
  name: string;
  type: SecretType;
  data: Record<string, string>;
  stringData: Record<string, string>;
}

export interface AppState {
  namespace: string;
  secrets: SecretListItem[];
  loading: boolean;
  filterField: FilterField;
  filterValue: string;
  filters: SecretFilter[];
  view: PageView;
  detailTab: DetailTab;
  mode: EditorMode;
  activeSecret: string;
  detail: SecretDetail | null;
  events: SecretEvent[];
  yaml: string;
}
