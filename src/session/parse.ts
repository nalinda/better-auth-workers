import { asString } from '../shared/as-string';
import type { JsonValue } from '../types';
import type { CachedSessionEntry, SessionData, SessionRecord, SessionUser } from './types';

export function remainingTtlSeconds(expiresAt: string): number {
  const expiresMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresMs)) return 0;
  return Math.floor((expiresMs - Date.now()) / 1000);
}

function isObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toSessionRecord(value: JsonValue | undefined): SessionRecord | null {
  if (!isObject(value)) return null;
  const id = asString(value.id);
  const token = asString(value.token);
  const userId = asString(value.userId);
  const expiresAt = asString(value.expiresAt);
  if (!id || !token || !userId || !expiresAt) return null;
  return { ...value, id, token, userId, expiresAt };
}

function toSessionUser(value: JsonValue | undefined): SessionUser | null {
  if (!isObject(value)) return null;
  const id = asString(value.id);
  if (!id) return null;
  return { ...value, id };
}

export function toSessionData(value: JsonValue | undefined): SessionData | null {
  if (!isObject(value)) return null;
  const session = toSessionRecord(value.session);
  const user = toSessionUser(value.user);
  if (!session || !user) return null;
  return { session, user };
}

export function toCachedEntry(value: JsonValue | undefined): CachedSessionEntry | null {
  if (!isObject(value) || !Array.isArray(value.credentials)) return null;
  const credentials = value.credentials.filter((item): item is string => typeof item === 'string');
  const session = toSessionData(value.session);
  if (!session) return null;
  return { credentials, session };
}
