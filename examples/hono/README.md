# Hono Worker Auth Example

This example demonstrates how to use `better-auth-workers` with [Hono](https://hono.dev) on Cloudflare Workers.

## Features

- **Auth Worker (`src/index.ts`)**: Serves `/auth/*` with Phone OTP, Google OAuth, and Bearer token authentication.
- **API Worker (`src/api.ts`)**: A second Worker demonstrating `createSessionClient` and `requireSession` middleware over a Cloudflare service binding.
- **Two database environments**:
  - `d1`: SQLite backed by Cloudflare D1.
  - `hyperdrive`: Postgres backed through Cloudflare Hyperdrive.
- **Local OTP delivery**: Console-logging `sendOTP` for local testing (clearly marked not for production use).

## Quick Start

### 1. Install dependencies

From repository root:

```sh
bun install
```

### 2. Run with D1 (SQLite)

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

### 3. Run with Hyperdrive (Postgres)

Ensure local Postgres is running (e.g. `postgresql://postgres:postgres@localhost:5432/auth_example`), then apply the package's shipped Postgres schema (run from the repository root):

```sh
psql postgresql://postgres:postgres@localhost:5432/auth_example \
  -f migrations/postgres/0001_init.sql
```

Then start the dev server:

```sh
bun run dev:hyperdrive
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
