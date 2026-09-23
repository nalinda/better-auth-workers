# better-auth-workers

[Better Auth](https://better-auth.com) on Cloudflare Workers, without the parts you would otherwise write by hand: a per-request auth instance built from your bindings, Postgres through Hyperdrive or D1 as the primary store, KV for session caching and rate limiting, phone OTP with delivery you control, and a session client so other Workers can trust the same login over a service binding.

It is a thin layer. Better Auth's options, plugins and clients are all still yours to use directly. This package only handles the Workers-specific plumbing and the cross-Worker session contract.

## Contents

- [Why this exists](#why-this-exists)
- [Features](#features)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Storage](#storage)
- [Sessions and rate limiting on KV](#sessions-and-rate-limiting-on-kv)
- [Phone OTP](#phone-otp)
- [Google sign-in](#google-sign-in)
- [Magic link sign-in](#magic-link-sign-in)
- [Restricting sign-in methods](#restricting-sign-in-methods)
- [Using sessions from another Worker](#using-sessions-from-another-worker)
- [Banning users from another Worker](#banning-users-from-another-worker)
- [Non-browser clients](#non-browser-clients)
- [Migrations](#migrations)
- [Routing](#routing)
- [Local development](#local-development)
- [Test mode](#test-mode)
- [Compatibility](#compatibility)
- [FAQ](#faq)
- [Contributing](#contributing)
- [License](#license)

## Why this exists

Better Auth assumes a long-lived process where the auth instance is created once at module scope. Workers do not work that way:

- **Bindings only exist inside the request.** The database, KV namespace and secrets arrive on `env`, so the auth instance has to be built per request and memoised carefully.
- **Memory is per isolate.** Anything Better Auth keeps in memory, such as rate-limit counters, is invisible to the next isolate. That state has to live in KV.
- **Database connections are per request.** A Postgres pool cannot be shared across requests on Workers. It is created from the Hyperdrive connection string inside the handler and released after the response.
- **Sessions are checked by other Workers.** In a Workers architecture the auth Worker is usually not the one serving the API. The API Worker needs a cheap, cached way to ask "who is this?" over a service binding.

This package does those four things and stops.

## Features

- `createAuth(env, options)`: a Better Auth instance built from Workers bindings. The D1 path memoises it per `env`; the Hyperdrive path builds it fresh per request for pool safety.
- **Postgres via Hyperdrive** using the `pg` driver, or **D1**. Pass the binding; no ORM, no schema file.
- **KV secondary storage** for session caching and the built-in rate limiter, wired up for you.
- **Phone OTP** through Better Auth's phone-number plugin with a `sendOTP` you implement, run under `waitUntil` so delivery latency never leaks into the response.
- **Magic-link sign-in** through Better Auth's magic-link plugin with a `sendMagicLink` you implement, run under `waitUntil` the same way.
- **Google sign-in** configured from secrets.
- **Per-Worker sign-in methods**: each method is opt-in, so a Worker accepts only the ones it configures, for example social-only for an internal app.
- **`createSessionClient`** for other Workers: verify a session over a service binding, cache it in KV, and get a Hono `requireSession()` middleware.
- **Bearer tokens** for mobile and CLI clients through Better Auth's bearer plugin.
- **SQL migrations shipped in the package** for both Postgres and SQLite, covering the default schema.
- Typed `Env` for the bindings the package reads, and a configuration check on the first `createAuth` call that names every missing binding at once, rather than failing one at a time as requests reach them.

## Installation

```sh
npm install better-auth better-auth-workers
npm install -D @cloudflare/workers-types
```

Until the package is on npm, install the tarball attached to a [GitHub release](https://github.com/nalinda/better-auth-workers/releases) (v0.4.0 and later carry one). It is the same file npm would serve, with `dist/` already built, so there is no build step and no install script. Pin the exact version in the URL:

```sh
bun add https://github.com/nalinda/better-auth-workers/releases/download/v0.4.0/better-auth-workers-0.4.0.tgz
```

Installing from a git URL does not work: `dist/` is built at release time and not committed.

The package's type declarations reference the Workers runtime globals (`KVNamespace`, `D1Database`, `Hyperdrive`) through `@cloudflare/workers-types`, so it has to be installed for them to resolve, even in a project that generates its own binding types with `wrangler types`.

Postgres deployments also need the driver:

```sh
npm install pg
```

D1 deployments need nothing else.

## Quick start

A Worker that serves `/auth/*` with phone OTP and Google sign-in, backed by Postgres through Hyperdrive and KV.

**wrangler.jsonc**

```jsonc
{
  "name": "auth",
  "main": "src/index.ts",
  "compatibility_date": "2026-07-16",
  "compatibility_flags": ["nodejs_compat"],
  "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<hyperdrive-id>" }],
  "kv_namespaces": [{ "binding": "AUTH_KV", "id": "<kv-id>" }],
  "vars": { "AUTH_BASE_URL": "https://example.com" },
}
```

Secrets, set with `wrangler secret put`:

| Secret                 | Purpose                                     |
| ---------------------- | ------------------------------------------- |
| `BETTER_AUTH_SECRET`   | Signs cookies and tokens. 32+ random bytes. |
| `GOOGLE_CLIENT_ID`     | Google OAuth client id.                     |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret.                 |

**src/index.ts**

```ts
import { Hono } from 'hono';
import pg from 'pg';
import { createAuth, type AuthEnv } from 'better-auth-workers';

type Env = AuthEnv & {
  // any extra bindings your sendOTP needs
  SMS: Fetcher;
};

const app = new Hono<{ Bindings: Env }>();

app.on(['GET', 'POST'], '/auth/*', (c) => {
  const auth = createAuth(c.env, {
    basePath: '/auth',
    database: { hyperdrive: c.env.HYPERDRIVE, pg },
    kv: c.env.AUTH_KV,
    phone: {
      sendOTP: async ({ phoneNumber, code }) => {
        await c.env.SMS.fetch('https://sms/send', {
          method: 'POST',
          body: JSON.stringify({ to: phoneNumber, text: `Your code is ${code}` }),
        });
      },
    },
    google: true,
  });
  // Pass the request's ExecutionContext on every call: delivery (sendOTP,
  // sendMagicLink) is scheduled on it through waitUntil.
  return auth.handler(c.req.raw, c.executionCtx);
});

export default app;
```

That is a complete auth Worker. Better Auth's routes are served under `/auth/*`, users and accounts live in Postgres, sessions live in KV, and OTP codes go wherever your `sendOTP` sends them.

On the browser side use Better Auth's own client:

```ts
import { createAuthClient } from 'better-auth/client';
import { phoneNumberClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({
  baseURL: 'https://example.com/auth',
  plugins: [phoneNumberClient()],
});

await authClient.phoneNumber.sendOtp({ phoneNumber: '+15555550123' });
await authClient.phoneNumber.verify({ phoneNumber: '+15555550123', code: '123456' });
```

## Configuration

`createAuth(env, options)` returns a Better Auth instance. The D1 path memoises the instance per `env` (and per shape of `options`), so calling it on every request is free after the first call in an isolate. The Hyperdrive path builds a fresh instance per request for pool safety: each one wraps a fresh `pg` Pool that is released after its request (see [Storage](#storage)).

**Callbacks on the memoised D1 path.** The cache key ignores functions, so the memoised instance keeps the callback options (`sendOTP`, `sendMagicLink`, `betterAuth.hooks`, `plugins`) of whichever request first built it, for the life of the isolate. Keep this in mind:

- Callbacks must not close over per-request state (a request-scoped value, a per-request client). Read what they need from `env`, from their own arguments, or from the request they are given. `ExecutionContext` is the one exception — see below.
- Objects are also part of the cache key, by identity: a wrapped `kv` or any class instance under `betterAuth` (a custom `secondaryStorage`, say). Constructing one inline on every request defeats memoisation, since each call then builds a new instance (the cache keeps only the most recent shapes). Build such objects once, or pass the raw bindings.

**Execution context.** Call `auth.handler(request, ctx)` with the request's `ExecutionContext` on every request — Cloudflare's own `c.executionCtx` or `ctx` argument. (The package exports its own narrower shape of this as `WaitUntilContext`, distinct from the global `ExecutionContext` that `@cloudflare/workers-types` declares.) Work the package schedules through `waitUntil` — OTP and magic-link delivery, pool cleanup — runs on the context given to `handler`. `options.ctx` is only a fallback for callers that cannot pass one, refreshed on each `createAuth` call for a memoised instance. If a delivery runs with no context at all, the package logs a warning once per instance; the runtime may cancel that delivery once the response is sent, so treat the warning as a misconfiguration to fix.

**Typos are caught.** `CreateAuthOptions` is a closed type: a misspelled key (`magicLinks:` for `magicLink:`) is a type error, not a silently ignored option. This holds inside `betterAuth` too — it's typed against Better Auth's own options (`Partial<BetterAuthOptions>`), so `betterAuth: { rateLimt: { enabled: false } }` won't compile. The one exception is the four fields this package builds and merges itself (`database`, `plugins`, `secondaryStorage`, `hooks`); those stay loosely typed under `betterAuth`, since the package's own resolved values for them don't match Better Auth's stricter shapes.

| Option           | Type                                                                                     | Default                  | Description                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `basePath`       | `string`                                                                                 | `'/api/auth'`            | Path prefix the Worker serves Better Auth under.                                                                                   |
| `baseURL`        | `string`                                                                                 | `env.AUTH_BASE_URL`      | Public origin used for callbacks and cookies.                                                                                      |
| `secret`         | `string`                                                                                 | `env.BETTER_AUTH_SECRET` | Signing secret.                                                                                                                    |
| `database`       | `{ hyperdrive: Hyperdrive, pg, schema? } \| { d1: D1Database } \| D1Database`            | required                 | Primary store; a bare D1 binding is shorthand for `{ d1 }`. See [Storage](#storage).                                               |
| `kv`             | `KVNamespace`                                                                            | required                 | Secondary storage for sessions and rate limiting.                                                                                  |
| `phone`          | `{ sendOTP, otpLength?, expiresIn?, allowedAttempts?, signUpOnVerification? }`           | off                      | Enables the phone-number plugin. See [Phone OTP](#phone-otp).                                                                      |
| `google`         | `boolean \| { clientId, clientSecret }`                                                  | off                      | Enables Google sign-in. `true` reads the secrets from `env`.                                                                       |
| `magicLink`      | `{ sendMagicLink, expiresIn?, disableSignUp? }`                                          | off                      | Enables magic-link sign-in. See [Magic link sign-in](#magic-link-sign-in).                                                         |
| `bearer`         | `boolean`                                                                                | `false`                  | Enables the bearer plugin for non-browser clients.                                                                                 |
| `idType`         | `'text' \| 'uuid'`                                                                       | `'text'`                 | How ids are generated. See [Custom schema and UUID ids](#custom-schema-and-uuid-ids).                                              |
| `allowedMethods` | `Array<'phone' \| 'google' \| 'magic-link'>`                                             | all enabled              | **Deprecated.** Configure only the methods to accept instead. See [Restricting sign-in methods](#restricting-sign-in-methods).     |
| `plugins`        | `BetterAuthPlugin[]`                                                                     | `[]`                     | Extra Better Auth plugins, appended after the built-in ones (`betterAuth.plugins` is appended the same way, never replacing them). |
| `testMode`       | `{ otpCode?, google? }`                                                                  | off                      | Deterministic phone codes and a Google stub for end-to-end tests. Localhost only. See [Test mode](#test-mode).                     |
| `betterAuth`     | `Partial<BetterAuthOptions>` (loose for `database`/`plugins`/`secondaryStorage`/`hooks`) | `{}`                     | Escape hatch. Merged last, so it can override anything above.                                                                      |
| `ctx`            | `WaitUntilContext`                                                                       | none                     | Fallback context for `waitUntil` work; `auth.handler(request, ctx)` takes precedence.                                              |

**Package defaults under `betterAuth`.** This package sets five Better Auth settings for you: session cookie caching (`session.cookieCache.enabled: true`), the rate limiter turned on and pointed at KV (`rateLimit.enabled: true`, `rateLimit.storage: 'secondary-storage'` — left to itself, Better Auth would leave the limiter off in a deployed Worker), schema validation off (`advanced.database.validateSchema: false`), and client-IP resolution that prefers Cloudflare's unspoofable header (`advanced.ipAddress.ipAddressHeaders: ['cf-connecting-ip', 'x-forwarded-for']`).

You don't lose the ability to override any of it. Whatever you set under `betterAuth.session`, `betterAuth.rateLimit` or `betterAuth.advanced` merges over these defaults field by field, so you only state what you want to change — for example `betterAuth: { rateLimit: { storage: 'memory' } }`. `betterAuth.socialProviders` merges the same way, per provider: `{ socialProviders: { google: { scope: [...] } } }` adds to the `google` config this package already resolved from `env`, rather than replacing it, and adding a provider it never configured (`github`, say) just works. `betterAuth.hooks` compose with the package's own hooks (cache invalidation, and method restriction when the deprecated `allowedMethods` is set), which always run first.

Everything not listed is Better Auth's default. Session lifetime, cookie attributes, OTP length and attempts are all Better Auth's defaults unless you change them through `phone` or `betterAuth`.

## Storage

### Postgres through Hyperdrive

```ts
import pg from 'pg';

database: {
  hyperdrive: env.HYPERDRIVE;
  pg;
}
```

A `pg` Pool is created per request from `env.HYPERDRIVE.connectionString` with a small `max`, handed to Better Auth, and ended after the response through `waitUntil`. Better Auth talks to it through its bundled Kysely dialect; you never write a query.

Because the pool is per request, so is the instance: the Hyperdrive path is not memoised, and each instance serves exactly one `auth.handler` call. A second `handler` call on the same instance is refused with an error rather than running against the released pool — call `createAuth(env, options)` again for each request. The pool is only released by `handler`; a Worker that calls `auth.api.*` directly on a Hyperdrive instance owns the pool it created (`auth.options.database`) and must `end()` it itself.

To keep the auth tables out of `public` (for example when `public` is exposed through PostgREST), set `schema`. See [Custom schema and UUID ids](#custom-schema-and-uuid-ids).

The Worker imports `pg` and passes it in because Workers are bundled — the bundler only includes modules it sees imported, so the package can't load the driver on your behalf without forcing it on D1 deployments too. Hyperdrive keeps the real connections warm on Cloudflare's side, so these per-request pools stay cheap.

### D1

```ts
database: {
  d1: env.DB;
}
```

Better Auth's D1 dialect is used directly. D1 has a free tier that comfortably covers a small application's auth traffic, so a Worker that has no other database can still run full auth. For local development with `wrangler dev`, apply migrations to the local database first: `wrangler d1 migrations apply <db> --local`.

### Choosing

Use Postgres when your application data already lives there and you want foreign keys from your tables to the `user` table. Use D1 when auth is the only database the Worker needs, or when you want auth data physically separate from application data.

## Sessions and rate limiting on KV

`kv` is required; `createAuth` refuses to start without `options.kv` or `env.AUTH_KV`, even when you supply your own store through `betterAuth.secondaryStorage`, because sign-out invalidation (below) deletes from that namespace. It is wired as Better Auth's secondary storage, which does two things:

- **Session storage.** Sessions are stored in KV, not cached there: the `session` table in Postgres or D1 is not written and is not the source of truth for session state. A session lookup is a KV read, and with cookie caching enabled — this package's default — most requests do not even need that. Two consequences follow. Sessions survive only as long as their KV entry, and revoking one is subject to KV's eventual consistency (see [Using sessions from another Worker](#using-sessions-from-another-worker)).
- **Rate limiter storage.** Better Auth's rate limiter is turned on and pointed at KV, so counters are shared across isolates instead of sitting in per-isolate memory. (Left to itself, Better Auth only enables the limiter when `NODE_ENV` is `production`, which a deployed Worker's `process.env` does not carry.) `betterAuth.rateLimit` tunes or disables it.

Sharing across isolates is best-effort, not exact. Counters are written to KV at most once per second per key — KV refuses faster writes — and kept in memory between writes, so a burst from one client never fails a request outright. Each write merges KV's current count with whatever this isolate counted since its last sync, so isolates counting the same client converge on the true total rather than overwriting each other. Because the counter is a KV read-then-write rather than an atomic increment, and KV is only eventually consistent, concurrent requests across isolates or regions can still undercount briefly and let a burst exceed the configured limit.

For most applications that's fine. If you need a hard per-phone limit on OTP requests, put a Durable Object counter in front of `sendOTP` — the package doesn't do this for you.

The same eventual-consistency applies to one-shot values: consuming an OTP code or a magic-link token is a KV read followed by a delete, not an atomic take. An OTP is still bounded by its attempt counter, but a magic link has none, so two requests opening the same link at nearly the same moment can both succeed and each establish a session. In practice a link is consumed on its first use; if you need a strict single-use guarantee, verify it through a Durable Object instead.

## Phone OTP

Enabling `phone` turns on Better Auth's phone-number plugin. You supply delivery; the package supplies everything else.

```ts
phone: {
  sendOTP: async ({ phoneNumber, code }, request) => {
    // deliver however you like: SMS gateway, WhatsApp, a service binding, an email for testing
  },
  otpLength: 6,        // default 6
  expiresIn: 300,      // seconds, default 300
  allowedAttempts: 3,  // default 3
}
```

What the package does around your function:

- Runs it under `ctx.waitUntil` so the sign-in response returns immediately and delivery time cannot be used to infer whether a number exists.
- Does not queue it. A code that arrives after it expires is worse than no code.
- Rethrows delivery failures into the Worker's logs, but never into the client response.
- Never logs the code.
- Creates the user on the first successful verification of an unknown number. Better Auth needs an email on every user, so it gets `<phoneNumber>@phone.invalid` (a reserved, undeliverable domain) and the number as its name. Override with `signUpOnVerification: { getTempEmail, getTempName? }` if you want a different placeholder.

Phone numbers are validated as E.164 before `sendOTP` is called. If your users type local formats, normalise on the client or in a `betterAuth.hooks.before` hook.

**Delivery over a service binding.** If delivery lives in another Worker, bind it and call it:

```ts
sendOTP: ({ phoneNumber, code }) =>
  env.MESSAGES.fetch('https://messages/otp', {
    method: 'POST',
    body: JSON.stringify({ to: phoneNumber, code }),
  }),
```

Service-binding calls stay inside Cloudflare's network and never traverse the public internet.

## Google sign-in

```ts
google: true;
```

reads `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from `env`. Pass an object to supply them explicitly. Register `<baseURL><basePath>/callback/google` as an authorised redirect URI in the Google Cloud console.

## Magic link sign-in

Enabling `magicLink` turns on Better Auth's magic-link plugin. You supply delivery; the package supplies everything else.

```ts
magicLink: {
  sendMagicLink: async ({ email, url, token }, request) => {
    // deliver however you like: transactional email, a service binding
  },
  expiresIn: 300,       // seconds, default 300
  disableSignUp: false, // default false
}
```

What the package does around your function:

- Runs it under `ctx.waitUntil` so the sign-in response returns immediately and delivery time cannot be used to infer whether an email address is registered.
- Rethrows delivery failures into the Worker's logs, but never into the client response.

No secrets are required beyond the ones already needed for `baseURL` and `secret` — configuration for magic-link sign-in lives entirely in `magicLink`, same as `phone`.

## Restricting sign-in methods

Every sign-in method is opt-in, so a Worker accepts exactly the methods it configures. An internal admin app that should allow Google and nothing else configures only Google, even if other Workers built from the same code also configure phone OTP:

```ts
createAuth(env, { database: env.DB, kv: env.AUTH_KV, google: true });
```

Phone and magic-link routes are not mounted at all, so requests to them get `404`. When several Workers share one options object, build it per Worker and leave out the methods that Worker should not accept.

### `allowedMethods` (deprecated)

`allowedMethods` is deprecated and will be removed in the next major version. It still works, and logs a warning once per isolate. It installs a `before` hook that answers the routes of any listed-out method with `403`, but it only knows the routes this package mounts for `phone`, `google` and `magic-link`. A plugin you add that opens another route into one of those methods is not restricted by it. For example, Better Auth's `oauthPopup` and `oneTap` plugins each start Google sign-in from their own route. Leaving a method unconfigured has no such gap, because the provider or plugin is simply not there.

To migrate, delete `allowedMethods` and remove the options (`phone`, `google`, `magicLink`) for every method it left out. Requests to those methods then get `404` instead of `403`.

## Using sessions from another Worker

Most Workers architectures put auth in one Worker and the API in another. The API needs to know who is calling without owning the auth tables.

Bind the auth Worker as a service:

```jsonc
// api/wrangler.jsonc
"services": [{ "binding": "AUTH", "service": "auth" }],
"kv_namespaces": [{ "binding": "AUTH_KV", "id": "<same-kv-id-as-auth>" }]
```

Then:

```ts
import { Hono } from 'hono';
import {
  createSessionClient,
  type SessionClient,
  type SessionData,
} from 'better-auth-workers/client';

type AppEnv = {
  Bindings: Env;
  Variables: { sessions: SessionClient; session: SessionData };
};

const app = new Hono<AppEnv>();

app.use('*', async (c, next) => {
  const sessions = createSessionClient({
    auth: c.env.AUTH, // service binding
    kv: c.env.AUTH_KV, // the auth Worker's KV namespace
    basePath: '/auth',
  });
  c.set('sessions', sessions);
  await next();
});

app.get('/me', async (c) => {
  const session = await c.get('sessions').get(c.req.raw);
  if (!session) return c.text('Unauthorized', 401);
  return c.json(session.user);
});
```

Or use the middleware. `requireSession` takes the `SessionClient` explicitly — the same per-request `env`-bound instance created above — rather than building its own, so it composes with whatever setup created that client. `client` can be the instance itself or a function of the request context, so the middleware mounts directly on a route and reads the client off the Hono variable set above. It is generic over the app's `Env`; pass the app's type so `c` is typed for that context:

```ts
import { requireSession } from 'better-auth-workers/client';

app.get('/me', requireSession<AppEnv>({ client: (c) => c.get('sessions') }), (c) =>
  c.json(c.get('session').user)
);
```

If the auth Worker cannot be reached (service binding down, or it answers 5xx, 429, or any status other than 2xx/401/403 — a 404 from a wrong `basePath`, say) the middleware responds `503`, not `401`: an outage or a misconfiguration is not "not signed in", and clients should not clear their session over it. `createSessionClient().get` throws `SessionUnavailableError` in that case and returns `null` only for a real negative answer (`401`/`403`).

`requireSession` also accepts a `predicate` for role checks, returning `403` when it fails. Keep in mind that the `user` it sees is the cached copy — a snapshot taken when the session was verified, refreshed only when the cache entry is evicted (sign-out and revocation, below) or expires with the session. A role change, email change, or a profile update that isn't a ban won't evict it, so a demoted user keeps passing a role predicate until then. If that matters for you, keep `session.expiresIn` short, or re-check the user on the auth Worker for sensitive actions.

```ts
app.get(
  '/admin',
  requireSession<AppEnv>({
    client: (c) => c.get('sessions'),
    predicate: (s) => s.user.role === 'admin',
  }),
  (c) => c.json(c.get('session').user)
);
```

How it works:

1. The client forwards the incoming request's `Cookie` (or `Authorization`) header to the auth Worker's `get-session` route over the service binding.
2. The result is cached in KV keyed by the bare session token for the remaining session lifetime, with the credential exactly as presented — the signed `<token>.<signature>` value, whether it arrived as a cookie or as a bearer credential — recorded inside the entry; a read is served from the cache only when its credential matches one the entry recorded, so a cookie with a forged signature never hits an entry a genuine request warmed.
3. Sign-out and session revocation in the auth Worker delete the KV entry — both the cached copy and the session itself, since sessions live in KV — so the API stops seeing the session.

Step 3 covers:

- `/sign-out`, `/revoke-session`, `/revoke-sessions`, `/revoke-other-sessions`
- `/change-password` (when it revokes other sessions)
- `/delete-user` and its callback
- the admin plugin's `/admin/revoke-user-session`, `/admin/revoke-user-sessions`, `/admin/remove-user`, `/admin/ban-user`, `/admin/update-user` (when it sets `banned: true`), and `/admin/stop-impersonating`

A route that revokes every session of a user lists that user's sessions before the revocation and clears each cache entry afterward. Not covered: the password-reset routes (`/reset-password`, `/phone-number/reset-password` with `revokeSessionsOnPasswordReset`), since they identify the user by a one-time token rather than a session — and sessions that simply expire, whose cache entries just expire along with them.

Sharing the KV namespace between the two Workers is what makes step 3 work. Using separate namespaces still functions, but revocation is only visible after the cache entry expires.

Revocation is not instant either way. KV is eventually consistent: a delete propagates across Cloudflare's points of presence in up to about 60 seconds, so a request reaching a location that still holds the old value can be served with the revoked session until then. The location that handled the revocation sees it immediately; the rest catch up. If you need a session to be unusable everywhere the moment it is revoked, keep a revocation check in a Durable Object and consult it on the requests that matter — the package does not do this for you.

## Banning users from another Worker

Better Auth's admin routes need an admin's browser session. A backend Worker with no such session, such as an API Worker enforcing a moderation decision, can ban and unban users over a service binding instead, through an RPC entrypoint the auth Worker exports:

```ts
// auth Worker
import { createAuth } from 'better-auth-workers';
import { createAuthAdmin } from 'better-auth-workers/admin';

const authOptions = (env: Env) => ({/* the same options you pass to createAuth */});

app.on(['GET', 'POST'], '/auth/*', (c) =>
  createAuth(c.env, authOptions(c.env)).handler(c.req.raw, c.executionCtx)
);

export const AuthAdmin = createAuthAdmin(authOptions);
export default app;
```

Bind the calling Worker to that entrypoint, and only that Worker:

```jsonc
// the API Worker's wrangler.jsonc
"services": [{ "binding": "AUTH_ADMIN", "service": "auth", "entrypoint": "AuthAdmin" }]
```

```ts
import type { AuthAdminRpc } from 'better-auth-workers/client';

interface Env {
  AUTH_ADMIN: AuthAdminRpc;
}

await env.AUTH_ADMIN.banUser(userId, { reason: 'abuse', expiresIn: 7 * 24 * 3600 }); // { found, revokedSessions }
await env.AUTH_ADMIN.unbanUser(userId); // { found }
```

`banUser` does what the admin plugin's ban does: it sets `banned`, `banReason` (default `'No reason'`) and `banExpires` (permanent without `expiresIn`, in seconds), and revokes every session the user has. It also deletes each of those sessions from the session client's KV cache, so `requireSession` in any Worker sharing the namespace refuses the user on their next request. Other Cloudflare locations can take up to about 60 seconds to see a KV delete; to close that gap, re-check `banned` on each request against the source of truth (your database, or the auth Worker), not on `session.user` in a `requireSession` predicate, which comes from the same cache. A banned user who tries to sign in gets `BANNED_USER`. `unbanUser` clears all three fields. Both return `found: false` and change nothing for an unknown id.

The binding is the authorisation. There's no HTTP route and no shared secret, so only Workers you bind to the `AuthAdmin` entrypoint can call it. A gateway Worker that forwards `/auth/*` should bind the auth Worker's default entrypoint only. On the Hyperdrive path each call opens and releases its own pool.

## Non-browser clients

Enable the bearer plugin:

```ts
bearer: true;
```

Clients then receive the session token in a `set-auth-token` response header after sign-in and send it back as `Authorization: Bearer <token>`. Send that header value back exactly as it arrived. It is signed, and only the signed value counts as a credential. The bare `session.token` you can see in a sign-in response body is not one: a request carrying it is treated as having no credential at all. `createSessionClient` accepts either cookies or bearer tokens.

## Migrations

The package ships the SQL for Better Auth's default schema plus the plugins it enables (phone number, admin, bearer, magic link — the last adds no tables of its own):

```
node_modules/better-auth-workers/migrations/postgres/0001_init.sql
node_modules/better-auth-workers/migrations/sqlite/0001_init.sql
```

Apply them with whatever you already use. For D1:

```sh
cp node_modules/better-auth-workers/migrations/sqlite/*.sql migrations/
wrangler d1 migrations apply <db>
```

For local development against `wrangler dev`:

```sh
wrangler d1 migrations apply <db> --local
```

For Postgres, copy the file into your migration tool's directory and record the package version in a comment so upgrades are traceable. If you set `database.schema` or `idType`, generate the SQL instead (see below).

If you add plugins through `plugins`, their tables are not in the shipped SQL. Generate them with Better Auth's CLI against your config:

```sh
npx @better-auth/cli generate --config src/auth.config.ts
```

### Custom schema and UUID ids

On Postgres, two options change the schema, and the SQL has to match them:

```ts
createAuth(env, {
  database: { hyperdrive: env.HYPERDRIVE, pg, schema: 'auth_ba' },
  idType: 'uuid',
  // ...
});
```

- **`database.schema`** puts the tables in their own Postgres schema. Better Auth qualifies every query with it (`"auth_ba"."user"`), so nothing depends on the connection's `search_path`. The name must be a lower-case identifier: letters, digits and underscores.
- **`idType: 'uuid'`** makes every id a UUID. On Postgres the id columns are `uuid` with a `gen_random_uuid()` default, and the database generates each id. The `userId` columns that reference `user.id` are `uuid` too, so your own tables can reference users with a `uuid` foreign key. Rows you insert yourself, for example existing users migrated with the ids your tables already hold, can carry any UUID.

Generate the SQL for those options with the package's CLI, and apply it like the shipped migration:

```sh
bunx better-auth-workers sql --schema auth_ba --id-type uuid > migrations/0001_auth.sql
```

The output comes from Better Auth's own migration generator, for the same plugins as the shipped SQL. With no options it prints the same statements as the shipped `migrations/postgres/0001_init.sql`. Schema names starting with `pg_` are reserved by Postgres and refused.

On D1 there are no schemas, so `database.schema` is rejected. `idType: 'uuid'` works with the shipped SQLite migration as is: Better Auth generates each UUID itself and stores it in the `text` id column.

With `idType: 'uuid'` on Postgres, an id that is not a UUID sent to an endpoint that takes one (an admin endpoint's `userId`, say) reaches Postgres as is and fails there with a 500, where a text id would have been a 404.

Changing `idType` on an existing database changes how new ids are made, not the ones already stored. On Postgres, moving from `text` to `uuid` also means migrating the columns yourself.

Schema changes in this package are always a major version bump.

## Routing

The auth Worker should be same-origin with the app that sets its cookies. Two ways:

- **Cloudflare route.** Route `example.com/auth/*` to the auth Worker and everything else to your app. No code involved.
- **Proxy through the app Worker.** Bind the auth Worker as a service and forward `/auth/*` to it. Useful when the app Worker already fronts everything.

Cross-origin deployments work with Better Auth's `trustedOrigins` and cross-subdomain cookie settings, passed through `betterAuth`, but same-origin is simpler and is the tested path.

## Local development

`wrangler dev` runs the Worker locally with local bindings.

- **D1**: `wrangler dev` uses a local SQLite file automatically. Apply migrations with `wrangler d1 migrations apply <db> --local`.
- **Postgres**: point the Hyperdrive binding's `localConnectionString` at a local Postgres in the `hyperdrive` environment of `wrangler.jsonc` (as the example does). Hyperdrive is bypassed locally.
- **KV**: local automatically.
- **OTP**: a `sendOTP` that logs the code to the console is enough for local work. Do not ship it.

The `examples/hono` directory contains a runnable auth Worker with both storage options, plus a second API Worker that consumes its sessions over a service binding; its README covers running both together.

## Test mode

An end-to-end suite (Playwright, say) can't read a real SMS or sign in to a real Google account. Test mode replaces both with deterministic stand-ins:

```ts
createAuth(env, {
  phone: { sendOTP },
  google: true,
  // Only in the environment the e2e suite runs against.
  testMode: env.MOCK_AUTH ? { otpCode: '123456', google: true } : undefined,
});
```

- **`otpCode`** (4 to 10 digits): every phone verification accepts this code, and `sendOTP` is never called. The attempt limit and expiry don't apply, because no stored code is checked. Requires `phone`.
- **`google`**: Google sign-in goes through an in-process stub instead of Google. The client calls `authClient.signIn.social({ provider: 'google', loginHint: 'alice@example.com' })` exactly as in production. The stub's authorize page redirects straight back and signs in the address named by `loginHint`, with a stable account id (`test-<email>`), or `test.user@example.com` without one. A `loginHint` of `error:access_denied` (or any `error:<code>`) comes back as a refused consent screen does; any other hint must be an email address. No Google credentials are needed, and nothing leaves the Worker. The stub replaces Google entirely, so Google-specific options (`prompt`, `hd`, `disableImplicitSignUp`) don't apply, and sign-in with a Google ID token (`signIn.social({ provider: 'google', idToken })`) isn't supported.

Both let anyone sign in as anyone, so test mode only runs on localhost:

- `createAuth` throws at startup unless every base URL it could use (`baseURL`, `env.AUTH_BASE_URL`, `betterAuth.baseURL`) is `http://` on a loopback host: `localhost`, `*.localhost`, `127.x.x.x` or `[::1]`.
- While test mode is on, the instance refuses every call that names a host other than a loopback one, on any route, with a 403 (`TEST_MODE_LOCALHOST_ONLY`). Requests into `auth.handler` are judged by their URL. Server-side `auth.api` calls that forward headers (`auth.api.x({ body, headers: request.headers })`) are judged by `host` and `x-forwarded-host`, and refused if the headers name no host at all. That holds even if a deployed Worker were started with a localhost base URL. Only a server-side call with no headers, the Worker's own code, is let through.
- `testMode.otpCode` requires `phone`, and `testMode.google` requires `google`: test mode stands in for methods the deployment has, and never adds one.
- Anything that forwards requests to a test-mode auth Worker (a gateway, a service binding) must keep a loopback or `*.localhost` host in the URL: pass the request through as it is rather than rebuilding it on another hostname, or test mode answers 403, which a session client reads as "signed out". `createSessionClient` already sends its requests as `https://auth.localhost/...`.
- `wrangler dev` rewrites every request's host to the Worker's first `route` or `routes` entry (or custom domain), if its config has one, and both keys are inherited by named environments. Test mode then refuses everything with 403 while the startup guard passes. To keep localhost for the e2e environment: pass `--local-upstream localhost:8787` to `wrangler dev`, or give that environment its own empty value for whichever of `route`/`routes` the top level sets. Setting `dev.host` to `localhost` also works, but `dev` is read only from the top level, so it applies to every `wrangler dev`.
- It checks the host a request names, not where it came from. That is enough behind the startup guard, since a deployed route never names a loopback host, but don't run `wrangler dev --ip 0.0.0.0` with test mode on a network you don't trust.
- A warning is logged once per isolate while it is on.

## Compatibility

| Dependency                | Version         |
| ------------------------- | --------------- |
| better-auth               | ^1.7            |
| wrangler                  | ^4              |
| Compatibility flags       | `nodejs_compat` |
| @cloudflare/workers-types | >=4             |
| pg (Postgres only)        | ^8              |
| hono (middleware only)    | ^4              |

`@cloudflare/workers-types` is a peer dependency the package's declarations depend on: install it explicitly (see [Installation](#installation)), since `wrangler types` alone does not provide the globals they reference. Hono is an optional peer dependency. `createAuth` and `createSessionClient` work with any framework that gives you a `Request`; only `requireSession()` needs Hono.

## FAQ

**How is this different from better-auth-cloudflare?**
That package integrates Better Auth with Cloudflare through Drizzle and adds geolocation and R2 helpers. This one uses `pg` or D1 directly with no ORM, ships SQL rather than a schema file, and adds the cross-Worker session client. Pick whichever matches how you already access your database.

**Why is the auth instance created per request?**
Because bindings arrive on `env`, which only exists inside the handler. On D1 the instance is memoised per `env` object, so within an isolate the cost is paid once. On Hyperdrive it is rebuilt per request on purpose, since the `pg` Pool it wraps is per request too.

**Can I use Better Auth features this package does not mention?**
Yes — `plugins` and `betterAuth` pass straight through, and the package doesn't hide or rename anything in Better Auth. `auth.api` is typed with the endpoints of the plugins the package builds: admin always, phone number and magic link when you set their option. If your options don't configure a method, calling its endpoint is a type error rather than a runtime surprise — its plugin isn't registered, so the endpoint really is absent, just as it would be on Better Auth's own instance.

**Does it manage users, roles or organisations?**
Only through Better Auth's own plugins. The admin plugin is always on, with no way to turn it off — that's why the shipped migrations include its columns (`role`, `banned`, `banReason`, `banExpires`, `impersonatedBy`), and why the session-invalidation hooks can rely on its routes for admin-triggered revocation (see [Using sessions from another Worker](#using-sessions-from-another-worker)). Organisations, passkeys, multi-session and MFA are Better Auth plugins you can add yourself through `plugins`.

**Is the rate limiter safe for OTP?**
It is shared across isolates through KV, which is what most applications need. It is not a hard limit because KV is eventually consistent. See [Sessions and rate limiting on KV](#sessions-and-rate-limiting-on-kv).

## Contributing

Issues and pull requests are welcome. Please open an issue before a large change so the design can be discussed first. Development uses Bun for tests and wrangler for the example Worker:

```sh
bun install
bun test
bun run --cwd examples/hono dev
```

## License

MIT. See [LICENSE](LICENSE).
