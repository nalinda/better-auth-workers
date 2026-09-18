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
- [Non-browser clients](#non-browser-clients)
- [Migrations](#migrations)
- [Routing](#routing)
- [Local development](#local-development)
- [Compatibility](#compatibility)
- [FAQ](#faq)
- [Contributing](#contributing)
  - [Release process](#release-process)
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
- **Google sign-in** configured from secrets.
- **Sign-in method restriction** per deployment, for example social-only for an internal app.
- **`createSessionClient`** for other Workers: verify a session over a service binding, cache it in KV, and get a Hono `requireSession()` middleware.
- **Bearer tokens** for mobile and CLI clients through Better Auth's bearer plugin.
- **SQL migrations shipped in the package** for both Postgres and SQLite, covering the default schema.
- Typed `Env` for the bindings the package reads, and a configuration check on the first `createAuth` call that names every missing binding at once, rather than failing one at a time as requests reach them.

## Installation

```sh
npm install better-auth better-auth-workers
npm install -D @cloudflare/workers-types
```

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

That is a complete auth Worker. Better Auth's routes are served under `/auth/*`, sessions are stored in Postgres and cached in KV, and OTP codes go wherever your `sendOTP` sends them.

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

**Callbacks on the memoised D1 path.** The cache key ignores functions, so the memoised instance keeps the callback options (`sendOTP`, `sendMagicLink`, `betterAuth.hooks`, `plugins`) of whichever request first built it, for the life of the isolate. Those callbacks must not close over per-request state (a request-scoped value, a per-request client); read what they need from `env`, from their own arguments, or from the request they are given. The `ExecutionContext` is the exception, handled for you as described next. The same goes for objects: a wrapped `kv` or any class instance under `betterAuth` (a custom `secondaryStorage`, say) is part of the cache key by identity, so constructing one inline on every request defeats memoisation (each call builds a new instance; the cache keeps only the most recent shapes). Build such objects once, or pass the raw bindings.

Call `auth.handler(request, ctx)` with the request's `ExecutionContext` on every request. Work the package schedules through `waitUntil` (OTP and magic-link delivery, pool cleanup) runs on the context given to `handler`; `options.ctx` is only a fallback for callers that cannot pass one, and on a memoised instance it is refreshed on each `createAuth` call. If a delivery runs with no context at all, the package logs a warning (once per instance) — the runtime may cancel that delivery once the response is sent, so treat the warning as a misconfiguration to fix.

`CreateAuthOptions` is a closed type at the top level: a misspelled key (`magicLinks:` for `magicLink:`) is a type error rather than a silently ignored option. `betterAuth` is the single escape hatch for everything else Better Auth accepts (`session`, `rateLimit`, `hooks`, `advanced`, `trustedOrigins`, ...); it is an intentionally loose record, so keys nested under it are not checked against Better Auth's types — consult Better Auth's own documentation for those.

| Option           | Type                                                                           | Default                  | Description                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `basePath`       | `string`                                                                       | `'/api/auth'`            | Path prefix the Worker serves Better Auth under.                                                                                   |
| `baseURL`        | `string`                                                                       | `env.AUTH_BASE_URL`      | Public origin used for callbacks and cookies.                                                                                      |
| `secret`         | `string`                                                                       | `env.BETTER_AUTH_SECRET` | Signing secret.                                                                                                                    |
| `database`       | `{ hyperdrive: Hyperdrive, pg } \| { d1: D1Database } \| D1Database`           | required                 | Primary store; a bare D1 binding is shorthand for `{ d1 }`. See [Storage](#storage).                                               |
| `kv`             | `KVNamespace`                                                                  | required                 | Secondary storage for session cache and rate limiting.                                                                             |
| `phone`          | `{ sendOTP, otpLength?, expiresIn?, allowedAttempts?, signUpOnVerification? }` | off                      | Enables the phone-number plugin. See [Phone OTP](#phone-otp).                                                                      |
| `google`         | `boolean \| { clientId, clientSecret }`                                        | off                      | Enables Google sign-in. `true` reads the secrets from `env`.                                                                       |
| `magicLink`      | `{ sendMagicLink, expiresIn?, disableSignUp? }`                                | off                      | Enables magic-link sign-in. See [Magic link sign-in](#magic-link-sign-in).                                                         |
| `bearer`         | `boolean`                                                                      | `false`                  | Enables the bearer plugin for non-browser clients.                                                                                 |
| `allowedMethods` | `Array<'phone' \| 'google' \| 'magic-link'>`                                   | all enabled              | Rejects sign-in attempts through any other method.                                                                                 |
| `plugins`        | `BetterAuthPlugin[]`                                                           | `[]`                     | Extra Better Auth plugins, appended after the built-in ones (`betterAuth.plugins` is appended the same way, never replacing them). |
| `betterAuth`     | `Record<string, ConfigValue>`                                                  | `{}`                     | Escape hatch. Merged last, so it can override anything above.                                                                      |
| `ctx`            | `ExecutionContext`                                                             | none                     | Fallback context for `waitUntil` work; `auth.handler(request, ctx)` takes precedence.                                              |

**Package defaults under `betterAuth`.** Five Better Auth settings get a default from this package: `session.cookieCache.enabled: true`, `rateLimit.enabled: true` and `rateLimit.storage: 'secondary-storage'` (the limiter is on, in KV — Better Auth alone would leave it off in a deployed Worker), `advanced.database.validateSchema: false`, and `advanced.ipAddress.ipAddressHeaders: ['cf-connecting-ip', 'x-forwarded-for']` (so the limiter keys on Cloudflare's unspoofable client IP, falling back to the header the session client forwards). Whatever you set under `betterAuth.session`, `betterAuth.rateLimit` or `betterAuth.advanced` is shallow-merged over those defaults, field by field, so you state only what you change and can override the default itself (e.g. `betterAuth: { rateLimit: { storage: 'memory' } }`). Your `betterAuth.hooks` are composed with the package's own hooks (method restriction, cache invalidation), which run first in both slots.

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

The Worker imports `pg` and passes it in because Workers are bundled: the bundler only includes modules it sees imported, so the package cannot load the driver on your behalf without forcing it on D1 deployments too.

Hyperdrive keeps the real connections warm on Cloudflare's side, so per-request pools are cheap.

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

- **Session cache.** Session lookups hit KV before the database. With cookie caching enabled (Better Auth's default in this package) most requests never reach the primary store.
- **Rate limiter storage.** Better Auth's rate limiter is turned on (Better Auth would only enable it when `NODE_ENV` is `production`, which a deployed Worker's `process.env` does not carry) and set to use secondary storage, so counters are shared across isolates instead of being per-isolate memory. `betterAuth.rateLimit` tunes or disables it. Counters are written to KV at most once per second per key (KV refuses faster writes) and kept in memory in between, so a burst from one client never fails a request. Each write merges: KV's current count plus the increments this isolate made since it last synced, so isolates that count the same client at the same time converge on the true shared total rather than overwriting each other; between syncs an isolate sees only its own increments on top of the last KV value, which is what makes the limit soft rather than exact. Sharing is best-effort: the counter is a KV read-then-write, not an atomic increment, and KV is eventually consistent, so concurrent requests across isolates or locations can undercount and let a burst briefly exceed the configured limit.

**Consistency caveat.** KV is eventually consistent, typically within a minute across locations. Rate limits are therefore soft: a burst spread across regions can exceed the configured limit briefly. For most applications this is fine. If you need hard per-phone limits on OTP requests, put a Durable Object counter in front of `sendOTP`; the package does not do this for you. The same applies to one-shot values: consuming an OTP code or a magic-link token is a KV read followed by a delete, not an atomic take. An OTP is still bounded by its attempt counter, but a magic link has none, so two requests that open the same link at the same moment (or from different locations within KV's consistency window) can both succeed and each establish a session. A link is consumed by its first use in every ordinary case; if a strict single-use guarantee matters to you, verify it through a Durable Object instead.

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

Some deployments should accept only some methods. An internal admin app might allow Google and nothing else, even though the same package is configured with phone OTP elsewhere.

```ts
allowedMethods: ['google'];
```

installs a `before` hook that rejects requests to any other sign-in method's routes with `403`. The rejected routes are still mounted — by the method's own plugin when it is configured, or by a rejecting stub when it is not — so clients get a clear error rather than a `404`: a Google-only Worker that never configured `phone` still answers `/phone-number/send-otp` with `403`, while Google sign-in and `get-session` keep working. A method that is allowed but not configured is simply absent (`404`), since there is nothing to serve it.

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

`requireSession` also accepts a `predicate` for role checks, returning 403 when it fails. Note that the `user` the predicate sees is the cached copy: a point-in-time snapshot taken when the session was verified, refreshed only when the entry is evicted (sign-out and revocation, below) or expires with the session. A role change, email change or ban-less profile update on the auth Worker does not evict it, so a demoted user keeps passing a role predicate until then; if that matters, keep `session.expiresIn` short or re-check the user on the auth Worker for sensitive actions.

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
2. The result is cached in KV keyed by the bare session token for the remaining session lifetime, with the credential exactly as presented (the signed cookie value, or the bearer token) recorded inside the entry; a read is served from the cache only when its credential matches one the entry recorded, so a cookie with a forged signature never hits an entry a genuine request warmed.
3. Sign-out and session revocation in the auth Worker delete the KV entry, so the API sees the change on the next request.

Step 3 covers these routes: `/sign-out`, `/revoke-session`, `/revoke-sessions`, `/revoke-other-sessions`, `/change-password` (which revokes other sessions when asked to), `/delete-user` (and its callback), and the admin plugin's `/admin/revoke-user-session`, `/admin/revoke-user-sessions`, `/admin/remove-user`, `/admin/ban-user`, `/admin/update-user` when it sets `banned: true`, and `/admin/stop-impersonating`. Routes that revoke every session of a user list that user's sessions before the revocation and clear each cache entry after it. Not covered: the password-reset routes (`/reset-password`, `/phone-number/reset-password` with `revokeSessionsOnPasswordReset`), which identify the user by a one-time token rather than a session, and sessions that simply expire; their cache entries expire with them.

Sharing the KV namespace between the two Workers is what makes step 3 work. Using separate namespaces still functions, but revocation is only visible after the cache entry expires.

## Non-browser clients

Enable the bearer plugin:

```ts
bearer: true;
```

Clients then receive the session token in a `set-auth-token` response header after sign-in and send it back as `Authorization: Bearer <token>`. `createSessionClient` accepts either cookies or bearer tokens.

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

For Postgres, copy the file into your migration tool's directory and record the package version in a comment so upgrades are traceable.

If you add plugins through `plugins`, their tables are not in the shipped SQL. Generate them with Better Auth's CLI against your config:

```sh
npx @better-auth/cli generate --config src/auth.config.ts
```

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
Yes. `plugins` and `betterAuth` pass straight through. The package does not hide or rename anything in Better Auth. `auth.api` is typed with the endpoints of the plugins the package builds (admin always; phone number and magic link when their option is set). The instance type follows the options you pass: an endpoint of a method your options do not configure is typed as possibly undefined, since its plugin is not registered and the endpoint is absent at runtime, as it would be on Better Auth's own instance.

**Does it manage users, roles or organisations?**
Only through Better Auth's own plugins. The admin plugin is enabled for role checks; organisations, passkeys, multi-session and MFA are Better Auth plugins you can add through `plugins`.

**Is the rate limiter safe for OTP?**
It is shared across isolates through KV, which is what most applications need. It is not a hard limit because KV is eventually consistent. See [Sessions and rate limiting on KV](#sessions-and-rate-limiting-on-kv).

## Contributing

Issues and pull requests are welcome. Please open an issue before a large change so the design can be discussed first. Development uses Bun for tests and wrangler for the example Worker:

```sh
bun install
bun test
bun run --cwd examples/hono dev
```

### Integration tests

`bun test` runs the unit suite. The integration suite starts the example Worker under `wrangler dev` (with the API Worker and a small gateway) and drives it over HTTP; it only runs for the backends you ask for, and says so when none is requested:

```sh
INTEGRATION_BACKENDS=d1 bun run test:integration             # D1: wrangler's local SQLite, no other setup
INTEGRATION_BACKENDS=d1,hyperdrive bun run test:integration  # also Postgres through Hyperdrive
```

The Hyperdrive backend needs a Postgres. By default the suite starts a throwaway `postgres:17-alpine` container with Docker and removes it afterwards; to use a Postgres you already have, set `INTEGRATION_POSTGRES_URL` to an admin connection string (the suite creates and drops its own database on it):

```sh
INTEGRATION_BACKENDS=hyperdrive INTEGRATION_POSTGRES_URL=postgresql://postgres:postgres@localhost:5432/postgres bun run test:integration
```

CI runs both backends this way (`.github/workflows/ci.yml`, with a Postgres service container).

### Release process

- **Versioning**: Follows [Semantic Versioning](https://semver.org/). As noted in [Migrations](#migrations), schema changes in this package are always a major version bump.
- **Changelog**: Maintained per release in [CHANGELOG.md](CHANGELOG.md) following [Keep a Changelog](https://keepachangelog.com/). Each release documents notable changes under Added, Changed, Deprecated, Removed, Fixed, or Security.
- **Cutting a release**: Bump `package.json#version`, rename the `## [Unreleased]` heading in `CHANGELOG.md` to `## [x.y.z] - YYYY-MM-DD` for that version, and commit both. Then tag that commit `vx.y.z` and push the tag. The workflow fails if the tag and `package.json#version` disagree, and it extracts the release notes by matching the `## [x.y.z]` heading — without it the GitHub release is drafted with no notes.
- **Release workflow**: Releases are triggered by pushing a version tag (`v*`, e.g. `v0.1.0`). The `.github/workflows/release.yml` workflow builds the package, runs the test suite, extracts release notes from `CHANGELOG.md`, and drafts a GitHub release.
- **npm publishing**: Publishing to npm is currently pending `NPM_TOKEN` configuration. When a version tag is pushed without `NPM_TOKEN` configured, the workflow builds, tests, and drafts the release, but skips the publish step with a visible notice.

## License

MIT. See [LICENSE](LICENSE).
