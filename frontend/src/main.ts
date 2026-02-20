import { APIClient } from "./api";
import type {
  AppState,
  DetailTab,
  EditorMode,
  FilterField,
  SecretDetail,
  SecretFilter,
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

function clearElement(el: HTMLElement): void {
  while (el.firstChild) {
    el.removeChild(el.firstChild);
  }
}

function mapToLines(obj: Record<string, string>): string {
  const keys = Object.keys(obj);
  if (!keys.length) {
    return "-";
  }
  return keys
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${key}: ${obj[key] ?? ""}`)
    .join("\n");
}

function buildFilterID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function fieldLabel(field: FilterField): string {
  switch (field) {
    case "name":
      return "Name";
    case "type":
      return "Type";
    case "createdAt":
      return "Created at";
    default:
      return "Field";
  }
}

const state: AppState = {
  namespace: "",
  secrets: [],
  loading: false,
  filterField: "name",
  filterValue: "",
  filters: [],
  view: "list",
  detailTab: "overview",
  mode: "create",
  activeSecret: "",
  detail: null,
  events: [],
  yaml: "",
};

const api = new APIClient();

const listView = mustElement<HTMLElement>("listView");
const detailView = mustElement<HTMLElement>("detailView");

const namespaceChip = mustElement<HTMLSpanElement>("namespaceChip");
const refreshBtn = mustElement<HTMLButtonElement>("refreshBtn");
const newBtn = mustElement<HTMLButtonElement>("newBtn");

const filterFieldSelect = mustElement<HTMLSelectElement>("filterFieldSelect");
const filterInput = mustElement<HTMLInputElement>("filterInput");
const addFilterBtn = mustElement<HTMLButtonElement>("addFilterBtn");
const clearFiltersBtn = mustElement<HTMLButtonElement>("clearFiltersBtn");
const filterChips = mustElement<HTMLDivElement>("filterChips");

const statusRow = mustElement<HTMLDivElement>("statusRow");
const rows = mustElement<HTMLTableSectionElement>("secretsRows");

const backToListBtn = mustElement<HTMLButtonElement>("backToListBtn");
const detailSecretName = mustElement<HTMLHeadingElement>("detailSecretName");
const detailStatusRow = mustElement<HTMLDivElement>("detailStatusRow");
const detailEditBtn = mustElement<HTMLButtonElement>("detailEditBtn");
const detailDeleteBtn = mustElement<HTMLButtonElement>("detailDeleteBtn");

const overviewTabBtn = mustElement<HTMLButtonElement>("overviewTabBtn");
const eventsTabBtn = mustElement<HTMLButtonElement>("eventsTabBtn");
const yamlTabBtn = mustElement<HTMLButtonElement>("yamlTabBtn");
const overviewPanel = mustElement<HTMLElement>("overviewPanel");
const eventsPanel = mustElement<HTMLElement>("eventsPanel");
const yamlPanel = mustElement<HTMLElement>("yamlPanel");
const overviewBody = mustElement<HTMLTableSectionElement>("overviewBody");
const eventsRows = mustElement<HTMLTableSectionElement>("eventsRows");
const yamlContent = mustElement<HTMLPreElement>("yamlContent");

const editorOverlay = mustElement<HTMLDivElement>("editorOverlay");
const editorTitle = mustElement<HTMLHeadingElement>("editorTitle");
const editorSubtitle = mustElement<HTMLParagraphElement>("editorSubtitle");
const editorError = mustElement<HTMLDivElement>("editorError");
const closeEditorBtn = mustElement<HTMLButtonElement>("closeEditorBtn");
const saveBtn = mustElement<HTMLButtonElement>("saveBtn");
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

function setDetailStatus(message: string, isError = false): void {
  detailStatusRow.textContent = message;
  detailStatusRow.className = isError ? "status-row error" : "status-row";
}

function setLoading(loading: boolean): void {
  state.loading = loading;
  refreshBtn.disabled = loading;
  newBtn.disabled = loading;
  addFilterBtn.disabled = loading;
  clearFiltersBtn.disabled = loading || state.filters.length === 0;
  detailEditBtn.disabled = loading || !state.activeSecret;
  detailDeleteBtn.disabled = loading || !state.activeSecret;
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

function setView(view: "list" | "detail"): void {
  state.view = view;
  if (view === "list") {
    listView.classList.remove("hidden");
    detailView.classList.add("hidden");
  } else {
    listView.classList.add("hidden");
    detailView.classList.remove("hidden");
  }
}

function setActiveTab(tab: DetailTab): void {
  state.detailTab = tab;
  const tabs: Array<{ button: HTMLButtonElement; panel: HTMLElement; name: DetailTab }> = [
    { button: overviewTabBtn, panel: overviewPanel, name: "overview" },
    { button: eventsTabBtn, panel: eventsPanel, name: "events" },
    { button: yamlTabBtn, panel: yamlPanel, name: "yaml" },
  ];

  for (const current of tabs) {
    const active = current.name === tab;
    current.button.classList.toggle("active", active);
    current.panel.classList.toggle("hidden", !active);
  }
}

function renderFilterChips(): void {
  clearElement(filterChips);
  for (const filter of state.filters) {
    const chip = document.createElement("span");
    chip.className = "chip";

    const text = document.createElement("span");
    text.textContent = `${fieldLabel(filter.field)}: ${filter.value}`;

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "chip-remove";
    removeBtn.textContent = "x";
    removeBtn.setAttribute("aria-label", `Remove ${fieldLabel(filter.field)} filter`);
    removeBtn.addEventListener("click", () => {
      state.filters = state.filters.filter((item) => item.id !== filter.id);
      renderFilterChips();
      renderTable();
      setLoading(state.loading);
    });

    chip.appendChild(text);
    chip.appendChild(removeBtn);
    filterChips.appendChild(chip);
  }
}

function matchesFilter(secret: SecretListItem, filter: SecretFilter): boolean {
  const query = filter.value.trim().toLowerCase();
  if (!query) {
    return true;
  }

  switch (filter.field) {
    case "name":
      return secret.name.toLowerCase().includes(query);
    case "type":
      return secret.type.toLowerCase().includes(query);
    case "createdAt":
      return (
        formatDate(secret.creationTimestamp).toLowerCase().includes(query) ||
        secret.creationTimestamp.toLowerCase().includes(query)
      );
    default:
      return true;
  }
}

function filteredSecrets(): SecretListItem[] {
  if (!state.filters.length) {
    return state.secrets;
  }
  return state.secrets.filter((secret) => {
    return state.filters.every((filter) => matchesFilter(secret, filter));
  });
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
      ? "No managed secrets match the current filters."
      : "No managed secrets found. Create one with + New Secret.";
    tr.appendChild(td);
    rows.appendChild(tr);
    return;
  }

  for (const secret of list) {
    const tr = document.createElement("tr");

    const nameTd = document.createElement("td");
    const nameBtn = document.createElement("button");
    nameBtn.type = "button";
    nameBtn.className = "name-link";
    nameBtn.textContent = secret.name;
    nameBtn.addEventListener("click", () => {
      void openSecretDetails(secret.name);
    });
    nameTd.appendChild(nameBtn);

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

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "action-btn";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => {
      void openEditDialog(secret.name);
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "action-btn danger";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () => {
      openDeleteDialog(secret.name);
    });

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

function renderOverview(detail: SecretDetail): void {
  clearElement(overviewBody);
  const items: Array<[string, string]> = [
    ["Name", detail.name],
    ["Namespace", detail.namespace],
    ["Type", detail.type],
    ["Created at", formatDate(detail.creationTimestamp)],
    ["Managed label", detail.labels["managed-by"] ?? "-"],
    ["String data keys", Object.keys(detail.stringData).sort().join(", ") || "-"],
    ["Data keys", Object.keys(detail.data).sort().join(", ") || "-"],
    ["Labels", mapToLines(detail.labels)],
    ["Annotations", mapToLines(detail.annotations)],
  ];

  for (const [label, value] of items) {
    const tr = document.createElement("tr");

    const key = document.createElement("th");
    key.textContent = label;

    const val = document.createElement("td");
    if (value.includes("\n")) {
      const pre = document.createElement("pre");
      pre.className = "inline-pre";
      pre.textContent = value;
      val.appendChild(pre);
    } else {
      val.textContent = value;
    }

    tr.appendChild(key);
    tr.appendChild(val);
    overviewBody.appendChild(tr);
  }
}

function renderEvents(): void {
  clearElement(eventsRows);
  if (!state.events.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.className = "empty";
    td.colSpan = 6;
    td.textContent = "No events found for this secret.";
    tr.appendChild(td);
    eventsRows.appendChild(tr);
    return;
  }

  for (const event of state.events) {
    const tr = document.createElement("tr");
    const cells = [
      event.type || "-",
      event.reason || "-",
      event.message || "-",
      event.source || "-",
      formatDate(event.lastSeen),
      String(event.count),
    ];
    for (const value of cells) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.appendChild(td);
    }
    eventsRows.appendChild(tr);
  }
}

function applyFilter(): void {
  const value = filterInput.value.trim();
  if (!value) {
    return;
  }

  const field = filterFieldSelect.value as FilterField;
  state.filters.push({ id: buildFilterID(), field, value });
  state.filterValue = "";
  filterInput.value = "";
  renderFilterChips();
  renderTable();
  setLoading(state.loading);
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

async function loadSecretDetails(name: string): Promise<void> {
  setDetailStatus(`Loading details for secret ${name}...`);
  setLoading(true);

  try {
    const [detail, eventsPayload, yamlPayload] = await Promise.all([
      api.getSecret(name),
      api.getSecretEvents(name),
      api.getSecretYAML(name),
    ]);

    state.detail = detail;
    state.events = Array.isArray(eventsPayload.items) ? eventsPayload.items : [];
    state.yaml = yamlPayload.yaml || "";

    renderOverview(detail);
    renderEvents();
    yamlContent.textContent = state.yaml || "# Empty YAML output";
    setDetailStatus(`Loaded details for ${name}.`);
  } catch (error: unknown) {
    state.detail = null;
    state.events = [];
    state.yaml = "";
    renderOverview({
      name,
      namespace: state.namespace,
      type: "-",
      creationTimestamp: "",
      labels: {},
      annotations: {},
      data: {},
      stringData: {},
    });
    renderEvents();
    yamlContent.textContent = "# Failed to load YAML";
    setDetailStatus(`Failed to load details: ${errorMessage(error)}`, true);
  } finally {
    setLoading(false);
  }
}

async function openSecretDetails(name: string): Promise<void> {
  state.activeSecret = name;
  detailSecretName.textContent = name;
  setView("detail");
  setActiveTab("overview");
  await loadSecretDetails(name);
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
  namespaceInput.value = state.namespace;
  nameInput.value = "";
  typeSelect.value = "Opaque";
  stringDataInput.value = '{\n  "username": "example",\n  "password": "secret"\n}';
  dataInput.value = "{}";
  nameInput.disabled = false;
  editorError.textContent = "";
  saveBtn.textContent = "Create";
  openOverlay(editorOverlay);
  setTimeout(() => nameInput.focus(), 10);
}

async function openEditDialog(name: string): Promise<void> {
  editorError.textContent = "";
  setLoading(true);
  try {
    const detail = await api.getSecret(name);
    state.mode = "edit";
    state.activeSecret = detail.name;

    editorTitle.textContent = "Edit Secret";
    editorSubtitle.textContent = "Update values for this managed secret.";
    namespaceInput.value = detail.namespace || state.namespace;
    nameInput.value = detail.name || "";
    nameInput.disabled = true;
    typeSelect.value = detail.type || "Opaque";
    stringDataInput.value = prettyJSON(detail.stringData);
    dataInput.value = prettyJSON(detail.data);
    saveBtn.textContent = "Save";
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
  deleteError.textContent = "";
  openOverlay(deleteOverlay);
}

function closeDeleteDialog(): void {
  closeOverlay(deleteOverlay);
}

async function saveSecret(): Promise<void> {
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
    await loadSecrets();
    setStatus(`Secret ${name} ${isCreate ? "created" : "updated"} in ${state.namespace}.`);
    if (state.view === "detail" && state.activeSecret === name) {
      await loadSecretDetails(name);
    }
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

  deleteError.textContent = "";
  setStatus(`Deleting secret ${name}...`);
  setLoading(true);
  try {
    await api.deleteSecret(name);
    closeDeleteDialog();
    if (state.view === "detail" && state.activeSecret === name) {
      setView("list");
      setDetailStatus("");
    }
    await loadSecrets();
    setStatus(`Secret ${name} deleted from ${state.namespace}.`);
  } catch (error: unknown) {
    const message = errorMessage(error);
    deleteError.textContent = message;
    setStatus(`Failed to delete secret ${name}: ${message}`, true);
  } finally {
    setLoading(false);
  }
}

filterFieldSelect.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) {
    return;
  }
  state.filterField = target.value as FilterField;
});

filterInput.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }
  state.filterValue = target.value;
});

filterInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") {
    return;
  }
  event.preventDefault();
  applyFilter();
});

addFilterBtn.addEventListener("click", applyFilter);

clearFiltersBtn.addEventListener("click", () => {
  state.filters = [];
  renderFilterChips();
  renderTable();
  setLoading(state.loading);
});

refreshBtn.addEventListener("click", () => {
  void loadSecrets();
});

newBtn.addEventListener("click", openCreateDialog);

backToListBtn.addEventListener("click", () => {
  setView("list");
});

detailEditBtn.addEventListener("click", () => {
  if (state.activeSecret) {
    void openEditDialog(state.activeSecret);
  }
});

detailDeleteBtn.addEventListener("click", () => {
  if (state.activeSecret) {
    openDeleteDialog(state.activeSecret);
  }
});

overviewTabBtn.addEventListener("click", () => {
  setActiveTab("overview");
});
eventsTabBtn.addEventListener("click", () => {
  setActiveTab("events");
});
yamlTabBtn.addEventListener("click", () => {
  setActiveTab("yaml");
});

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
  setView("list");
  setActiveTab("overview");
  renderFilterChips();
  setStatus("Resolving profile namespace...");

  try {
    await loadNamespace();
    await loadSecrets();
  } catch (error: unknown) {
    setStatus(errorMessage(error), true);
  }
}

void bootstrap();
