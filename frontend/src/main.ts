import { APIClient } from "./api";
import type {
  AppState,
  EditorMode,
  SecretDetail,
  SecretListItem,
  SecretUpsertRequest,
} from "./types";

function mustElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`missing required element: ${id}`);
  }
  return element as T;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown error";
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

function parseStringObject(raw: string, fieldName: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${fieldName} must be valid JSON.`);
  }

  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`${fieldName} must be a JSON object.`);
  }

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!key.trim()) {
      throw new Error(`${fieldName} contains an empty key.`);
    }
    if (typeof value !== "string") {
      throw new Error(`${fieldName} values must be strings.`);
    }
    out[key] = value;
  }
  return out;
}

function prettyJSON(value: unknown, fallback = "{}"): string {
  if (!value || typeof value !== "object") {
    return fallback;
  }
  return JSON.stringify(value, null, 2);
}

const state: AppState = {
  namespace: "",
  secrets: [],
  filter: "",
  loading: false,
  mode: "create",
  activeSecret: "",
};

const api = new APIClient();

const namespaceChip = mustElement<HTMLSpanElement>("namespaceChip");
const refreshBtn = mustElement<HTMLButtonElement>("refreshBtn");
const newBtn = mustElement<HTMLButtonElement>("newBtn");
const filterInput = mustElement<HTMLInputElement>("filterInput");
const statusRow = mustElement<HTMLDivElement>("statusRow");
const rows = mustElement<HTMLTableSectionElement>("secretsRows");

const editorOverlay = mustElement<HTMLDivElement>("editorOverlay");
const editorTitle = mustElement<HTMLHeadingElement>("editorTitle");
const editorSubtitle = mustElement<HTMLParagraphElement>("editorSubtitle");
const editorError = mustElement<HTMLDivElement>("editorError");
const closeEditorBtn = mustElement<HTMLButtonElement>("closeEditorBtn");
const saveBtn = mustElement<HTMLButtonElement>("saveBtn");
const viewMeta = mustElement<HTMLUListElement>("viewMeta");

const nameInput = mustElement<HTMLInputElement>("nameInput");
const namespaceInput = mustElement<HTMLInputElement>("namespaceInput");
const typeSelect = mustElement<HTMLSelectElement>("typeSelect");
const stringDataInput = mustElement<HTMLTextAreaElement>("stringDataInput");
const dataInput = mustElement<HTMLTextAreaElement>("dataInput");

const deleteOverlay = mustElement<HTMLDivElement>("deleteOverlay");
const deleteMessage = mustElement<HTMLParagraphElement>("deleteMessage");
const deleteError = mustElement<HTMLDivElement>("deleteError");
const confirmDeleteBtn = mustElement<HTMLButtonElement>("confirmDeleteBtn");
const cancelDeleteBtn = mustElement<HTMLButtonElement>("cancelDeleteBtn");

function setStatus(message: string, isError = false): void {
  statusRow.textContent = message;
  statusRow.className = isError ? "status-row error" : "status-row";
}

function setLoading(loading: boolean): void {
  state.loading = loading;
  refreshBtn.disabled = loading;
  newBtn.disabled = loading;
  saveBtn.disabled = loading;
  confirmDeleteBtn.disabled = loading;
}

function openOverlay(overlay: HTMLDivElement): void {
  overlay.classList.add("open");
  overlay.setAttribute("aria-hidden", "false");
}

function closeOverlay(overlay: HTMLDivElement): void {
  overlay.classList.remove("open");
  overlay.setAttribute("aria-hidden", "true");
}

function resetEditorError(): void {
  editorError.textContent = "";
}

function resetDeleteError(): void {
  deleteError.textContent = "";
}

function setEditorReadOnly(isReadOnly: boolean): void {
  nameInput.disabled = isReadOnly || state.mode === "edit";
  typeSelect.disabled = isReadOnly;
  stringDataInput.disabled = isReadOnly;
  dataInput.disabled = isReadOnly;
  saveBtn.style.display = isReadOnly ? "none" : "inline-flex";
}

function clearElement(el: HTMLElement): void {
  while (el.firstChild) {
    el.removeChild(el.firstChild);
  }
}

function renderSecretMeta(detail: SecretDetail): void {
  clearElement(viewMeta);

  const items: Array<[string, string]> = [
    ["Name", detail.name],
    ["Namespace", detail.namespace],
    ["Type", detail.type],
    ["Created at", formatDate(detail.creationTimestamp)],
  ];

  for (const [label, value] of items) {
    const li = document.createElement("li");
    const strong = document.createElement("strong");
    strong.textContent = `${label}: `;

    const code = document.createElement("code");
    code.textContent = value;

    li.appendChild(strong);
    li.appendChild(code);
    viewMeta.appendChild(li);
  }
}

function filteredSecrets(): SecretListItem[] {
  const query = state.filter.trim().toLowerCase();
  if (!query) {
    return state.secrets;
  }

  return state.secrets.filter((secret) => {
    return (
      secret.name.toLowerCase().includes(query) ||
      secret.type.toLowerCase().includes(query)
    );
  });
}

async function loadNamespace(): Promise<void> {
  const namespaces = await api.getNamespaces();
  if (!namespaces.length) {
    throw new Error("No namespace resolved for current user.");
  }

  const namespace = namespaces[0];
  if (!namespace) {
    throw new Error("No namespace resolved for current user.");
  }

  state.namespace = namespace;
  namespaceChip.textContent = `Namespace: ${namespace}`;
  namespaceInput.value = namespace;
}

function renderTable(): void {
  rows.innerHTML = "";
  const list = filteredSecrets();

  if (!list.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.className = "empty";
    td.textContent = state.secrets.length
      ? "No secrets match the current filter."
      : "No managed secrets found. Create one with + New Secret.";

    tr.appendChild(td);
    rows.appendChild(tr);
    return;
  }

  for (const secret of list) {
    const tr = document.createElement("tr");

    const nameTd = document.createElement("td");
    nameTd.className = "name";
    nameTd.textContent = secret.name;

    const typeTd = document.createElement("td");
    const typePill = document.createElement("span");
    typePill.className = "type-pill";
    typePill.textContent = secret.type;
    typeTd.appendChild(typePill);

    const createdTd = document.createElement("td");
    createdTd.textContent = formatDate(secret.creationTimestamp);

    const actionsTd = document.createElement("td");
    const actions = document.createElement("div");
    actions.className = "actions";

    const viewBtn = document.createElement("button");
    viewBtn.type = "button";
    viewBtn.className = "action-btn";
    viewBtn.textContent = "View";
    viewBtn.addEventListener("click", () => {
      void openEditorFromSecret("view", secret.name);
    });

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "action-btn";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => {
      void openEditorFromSecret("edit", secret.name);
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "action-btn delete";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () => {
      openDeleteDialog(secret.name);
    });

    actions.appendChild(viewBtn);
    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);
    actionsTd.appendChild(actions);

    tr.appendChild(nameTd);
    tr.appendChild(typeTd);
    tr.appendChild(createdTd);
    tr.appendChild(actionsTd);
    rows.appendChild(tr);
  }
}

async function loadSecrets(): Promise<void> {
  if (!state.namespace) {
    return;
  }

  setStatus(`Loading managed secrets from ${state.namespace}...`);
  setLoading(true);
  try {
    const payload = await api.listSecrets(state.namespace);
    state.secrets = Array.isArray(payload.items) ? payload.items : [];
    renderTable();
    setStatus(`Loaded ${state.secrets.length} managed secret(s) from ${state.namespace}.`);
  } catch (error: unknown) {
    state.secrets = [];
    renderTable();
    setStatus(`Failed to load secrets: ${api.message(error)}`, true);
  } finally {
    setLoading(false);
  }
}

function openCreateDialog(): void {
  if (!state.namespace) {
    setStatus("No namespace resolved for current user.", true);
    return;
  }

  state.mode = "create";
  state.activeSecret = "";

  editorTitle.textContent = "New Secret";
  editorSubtitle.textContent = "Create a managed secret in your Kubeflow profile namespace.";
  viewMeta.style.display = "none";

  namespaceInput.value = state.namespace;
  nameInput.value = "";
  typeSelect.value = "Opaque";
  stringDataInput.value = '{\n  "username": "example",\n  "password": "secret"\n}';
  dataInput.value = "{}";

  saveBtn.textContent = "Create";
  setEditorReadOnly(false);
  resetEditorError();
  openOverlay(editorOverlay);
  setTimeout(() => nameInput.focus(), 10);
}

async function openEditorFromSecret(mode: Exclude<EditorMode, "create">, name: string): Promise<void> {
  if (!state.namespace) {
    setStatus("No namespace resolved for current user.", true);
    return;
  }

  resetEditorError();
  setLoading(true);
  try {
    const detail = await api.getSecret(name);

    state.mode = mode;
    state.activeSecret = detail.name;

    namespaceInput.value = detail.namespace || state.namespace;
    nameInput.value = detail.name || "";
    typeSelect.value = detail.type || "Opaque";
    stringDataInput.value = prettyJSON(detail.stringData);
    dataInput.value = prettyJSON(detail.data);

    if (mode === "view") {
      editorTitle.textContent = "View Secret";
      editorSubtitle.textContent = "Read-only details for this managed secret.";
      saveBtn.textContent = "Save";
      setEditorReadOnly(true);
      renderSecretMeta(detail);
      viewMeta.style.display = "block";
    } else {
      editorTitle.textContent = "Edit Secret";
      editorSubtitle.textContent = "Update values for this managed secret.";
      saveBtn.textContent = "Save";
      setEditorReadOnly(false);
      nameInput.disabled = true;
      viewMeta.style.display = "none";
    }

    openOverlay(editorOverlay);
  } catch (error: unknown) {
    setStatus(`Failed to load secret ${name}: ${errorMessage(error)}`, true);
  } finally {
    setLoading(false);
  }
}

function closeEditor(): void {
  closeOverlay(editorOverlay);
}

function openDeleteDialog(secretName: string): void {
  state.activeSecret = secretName;
  deleteMessage.textContent = `Delete secret "${secretName}" in namespace "${state.namespace}"?`;
  resetDeleteError();
  openOverlay(deleteOverlay);
}

function closeDeleteDialog(): void {
  closeOverlay(deleteOverlay);
}

async function saveSecret(): Promise<void> {
  if (state.mode === "view") {
    closeEditor();
    return;
  }

  const name = nameInput.value.trim();
  if (!name) {
    editorError.textContent = "Name is required.";
    return;
  }

  let stringData: Record<string, string>;
  let data: Record<string, string>;
  try {
    stringData = parseStringObject(stringDataInput.value || "{}", "String Data");
    data = parseStringObject(dataInput.value || "{}", "Data");
  } catch (error: unknown) {
    editorError.textContent = errorMessage(error);
    return;
  }

  if (!Object.keys(stringData).length && !Object.keys(data).length) {
    editorError.textContent = "Provide at least one key in String Data or Data.";
    return;
  }

  const payload: SecretUpsertRequest = {
    namespace: state.namespace,
    name,
    type: typeSelect.value,
    stringData,
    data,
  };

  const isCreate = state.mode === "create";
  editorError.textContent = "";
  setStatus(`${isCreate ? "Creating" : "Updating"} secret ${name}...`);
  setLoading(true);

  try {
    if (isCreate) {
      await api.createSecret(payload);
    } else {
      await api.updateSecret(name, payload);
    }

    closeEditor();
    setStatus(`Secret ${name} ${isCreate ? "created" : "updated"} in ${state.namespace}.`);
    await loadSecrets();
  } catch (error: unknown) {
    const message = errorMessage(error);
    editorError.textContent = message;
    setStatus(`Failed to save secret ${name}: ${message}`, true);
  } finally {
    setLoading(false);
  }
}

async function deleteSecret(): Promise<void> {
  const name = state.activeSecret;
  if (!name) {
    deleteError.textContent = "No secret selected.";
    return;
  }

  resetDeleteError();
  setStatus(`Deleting secret ${name}...`);
  setLoading(true);
  try {
    await api.deleteSecret(name);
    closeDeleteDialog();
    setStatus(`Secret ${name} deleted from ${state.namespace}.`);
    await loadSecrets();
  } catch (error: unknown) {
    const message = errorMessage(error);
    deleteError.textContent = message;
    setStatus(`Failed to delete secret ${name}: ${message}`, true);
  } finally {
    setLoading(false);
  }
}

filterInput.addEventListener("input", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement) {
    state.filter = target.value;
    renderTable();
  }
});

refreshBtn.addEventListener("click", () => {
  void loadSecrets();
});

newBtn.addEventListener("click", openCreateDialog);
saveBtn.addEventListener("click", () => {
  void saveSecret();
});
closeEditorBtn.addEventListener("click", closeEditor);

confirmDeleteBtn.addEventListener("click", () => {
  void deleteSecret();
});
cancelDeleteBtn.addEventListener("click", closeDeleteDialog);

editorOverlay.addEventListener("click", (event) => {
  if (event.target === editorOverlay) {
    closeEditor();
  }
});

deleteOverlay.addEventListener("click", (event) => {
  if (event.target === deleteOverlay) {
    closeDeleteDialog();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") {
    return;
  }
  if (editorOverlay.classList.contains("open")) {
    closeEditor();
  }
  if (deleteOverlay.classList.contains("open")) {
    closeDeleteDialog();
  }
});

async function bootstrap(): Promise<void> {
  setStatus("Resolving profile namespace...");
  try {
    await loadNamespace();
    await loadSecrets();
  } catch (error: unknown) {
    setStatus(errorMessage(error), true);
  }
}

void bootstrap();
