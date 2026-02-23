import type { SecretDetail } from './models';

export function parseJSONStringMap(raw: string, fieldName: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${fieldName} must be valid JSON.`);
  }

  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error(`${fieldName} must be a JSON object.`);
  }

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!key.trim()) {
      throw new Error(`${fieldName} contains an empty key.`);
    }
    if (typeof value !== 'string') {
      throw new Error(`${fieldName} values must be strings.`);
    }
    out[key] = value;
  }
  return out;
}

export function normalizeStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') {
      out[key] = raw;
    }
  }
  return out;
}

export function stringMapToLines(value: unknown): string {
  const normalized = normalizeStringMap(value);
  const keys = Object.keys(normalized).sort((left, right) => left.localeCompare(right));
  if (!keys.length) {
    return '-';
  }
  return keys.map((key) => `${key}: ${normalized[key] ?? ''}`).join('\n');
}

export function detailManagedByLabel(detail: SecretDetail): string {
  const labels = normalizeStringMap(detail.labels);
  return labels['managed-by'] ?? '-';
}

export function stringMapKeys(value: unknown): string {
  const keys = Object.keys(normalizeStringMap(value)).sort();
  if (!keys.length) {
    return '-';
  }
  return keys.join(', ');
}

export function prettyJSON(value: unknown, fallback = '{}'): string {
  if (!value || typeof value !== 'object') {
    return fallback;
  }
  return JSON.stringify(value, null, 2);
}

export function buildFilterID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function resolveErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unknown error';
}
