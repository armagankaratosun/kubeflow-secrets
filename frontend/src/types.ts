export type SecretType = "Opaque" | "kubernetes.io/dockerconfigjson" | string;

export type EditorMode = "create" | "edit" | "view";

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

export interface NamespaceResponse {
  namespaces: string[];
}

export interface SecretListResponse {
  items: SecretListItem[];
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
  filter: string;
  loading: boolean;
  mode: EditorMode;
  activeSecret: string;
}
