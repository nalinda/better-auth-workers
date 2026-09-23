# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `testMode: { otpCode?, google? }` for end-to-end tests: every phone verification accepts `otpCode` and nothing is sent, and Google sign-in goes through an in-process stub that signs in the identity named by `loginHint` (or answers like a refused consent screen for `error:<code>`). `createAuth` refuses it unless every base URL is `http://` on a loopback host, and while it is on the instance refuses every call naming another host: HTTP requests by their URL, and server-side `auth.api` calls that forward headers by their `host` and `x-forwarded-host` (refused when they name none).
- `better-auth-workers/admin`: `createAuthAdmin(optionsFor)` builds an `AuthAdmin` RPC entrypoint for the auth Worker to export. A Worker bound to it can `banUser(userId, { reason?, expiresIn? })` and `unbanUser(userId)` without an admin session: the ban matches the admin plugin's, revokes the user's sessions and evicts them from the session client's KV cache. `AuthAdminRpc` (from `better-auth-workers/client`) types the binding.
- `phone.awaitDelivery`: `send-otp` waits for `sendOTP`. A failure answers `502 OTP_DELIVERY_FAILED` and deletes the undelivered code only, so a newer code from a resend is untouched and the user's previous code works again (except with a store-only `betterAuth.secondaryStorage`, which holds one code per number; see the README); an `OTPDeliveryError` thrown by `sendOTP` answers with its own code and status, plus `retryAfter` and a `Retry-After` header.
- `phone.beforeSendOTP`: runs before a code is created, for valid numbers only, so a per-number limit can refuse (with an `OTPDeliveryError`) without invalidating the code the user already has.
- `OTPDeliveryError` and `OTP_DELIVERY_FAILED` exports.
- README: an error-code reference, backed by a test that produces every documented code; sending codes in the user's language through a request header; requiring a verified phone for Google users.
- Each GitHub release carries the packed tarball as an asset, so the package can be installed at an exact version (`bun add https://github.com/nalinda/better-auth-workers/releases/download/vX.Y.Z/better-auth-workers-X.Y.Z.tgz`) before it is on npm. The release workflow checks that the tarball installs into a fresh Bun project and imports, and publishes that same tarball to npm when `NPM_TOKEN` is set. CI runs the same install check on every pull request.
- `database.schema` (Postgres through Hyperdrive): puts the auth tables in their own Postgres schema. Every query is qualified with it through Better Auth's `schemaName`, without relying on `search_path`. D1 rejects it.
- `idType: 'uuid'`: UUID ids. On Postgres the database generates them (`uuid` columns with a `gen_random_uuid()` default, and `uuid` `userId` references); on D1 Better Auth generates them and stores them as text.
- `better-auth-workers sql [--schema <name>] [--id-type text|uuid]`: a CLI that prints the Postgres SQL for those options, compiled by Better Auth's own migration generator. With no options it prints the shipped migration.
- `kysely` is now a dependency, matching the range `better-auth` itself depends on, for the Postgres dialect that carries the schema.

### Changed

- README: _Same origin behind a proxy_ documents (and `test/proxy-path.test.ts` tests) an auth Worker reached through service-binding hops on the app's origin: base URL and path, forwarding the request as is, cookie scope, the CSRF origin check, the Google redirect URI and the session client.
- `createSessionClient` now sends its requests to the auth Worker as `https://auth.localhost/...` instead of `https://auth.internal/...`. Service bindings ignore the host, so nothing changes for most setups, and a test-mode auth Worker now answers them. If you allow-listed `auth.internal` (a dynamic `betterAuth.baseURL` with `allowedHosts`) or route on that host in a gateway Worker, switch to `auth.localhost`.
- The `403` for a method refused by the deprecated `allowedMethods` now has `code: 'SIGN_IN_METHOD_NOT_ALLOWED'`.
- A phone number change through `verify` with `updatePhoneNumber` now expires the verifying browser's cookie cache, and it and `/update-user` evict the session client's cached copy for every session of the user, so `get-session` and `requireSession` see the change on the next request instead of when the cache expires.
- Better Auth's rate-limit `429` now carries `code: 'RATE_LIMITED'`, and an unexpected failure (an empty `500`, or an error thrown out of the handler) answers a JSON `500` with `code: 'INTERNAL_ERROR'`, like every other error (unless `betterAuth.onAPIError.throw` is set, which still throws).
- In test mode, the localhost guard now runs before any other plugin's hooks, including `beforeSendOTP`.

