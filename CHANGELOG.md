# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-09-17

### Added

- Per-request Better Auth instance creation with memoisation on Worker `env` via `createAuth`.
- Primary storage support for PostgreSQL (via Hyperdrive) using the `pg` driver and Cloudflare D1.
- Secondary storage support on Cloudflare KV for session caching and rate limiting.
- Phone OTP sign-in plugin with delivery run under `waitUntil`.
- Google OAuth sign-in plugin configured from Worker secrets or options.
- Magic link sign-in plugin with delivery run under `waitUntil`.
- Sign-in method restrictions using `allowedMethods` with 403 rejection.
- Cross-Worker session client (`createSessionClient`) and Hono middleware (`requireSession`) with role checks.
- Bearer token plugin support for non-browser clients.
- Typed `Env` / `AuthEnv` with startup validation of required bindings.
- Shipped SQL migrations for PostgreSQL and SQLite.
- Runnable Hono example Worker and consumer API under `examples/hono`.
- Integration test suite for `wrangler dev` with D1 and Hyperdrive backends.
- Release workflow with automated changelog extraction, release drafting, and provenance support.
