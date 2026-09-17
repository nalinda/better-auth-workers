# Hono Worker Auth Example

This example demonstrates how to use `better-auth-workers` with [Hono](https://hono.dev) on Cloudflare Workers.

## Features

- **Auth Worker (`src/index.ts`, `wrangler.jsonc`)**: Serves `/auth/*` with Phone OTP, magic-link, Google OAuth, and Bearer token authentication.
- **API Worker (`src/api.ts`, `api.wrangler.jsonc`)**: A second Worker demonstrating `createSessionClient` and `requireSession` middleware over a Cloudflare service binding to the auth Worker.
- **Two database environments**:
  - `d1`: SQLite backed by Cloudflare D1.
  - `hyperdrive`: Postgres backed through Cloudflare Hyperdrive.
- **Local delivery**: Console-logging `sendOTP` and `sendMagicLink` for local testing (clearly marked not for production use).

## Quick Start

### 1. Install dependencies

From repository root:

```sh
bun install
```

### 2. Provide the signing secret

`BETTER_AUTH_SECRET` is a secret, so it is not in `wrangler.jsonc`. For local development copy the example file and set a value (32+ random bytes; the file is gitignored):

```sh
cp .dev.vars.example .dev.vars
# then edit .dev.vars, e.g. BETTER_AUTH_SECRET=$(openssl rand -base64 32)
```

For a deployed Worker set it with `wrangler secret put BETTER_AUTH_SECRET` (per environment: `--env d1` or `--env hyperdrive`).

### 3. Run with D1 (SQLite)

Apply the package's shipped SQLite schema to your local D1 database (run from the repository root):

```sh
wrangler d1 execute example-auth-db --local --env d1 -c examples/hono/wrangler.jsonc \
  --file migrations/sqlite/0001_init.sql
```

Start the dev server:

```sh
bun run --cwd examples/hono dev
```

Or from within `examples/hono`:

```sh
bun run dev:d1
```

### 4. Run with Hyperdrive (Postgres)

Ensure local Postgres is running (e.g. `postgresql://postgres:postgres@localhost:5432/auth_example`), then apply the package's shipped Postgres schema (run from the repository root):

```sh
psql postgresql://postgres:postgres@localhost:5432/auth_example \
  -f migrations/postgres/0001_init.sql
```

Then start the dev server:

```sh
bun run dev:hyperdrive
```

### 5. Run both Workers together

The API Worker has its own config, `api.wrangler.jsonc`. Its `AUTH` service binding targets the auth Worker by its environment-specific name (`example-hono-d1` or `example-hono-hyperdrive`), and its `AUTH_KV` namespace is the auth Worker's, so a sign-out on the auth Worker is visible to the API Worker's session cache on the next request.

Run each Worker in its own terminal; `wrangler dev` sessions on one machine find each other through the local dev registry, so the service binding resolves across the two processes:

```sh
# terminal 1, from within examples/hono: the auth Worker on :8787
bun run dev:d1            # or dev:hyperdrive

# terminal 2, from within examples/hono: the API Worker on :8788
bun run dev:api           # or dev:api:hyperdrive
```

Sign in through `http://localhost:8787/auth/*` (see below), then call `http://localhost:8788/me` with the session cookie, or with the `Authorization: Bearer <token>` header from the sign-in response:

```sh
curl http://localhost:8788/me -H "Authorization: Bearer <token>"
```

## Testing Phone OTP Locally

When requesting an OTP via `/auth/phone-number/send-otp`:

```sh
curl -X POST http://localhost:8787/auth/phone-number/send-otp \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber": "+1234567890"}'
```

The 6-digit OTP code will be printed to your terminal console:

```
[local use only - not for production] OTP for +1234567890: 123456
```

## Testing Magic Link Locally

Request a link via `/auth/sign-in/magic-link`:

```sh
curl -X POST http://localhost:8787/auth/sign-in/magic-link \
  -H "Content-Type: application/json" \
  -d '{"email": "someone@example.com", "callbackURL": "/"}'
```

The link is printed to your terminal console instead of being emailed:

```
[local use only - not for production] Magic link for someone@example.com: http://localhost:8787/auth/magic-link/verify?token=...&callbackURL=/
```

Opening it (or `curl -i` on it) verifies the token, creates the user on first sign-in, and sets the session cookie.
