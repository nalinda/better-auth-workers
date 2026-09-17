# better-auth-workers

[Better Auth](https://better-auth.com) on Cloudflare Workers. It handles the parts you'd otherwise write by hand:

- Builds a per-request auth instance from your Worker bindings.
- Stores data in Postgres (through Hyperdrive) or D1.
- Caches sessions and rate limits in KV.
- Runs phone OTP delivery your way.
- Lets other Workers trust the same login over a service binding.

It's a thin layer. Better Auth's options, plugins and clients still work the same way — this package only adds the Workers-specific plumbing and the cross-Worker session contract.

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

Better Auth expects a long-lived process, where you build the auth instance once and keep it around. Workers don't work that way, for four reasons:

- **Bindings only exist inside a request.** The database, KV namespace and secrets all arrive on `env`. So the auth instance has to be built per request — carefully memoised, so that's cheap.
- **Memory doesn't survive between requests.** Anything Better Auth keeps in memory, like rate-limit counters, is gone by the next isolate. That state has to live in KV instead.
- **Database connections are per request too.** A Postgres pool can't be shared across requests on Workers. It's created fresh from the Hyperdrive connection string inside the handler, and released when the response is sent.
- **Other Workers need to check sessions.** The Worker serving your API usually isn't the one handling login. It needs a cheap way to ask "who is this?" over a service binding.

This package solves those four problems, and nothing else.

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

| Option           | Type                                                    | Default                  | Description                                                                |
| ---------------- | ------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------- |
| `basePath`       | `string`                                                | `'/api/auth'`            | Path prefix the Worker serves Better Auth under.                           |
| `baseURL`        | `string`                                                | `env.AUTH_BASE_URL`      | Public origin used for callbacks and cookies.                              |
| `secret`         | `string`                                                | `env.BETTER_AUTH_SECRET` | Signing secret.                                                            |
| `database`       | `{ hyperdrive: Hyperdrive, pg } \| { d1: D1Database }`  | required                 | Primary store. See [Storage](#storage).                                    |
| `kv`             | `KVNamespace`                                           | required                 | Secondary storage for session cache and rate limiting.                     |
| `phone`          | `{ sendOTP, otpLength?, expiresIn?, allowedAttempts? }` | off                      | Enables the phone-number plugin. See [Phone OTP](#phone-otp).              |
| `google`         | `boolean \| { clientId, clientSecret }`                 | off                      | Enables Google sign-in. `true` reads the secrets from `env`.               |
| `magicLink`      | `{ sendMagicLink, expiresIn?, disableSignUp? }`         | off                      | Enables magic-link sign-in. See [Magic link sign-in](#magic-link-sign-in). |
| `bearer`         | `boolean`                                               | `false`                  | Enables the bearer plugin for non-browser clients.                         |
| `allowedMethods` | `Array<'phone' \| 'google' \| 'magic-link'>`            | all enabled              | Rejects sign-in attempts through any other method.                         |
| `plugins`        | `BetterAuthPlugin[]`                                    | `[]`                     | Extra Better Auth plugins, appended after the built-in ones.               |
| `betterAuth`     | `Partial<BetterAuthOptions>`                            | `{}`                     | Escape hatch. Merged last, so it can override anything above.              |

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

On each request, a small `pg` Pool is created from `env.HYPERDRIVE.connectionString` and handed to Better Auth. It closes itself after the response, via `waitUntil`. Better Auth talks to it through its bundled Kysely dialect, so you never write a query yourself.

The Worker imports `pg` and passes it in because Workers are bundled: the bundler only includes modules it sees imported, so the package cannot load the driver on your behalf without forcing it on D1 deployments too.

Hyperdrive keeps the real database connections warm behind the scenes, which is what makes creating a new pool on every request cheap.

### D1

```ts
database: {
  d1: env.DB;
}
```

The D1 binding is passed straight through as Better Auth's database config, using Better Auth's D1 dialect directly. D1's free tier comfortably covers a small application's auth traffic, so even a Worker with no other database can run full auth on it. For local development with `wrangler dev`, apply migrations to the local database first: `wrangler d1 migrations apply <db> --local`.

### Choosing

Use Postgres when your application data already lives there and you want foreign keys from your tables to the `user` table. Use D1 when auth is the only database the Worker needs, or when you want auth data physically separate from application data.

## Sessions and rate limiting on KV

`kv` is required. It's wired up as Better Auth's secondary storage, which is used for two things:

- **Session cache.** Session lookups check KV before the database. With cookie caching on (this package's default), most requests never reach the primary store at all.
- **Rate limiting.** Better Auth's rate limiter is set to use KV, so limits are shared across isolates instead of living in per-isolate memory.

**A consistency caveat.** KV is eventually consistent — usually within a minute across locations. That makes rate limits soft: a burst spread across regions can briefly exceed the configured limit. That's fine for most applications. If you need a hard per-phone limit on OTP requests, put a Durable Object counter in front of `sendOTP` yourself; this package doesn't do that for you.

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

Here's what the package does around your function:

- Runs it under `ctx.waitUntil`, so the sign-in response returns right away. Delivery time can't be used to guess whether a phone number exists.
- Doesn't queue it. A code that arrives after it's expired is worse than no code at all.
- Sends delivery failures to the Worker's logs, never to the client response.
- Never logs the code itself.
- Creates the user on the first successful verification of an unknown number. Better Auth needs an email on every user, so it gets `<phoneNumber>@phone.invalid` (a reserved, undeliverable domain) and the number as its name. Override with `signUpOnVerification: { getTempEmail, getTempName? }` if you want a different placeholder.

Phone numbers must be E.164 before `sendOTP` is called. If your users type local formats, normalise them on the client, or in a `betterAuth.hooks.before` hook.

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

reads `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from `env`. To supply them explicitly instead, pass an object with `clientId` and `clientSecret`.

In the Google Cloud console, register `<baseURL><basePath>/callback/google` as an authorised redirect URI.

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

Here's what the package does around your function:

- Runs it under `ctx.waitUntil`, so the sign-in response returns right away. Delivery time can't be used to guess whether an email address is registered.
- Sends delivery failures to the Worker's logs, never to the client response.

No secrets are required beyond the ones already needed for `baseURL` and `secret` — configuration for magic-link sign-in lives entirely in `magicLink`, same as `phone`.

## Restricting sign-in methods

Some deployments should only accept some sign-in methods. An internal admin app might allow Google and nothing else, even if the same package elsewhere is configured with phone OTP too.

```ts
allowedMethods: ['google'];
```

This installs a `before` hook that rejects requests to any other sign-in route with `403`. Those routes stay mounted, so clients get a clear error instead of a `404`.

## Using sessions from another Worker

Most Workers architectures put auth in one Worker and the API in another. The API Worker needs to know who's calling, without owning the auth tables itself.

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

Or use the middleware. `requireSession` takes the `SessionClient` explicitly — the same per-request `env`-bound instance created above — rather than building its own, so it composes with whatever setup created that client:

```ts
import { requireSession } from 'better-auth-workers/client';

app.get(
  '/me',
  (c, next) => requireSession({ client: c.get('sessions') })(c, next),
  (c) => c.json(c.get('session').user)
);
```

`requireSession` also accepts a `predicate` for role checks, returning 403 when it fails:

```ts
app.get(
  '/admin',
  (c, next) =>
    requireSession({ client: c.get('sessions'), predicate: (s) => s.user.role === 'admin' })(
      c,
      next
    ),
  (c) => c.json(c.get('session').user)
);
```

How it works:

1. The client forwards the request's `Cookie` (or `Authorization`) header to the auth Worker's `get-session` route, over the service binding.
2. The result is cached in KV, under the session token, for the rest of the session's lifetime.
3. When the auth Worker signs out or revokes a session, it deletes that KV entry — so the API sees the change on its very next request.

Step 3 only works if both Workers share the same KV namespace. Separate namespaces still work, but revocation won't be visible until the cache entry expires on its own.

## Non-browser clients

Enable the bearer plugin:

```ts
bearer: true;
```

After sign-in, clients receive the session token in a `set-auth-token` response header, and send it back as `Authorization: Bearer <token>`. `createSessionClient` accepts either cookies or bearer tokens — no extra setup needed.

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

The auth Worker should share an origin with the app that sets its cookies. Two ways to do that:

- **Cloudflare route.** Route `example.com/auth/*` to the auth Worker, and everything else to your app. No code needed.
- **Proxy through the app Worker.** Bind the auth Worker as a service, and forward `/auth/*` to it. Handy when the app Worker already fronts everything.

Cross-origin deployments are possible too, using Better Auth's `trustedOrigins` and cross-subdomain cookie settings (passed through `betterAuth`). But same-origin is simpler, and it's the path this package is tested against.

## Local development

`wrangler dev` runs the Worker locally with local bindings.

- **D1**: `wrangler dev` uses a local SQLite file automatically. Apply migrations with `wrangler d1 migrations apply <db> --local`.
- **Postgres**: point the Hyperdrive binding's `localConnectionString` at a local Postgres in the `development` environment of `wrangler.jsonc`. Hyperdrive is bypassed locally.
- **KV**: local automatically.
- **OTP**: a `sendOTP` that logs the code to the console is enough for local work. Do not ship it.

The `examples/hono` directory contains a runnable Worker with both storage options.

## Compatibility

| Dependency             | Version         |
| ---------------------- | --------------- |
| better-auth            | ^1.7            |
| wrangler               | ^4              |
| Compatibility flags    | `nodejs_compat` |
| pg (Postgres only)     | ^8              |
| hono (middleware only) | ^4              |

Hono is an optional peer dependency. `createAuth` and `createSessionClient` work with any framework that gives you a `Request`; only `requireSession()` needs Hono.

## FAQ

**How is this different from better-auth-cloudflare?**
That package integrates Better Auth with Cloudflare through Drizzle, and adds geolocation and R2 helpers. This one talks to `pg` or D1 directly (no ORM), ships SQL instead of a schema file, and adds the cross-Worker session client. Pick whichever matches how you already access your database.

**Why is the auth instance created per request?**
Because bindings only arrive on `env`, which only exists inside the handler. The instance is memoised per `env` object, so within one isolate you only pay that cost once.

**Can I use Better Auth features this package doesn't mention?**
Yes. `plugins` and `betterAuth` pass straight through — this package never hides or renames anything in Better Auth.

**Does it manage users, roles or organisations?**
Only through Better Auth's own plugins. The admin plugin is on by default for role checks. Organisations, passkeys, multi-session and MFA are all Better Auth plugins you can add through `plugins`.

**Is the rate limiter safe for OTP?**
It's shared across isolates through KV, which covers what most applications need. It's not a hard limit, though — KV is eventually consistent. See [Sessions and rate limiting on KV](#sessions-and-rate-limiting-on-kv).

## Contributing

Issues and pull requests are welcome. Please open an issue before a large change so the design can be discussed first. Development uses Bun for tests and wrangler for the example Worker:

```sh
bun install
bun test
bun run --cwd examples/hono dev
```

### Release process

- **Versioning**: Follows [Semantic Versioning](https://semver.org/). As noted in [Migrations](#migrations), schema changes in this package are always a major version bump.
- **Changelog**: Maintained per release in [CHANGELOG.md](CHANGELOG.md) following [Keep a Changelog](https://keepachangelog.com/). Each release documents notable changes under Added, Changed, Deprecated, Removed, Fixed, or Security.
- **Release workflow**: Releases are triggered by pushing a version tag (`v*`, e.g. `v0.1.0`). The `.github/workflows/release.yml` workflow builds the package, runs the test suite, extracts release notes from `CHANGELOG.md`, and drafts a GitHub release.
- **npm publishing**: Publishing to npm is currently pending `NPM_TOKEN` configuration. When a version tag is pushed without `NPM_TOKEN` configured, the workflow builds, tests, and drafts the release, but skips the publish step with a visible notice.

#### Configuring npm publishing

When ready to enable automated npm publishing:

1. Create an automation access token on [npmjs.com](https://www.npmjs.com/) (or a granular access token scoped to the package with read and write permissions).
2. Add it as a repository secret named `NPM_TOKEN` in GitHub (**Settings** → **Secrets and variables** → **Actions** → **New repository secret**).
3. If the package has not yet been published to npm, run the initial publish manually once from an authenticated machine (`npm login`, then `npm publish --access public`). Subsequent releases are published automatically by CI.
4. Provenance (`npm publish --provenance`) uses GitHub Actions OIDC via `permissions: id-token: write` and requires no additional secrets.

## License

MIT. See [LICENSE](LICENSE).
