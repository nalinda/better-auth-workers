# better-auth-workers

[Better Auth](https://better-auth.com) on Cloudflare Workers, without the parts you would otherwise write by hand: a per-request auth instance built from your bindings, Postgres through Hyperdrive or D1 as the primary store, KV for session caching and rate limiting, phone OTP with delivery you control, and a session client so other Workers can trust the same login over a service binding.

It is a thin layer. Better Auth's options, plugins and clients are all still yours to use directly. This package only handles the Workers-specific plumbing and the cross-Worker session contract.

> **Status:** pre-release. The API described here is the target for 0.1.0 and may change before then.

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
- [Restricting sign-in methods](#restricting-sign-in-methods)
- [Using sessions from another Worker](#using-sessions-from-another-worker)
- [Non-browser clients](#non-browser-clients)
- [Migrations](#migrations)
- [Routing](#routing)
- [Local development](#local-development)
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

- `createAuth(env, options)`: a Better Auth instance built from Workers bindings, memoised per `env`.
- **Postgres via Hyperdrive** using the `pg` driver, or **D1**. Pass the binding; no ORM, no schema file.
- **KV secondary storage** for session caching and the built-in rate limiter, wired up for you.
- **Phone OTP** through Better Auth's phone-number plugin with a `sendOTP` you implement, run under `waitUntil` so delivery latency never leaks into the response.
- **Google sign-in** configured from secrets.
- **Sign-in method restriction** per deployment, for example social-only for an internal app.
- **`createSessionClient`** for other Workers: verify a session over a service binding, cache it in KV, and get a Hono `requireSession()` middleware.
- **Bearer tokens** for mobile and CLI clients through Better Auth's bearer plugin.
- **SQL migrations shipped in the package** for both Postgres and SQLite, covering the default schema.
- Typed `Env` so a missing binding is a type error, not a runtime surprise.

## Installation

```sh
npm install better-auth better-auth-workers
```

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
  "vars": { "AUTH_BASE_URL": "https://example.com" }
}
```

Secrets, set with `wrangler secret put`:

| Secret | Purpose |
| --- | --- |
| `BETTER_AUTH_SECRET` | Signs cookies and tokens. 32+ random bytes. |
| `GOOGLE_CLIENT_ID` | Google OAuth client id. |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret. |

**src/index.ts**

```ts
import { Hono } from 'hono';
import { createAuth, type AuthEnv } from 'better-auth-workers';

type Env = AuthEnv & {
  // any extra bindings your sendOTP needs
  SMS: Fetcher;
};

const app = new Hono<{ Bindings: Env }>();

app.on(['GET', 'POST'], '/auth/*', (c) => {
  const auth = createAuth(c.env, {
    basePath: '/auth',
    database: { hyperdrive: c.env.HYPERDRIVE },
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
  return auth.handler(c.req.raw);
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

await authClient.phoneNumber.sendOtp({ phoneNumber: '+94771234567' });
await authClient.phoneNumber.verify({ phoneNumber: '+94771234567', code: '123456' });
```

## Configuration

`createAuth(env, options)` returns a Better Auth instance. The instance is memoised on `env`, so calling it on every request is free after the first call in an isolate.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `basePath` | `string` | `'/api/auth'` | Path prefix the Worker serves Better Auth under. |
| `baseURL` | `string` | `env.AUTH_BASE_URL` | Public origin used for callbacks and cookies. |
| `secret` | `string` | `env.BETTER_AUTH_SECRET` | Signing secret. |
| `database` | `{ hyperdrive: Hyperdrive } \| { d1: D1Database }` | required | Primary store. See [Storage](#storage). |
| `kv` | `KVNamespace` | required | Secondary storage for session cache and rate limiting. |
| `phone` | `{ sendOTP, otpLength?, expiresIn?, allowedAttempts? }` | off | Enables the phone-number plugin. See [Phone OTP](#phone-otp). |
| `google` | `boolean \| { clientId, clientSecret }` | off | Enables Google sign-in. `true` reads the secrets from `env`. |
| `bearer` | `boolean` | `false` | Enables the bearer plugin for non-browser clients. |
| `allowedMethods` | `Array<'phone' \| 'google' \| 'magic-link'>` | all enabled | Rejects sign-in attempts through any other method. |
| `plugins` | `BetterAuthPlugin[]` | `[]` | Extra Better Auth plugins, appended after the built-in ones. |
| `betterAuth` | `Partial<BetterAuthOptions>` | `{}` | Escape hatch. Merged last, so it can override anything above. |

Everything not listed is Better Auth's default. Session lifetime, cookie attributes, OTP length and attempts are all Better Auth's defaults unless you change them through `phone` or `betterAuth`.

## Storage

### Postgres through Hyperdrive

```ts
database: { hyperdrive: env.HYPERDRIVE }
```

A `pg` Pool is created per request from `env.HYPERDRIVE.connectionString` with a small `max`, handed to Better Auth, and ended after the response through `waitUntil`. Better Auth talks to it through its bundled Kysely dialect; you never write a query.

Hyperdrive keeps the real connections warm on Cloudflare's side, so per-request pools are cheap.

### D1

```ts
database: { d1: env.DB }
```

Better Auth's D1 dialect is used directly. D1 has a free tier that comfortably covers a small application's auth traffic, so a Worker that has no other database can still run full auth.

### Choosing

Use Postgres when your application data already lives there and you want foreign keys from your tables to the `user` table. Use D1 when auth is the only database the Worker needs, or when you want auth data physically separate from application data.

## Sessions and rate limiting on KV

`kv` is required. It is wired as Better Auth's secondary storage, which does two things:

- **Session cache.** Session lookups hit KV before the database. With cookie caching enabled (Better Auth's default in this package) most requests never reach the primary store.
- **Rate limiter storage.** Better Auth's rate limiter is set to use secondary storage, so limits are shared across isolates instead of being per-isolate memory.

**Consistency caveat.** KV is eventually consistent, typically within a minute across locations. Rate limits are therefore soft: a burst spread across regions can exceed the configured limit briefly. For most applications this is fine. If you need hard per-phone limits on OTP requests, put a Durable Object counter in front of `sendOTP`; the package does not do this for you.

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
google: true
```

reads `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from `env`. Pass an object to supply them explicitly. Register `<baseURL><basePath>/callback/google` as an authorised redirect URI in the Google Cloud console.

## Restricting sign-in methods

Some deployments should accept only some methods. An internal admin app might allow Google and nothing else, even though the same package is configured with phone OTP elsewhere.

```ts
allowedMethods: ['google']
```

installs a `before` hook that rejects requests to any other sign-in route with `403`. The rejected routes are still mounted, so clients get a clear error rather than a `404`.

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
import { createSessionClient } from 'better-auth-workers/client';

const app = new Hono<{ Bindings: Env }>();

app.use('*', async (c, next) => {
  const sessions = createSessionClient({
    auth: c.env.AUTH,          // service binding
    kv: c.env.AUTH_KV,         // the auth Worker's KV namespace
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

Or use the middleware:

```ts
import { requireSession } from 'better-auth-workers/client';

app.get('/me', requireSession(), (c) => c.json(c.get('session').user));
```

How it works:

1. The client forwards the incoming request's `Cookie` (or `Authorization`) header to the auth Worker's `get-session` route over the service binding.
2. The result is cached in KV under the session token for the remaining session lifetime.
3. Sign-out and session revocation in the auth Worker delete the KV entry, so the API sees the change on the next request.

Sharing the KV namespace between the two Workers is what makes step 3 work. Using separate namespaces still functions, but revocation is only visible after the cache entry expires.

## Non-browser clients

Enable the bearer plugin:

```ts
bearer: true
```

Clients then receive the session token in a `set-auth-token` response header after sign-in and send it back as `Authorization: Bearer <token>`. `createSessionClient` accepts either cookies or bearer tokens.

## Migrations

The package ships the SQL for Better Auth's default schema plus the plugins it enables (phone number, admin, bearer):

```
node_modules/better-auth-workers/migrations/postgres/0001_init.sql
node_modules/better-auth-workers/migrations/sqlite/0001_init.sql
```

Apply them with whatever you already use. For D1:

```sh
cp node_modules/better-auth-workers/migrations/sqlite/*.sql migrations/
wrangler d1 migrations apply <db>
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
- **Postgres**: point the Hyperdrive binding's `localConnectionString` at a local Postgres in the `development` environment of `wrangler.jsonc`. Hyperdrive is bypassed locally.
- **KV**: local automatically.
- **OTP**: a `sendOTP` that logs the code to the console is enough for local work. Do not ship it.

The `examples/hono` directory contains a runnable Worker with both storage options.

## Compatibility

| Dependency | Version |
| --- | --- |
| better-auth | ^1.7 |
| wrangler | ^4 |
| Compatibility flags | `nodejs_compat` |
| pg (Postgres only) | ^8 |
| hono (middleware only) | ^4 |

Hono is an optional peer dependency. `createAuth` and `createSessionClient` work with any framework that gives you a `Request`; only `requireSession()` needs Hono.

## FAQ

**How is this different from better-auth-cloudflare?**
That package integrates Better Auth with Cloudflare through Drizzle and adds geolocation and R2 helpers. This one uses `pg` or D1 directly with no ORM, ships SQL rather than a schema file, and adds the cross-Worker session client. Pick whichever matches how you already access your database.

**Why is the auth instance created per request?**
Because bindings arrive on `env`, which only exists inside the handler. The instance is memoised per `env` object, so within an isolate the cost is paid once.

**Can I use Better Auth features this package does not mention?**
Yes. `plugins` and `betterAuth` pass straight through. The package does not hide or rename anything in Better Auth.

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

## License

MIT. See [LICENSE](LICENSE).
