# RelayCheck Control API

NestJS HTTP API. Validates run requests, creates run records, and serves the
public run/result contracts. Queue publication and the private runner-reporting
endpoints land in the dispatch/lifecycle task — create-run currently persists
the run as `queued` and does not pretend to enqueue anything.

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