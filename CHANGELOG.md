# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
