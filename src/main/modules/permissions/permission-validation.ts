import { createHash } from 'node:crypto';

export class PermissionError extends Error {
  constructor(readonly code: string, readonly currentRevision?: number) { super(code); }
}
export function permissionObject(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).some(key => !allowed.includes(key))) throw new PermissionError('INVALID_REQUEST');
  return raw as Record<string, unknown>;
}
export function permissionId(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(raw)) throw new PermissionError('INVALID_REQUEST');
  return raw;
}
export function permissionText(raw: unknown, max = 1000): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(raw)) throw new PermissionError('INVALID_REQUEST');
  return raw;
}
export function permissionInteger(raw: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(raw) || (raw as number) < 0 || (raw as number) > max) throw new PermissionError('INVALID_REQUEST');
  return raw as number;
}
export function permissionDate(raw: unknown): string {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw)
    || !Number.isFinite(Date.parse(raw)) || new Date(raw).toISOString() !== raw) throw new PermissionError('INVALID_REQUEST');
  return raw;
}
/** Canonical JSON binds actual values and is bounded before any durable approval is created. */
export function canonicalPermissionJson(raw: unknown): string {
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): unknown => {
    if (depth > 12) throw new PermissionError('INVALID_REQUEST');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') { if (value.length > 64000 || value.includes('\0')) throw new PermissionError('INVALID_REQUEST'); return value; }
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || !value || seen.has(value)) throw new PermissionError('INVALID_REQUEST');
    seen.add(value);
    try {
      if (Array.isArray(value)) { if (value.length > 200) throw new PermissionError('INVALID_REQUEST'); return value.map(item => visit(item, depth + 1)); }
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new PermissionError('INVALID_REQUEST');
      const keys = Object.keys(value).sort();
      if (keys.length > 100 || keys.some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) throw new PermissionError('INVALID_REQUEST');
      return Object.fromEntries(keys.map(key => [key, visit((value as Record<string, unknown>)[key], depth + 1)]));
    } finally { seen.delete(value); }
  };
  const json = JSON.stringify(visit(raw, 0));
  if (Buffer.byteLength(json, 'utf8') > 64000) throw new PermissionError('INVALID_REQUEST');
  return json;
}
export function permissionHash(raw: unknown): string { return createHash('sha256').update(canonicalPermissionJson(raw)).digest('hex'); }
