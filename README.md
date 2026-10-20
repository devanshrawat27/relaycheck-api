# RelayCheck Control API

NestJS HTTP API. Validates run requests, creates run records, publishes
versioned run jobs to RabbitMQ, and serves the public run/result contracts.
It is the sole writer of the platform tables; the Scenario Runner reports
evidence through the private internal endpoints below and never connects to
the platform database.

Ownership boundaries (see `ARCHITECTURE.md` at the workspace root):

- Sole writer for the RelayCheck platform tables: `test_runs`,
  `delivery_attempts`, `assertion_results`.
- Does not execute delivery loops inside HTTP requests and never accepts
  arbitrary destination URLs (request bodies with unknown fields are
  rejected with 400).
- Scenario parameters (eventId, orderId, deliveryCount=3, timeoutMs=5000)
  are generated server-side.

## Endpoints

- `GET /api/health` — service health.
- `POST /api/runs` — body `{ "scenario": "duplicate_delivery" }`; returns
  **202** with `{ runId, status: "queued", scenario, createdAt }`. Unknown
  scenarios, missing fields, and extra fields (e.g. `destinationUrl`) are
  rejected with 400.
- `GET /api/runs?take=&status=` — bounded list (default 20, max 50); status
  filter limited to `queued|running|passed|failed|error`.
- `GET /api/runs/:id` — full detail: status, timestamps/duration, params,
  summary, `attempts[]`, `assertions[]`; 404 for unknown ids.

Creating a run persists it as `queued` and then publishes a versioned job
(`{schemaVersion: 1, runId, scenario, params}`) to the durable RabbitMQ
queue `relaycheck.run.jobs`. If publication fails, the run is explicitly
marked `error` with a safe error and the request returns 500 — a run is
never silently stuck.

## Private internal endpoints (not for the dashboard)

All require header `x-internal-token: <INTERNAL_API_TOKEN>` (unconfigured
token / missing / wrong token → 401):

- `POST /api/internal/runs/:id/claim` — `queued → running`, atomic via
  conditional `updateMany`; a second claim of the same run → 409 (this is
  what prevents a redelivered job from starting a concurrent execution).
- `POST /api/internal/runs/:id/attempts` — record one delivery attempt
  (number, eventId, httpStatus?, outcome `delivered|error|timeout`,
  durationMs, errorDetail?). Only accepted while the run is `running`.
- `POST /api/internal/runs/:id/assertions` — record an assertion result
  (`name`, `expected`, `actual`, `passed`). Only while `running`.
- `POST /api/internal/runs/:id/finalize` — terminal transition to
  `passed|failed|error` with summary and optional safe error. Only while
  `running`; a second finalize → 409.

## Setup

1. Start PostgreSQL (see the workspace root README).
2. `cp .env.example .env` — this API owns the `relaycheck` platform database.
3. `npm ci && npm run db:migrate`.

## Commands

- `npm run lint` / `npm run type-check` — static checks.
- `npm test` — Jest + Supertest e2e suite (validation, 202 success, bounded
  list, 404, SSRF-attempt rejection).
- `npm run build` / `npm start` / `npm run start:dev` — build and run on port 3200.

Package manager: **npm** (lockfiles are committed). Node >= 20.