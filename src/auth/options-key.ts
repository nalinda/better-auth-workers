import type { BetterAuthPlugin } from 'better-auth';

import type { ConfigValue } from '../types';
import type { CreateAuthOptions } from './types';

// Fields whose value must never end up in the in-memory cache key. `ctx`
// changes every request and would defeat memoisation; the rest are secrets.
// Two option sets differing only in a secret share an instance, which is
// fine: the key identifies a configuration's shape, and secrets come from
// `env`, which the cache is already scoped to.
const EXCLUDED_KEYS = new Set(['ctx', 'secret', 'clientSecret', 'connectionString']);

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
    .filter(([key]) => !EXCLUDED_KEYS.has(key))
    .flatMap(([key, field]) => {
      const entry = keyOf(field, depth + 1);
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
