import type { BetterAuthPlugin } from 'better-auth';

import { BoundedMap } from '../shared/bounded-map';
import type { ConfigValue } from '../types';
import type { CreateAuthOptions } from './types';

// `ctx` is dropped outright: it changes every request and would defeat
// memoisation entirely if it were part of the key.
const NEVER_KEYED = new Set(['ctx']);

// Secret-bearing fields: `options.secret` and `google.clientSecret` are
// documented option-level inputs (not only sourced from `env`), so two
// calls differing only in one of these must still miss the cache — sharing
// an instance built with the wrong secret would sign and verify sessions
// against the wrong tenant. The raw value never enters the key: each
// distinct string seen in an isolate gets an opaque, non-reversible marker
// instead, so the key still distinguishes configurations without leaking
// the secret into it.
const SECRET_LIKE_KEYS = new Set(['secret', 'clientSecret', 'connectionString']);

const MAX_TRACKED_SECRETS = 16;
const secretMarkers = new BoundedMap<string, number>(MAX_TRACKED_SECRETS);
const secretMarkerCounter = { next: 0 };

function secretMarker(value: string): string {
  let id = secretMarkers.get(value);
  if (id === undefined) {
    secretMarkerCounter.next += 1;
    id = secretMarkerCounter.next;
    secretMarkers.set(value, id);
  }
  return `secret#${String(id)}`;
}

// Past this depth (deep plugin configs, nested escape-hatch options) a
// plain object is keyed by identity instead of walked further.
const MAX_DEPTH = 6;

const identities = new WeakMap<object, number>();
const identityCounter = { next: 0 };

// Bindings (KV, D1, Hyperdrive), the `pg` module and other non-plain
// objects are keyed by identity: they are stable for the life of an
// isolate and their contents (a connection string, a namespace handle)
// are neither cheap nor safe to serialise.
function identityKey(value: object): string {
  let id = identities.get(value);
  if (id === undefined) {
    identityCounter.next += 1;
    id = identityCounter.next;
    identities.set(value, id);
  }
  return `#${String(id)}`;
}

function isPlainObject(value: object): value is Record<string, ConfigValue> {
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function keyOf(value: ConfigValue | null, depth: number): string | undefined {
  if (value === undefined) return;
  if (value === null) return 'null';
  if (typeof value === 'function') return;
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => keyOf(item as ConfigValue, depth + 1) ?? '').join(',')}]`;
  }
  if (!isPlainObject(value) || depth >= MAX_DEPTH) return identityKey(value);
  const entries = Object.entries(value)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .filter(([key]) => !NEVER_KEYED.has(key))
    .flatMap(([key, field]) => {
      const entry =
        typeof field === 'string' && SECRET_LIKE_KEYS.has(key)
          ? secretMarker(field)
          : keyOf(field, depth + 1);
      return entry === undefined ? [] : [`${JSON.stringify(key)}:${entry}`];
    });
  return `{${entries.join(',')}}`;
}

// Plugins are keyed by id: a plugin object is typically rebuilt inline on
// every request (`plugins: [organization()]`), so walking or identifying
// it would make every call a cache miss.
function pluginsKey(plugins: BetterAuthPlugin[]): string {
  return `[${plugins.map((plugin) => JSON.stringify(plugin.id)).join(',')}]`;
}

// Cheap, secret-free key for the per-env instance cache. Functions are
// ignored (like `JSON.stringify` did), so an inline options literal with
// inline callbacks still hits the cache; the memoised instance keeps the
// callbacks of the call that built it.
export function getOptionsKey(options?: CreateAuthOptions): string {
  if (!options) return '{}';
  const { plugins, ...rest } = options;
  const base = keyOf(rest, 0) ?? '{}';
  return plugins ? `${base}+${pluginsKey(plugins)}` : base;
}