### Fixed

- Verification values (phone OTP codes, magic-link tokens, OAuth state) are now stored in the primary database's `verification` table instead of KV (`verification.storeInDatabase` on; the KV storage declines them). On KV, a wrong OTP guess could lose the code, because Better Auth rewrites it within the same second and KV refuses a second write to a key within a second; and a magic link opened twice at the same moment could sign in twice. `betterAuth.verification.storeInDatabase: false` is refused with the package's KV storage. Codes and links issued before the upgrade stop working, and a Google sign-in in progress at deploy fails with `state_mismatch`; start again. A consumer with their own `betterAuth.secondaryStorage` also gets `storeInDatabase: true` by default now, so verification values are written to both their storage and the database unless they set it to `false`. After a magic link is sent, expired verification rows are deleted (at most every ten minutes per isolate), since Better Auth's own sweep only runs on phone and OAuth lookups.
- `prepare` exits before running husky when the package directory is not a git checkout, instead of failing on devDependencies that are not installed there. Installing from a git URL is still not supported, since `dist/` is not committed; use the release tarball.

## [0.3.0] - 2026-09-23

### Deprecated

- `allowedMethods`, to be removed in the next major version. Every sign-in method is already opt-in per `createAuth` call, so configure only the methods a Worker should accept. The option still works and now logs a deprecation warning once per isolate. It only restricts the routes this package mounts, so a plugin such as Better Auth's `oauthPopup` or `oneTap` can still start Google sign-in when `google` is configured but not listed.

### Changed

- The Hono example no longer sets `allowedMethods`; it configures only the methods it accepts.
- README documents using UUID ids: `generateId: 'uuid'` works on D1 with the shipped SQL, but on Postgres it needs `generateId: () => crypto.randomUUID()` or a migration adding an `id` default.

## [0.2.0] - 2026-09-21

### Security

- The bearer plugin now requires the signed `set-auth-token` value. A bare session token is no longer accepted as a credential, by the auth Worker or by `createSessionClient`, which ignores an unsigned `Authorization: Bearer` header rather than looking it up or serving it from the session cache. Non-browser clients that were sending the bare `session.token` must echo the `set-auth-token` header value back verbatim instead.
- The release workflow no longer exposes `NPM_TOKEN` to the install, build or test steps — only the publish steps ever see it.

### Changed

- README corrected to describe how sessions are actually stored (in KV, not the primary database) and the eventual-consistency window (up to ~60 seconds) for revocation to propagate across locations.

### Fixed

- `.gitignore` now covers per-environment `.dev.vars.<env>` files and `.env`/`.env.*`.

## [0.1.0] - 2026-09-18

### Added

- Per-request Better Auth instance creation with memoisation on Worker `env` via `createAuth`.
- Primary storage support for PostgreSQL (via Hyperdrive) using the `pg` driver and Cloudflare D1.
- Secondary storage support on Cloudflare KV for session caching and rate limiting.
- Phone OTP sign-in plugin with delivery run under `waitUntil`.
- Google OAuth sign-in plugin configured from Worker secrets or options.
- Magic link sign-in plugin with delivery run under `waitUntil`.
- Sign-in method restrictions using `allowedMethods` with 403 rejection.
- Cross-Worker session client (`createSessionClient`) and Hono middleware (`requireSession`) with role checks; `requireSession` takes a required `{ client, predicate? }` argument (`client` is a `SessionClient` or a function of the request context), with no zero-argument form.
- Bearer token plugin support for non-browser clients.
- Typed `Env` / `AuthEnv` with startup validation of required bindings.
- Shipped SQL migrations for PostgreSQL and SQLite.
- Runnable Hono example Worker and consumer API under `examples/hono`.
- Integration test suite for `wrangler dev` with D1 and Hyperdrive backends.
- Release workflow with automated changelog extraction, release drafting, and provenance support.
