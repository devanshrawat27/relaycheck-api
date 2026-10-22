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
- `POST /api/runs` — body `{ "scenario": "..." }`; returns **202** with
  `{ runId, status: "queued", scenario, createdAt }`. Supported scenarios:
  `duplicate_delivery` (3 deliveries, 5 s timeout), `receiver_failure`
  (1 delivery, 3 s timeout), `receiver_timeout` (1 delivery, 1 s timeout).
  Unknown scenarios, missing fields, and extra fields (e.g.
  `destinationUrl`) are rejected with 400.
- `GET /api/runs?take=&status=&cursor=` — bounded list (default 20, max 50)
  with an opaque **cursor** for older pages (`nextCursor` in the response);
  status filter limited to `queued|running|passed|failed|error`.
- `GET /api/runs/:id` — full detail: status, timestamps/duration, params,
  summary, `attempts[]`, `assertions[]`; 404 for unknown ids.

Creating a run commits the run row and its job payload in a single database
transaction (**transactional outbox**). A dispatcher claims pending payloads
atomically (`pending → sending` with a lock, so multiple API instances can
run safely), publishes them to the durable queue `relaycheck.run.jobs` using
a **publisher-confirm channel**, marks them sent, and retries failures —
including releasing stale claims after a crash. A broker outage or a crash
between database commit and publishing cannot strand a run. `POST /api/runs`
therefore always returns 202 for a valid request; the run is `queued` until
the runner claims it.

## Private internal endpoints (not for the dashboard)

All require header `x-internal-token: <INTERNAL_API_TOKEN>` (unconfigured
token / missing / wrong token → 401):

- `POST /api/internal/runs/:id/claim` — body `{ "workerId": "..." }`;
  `queued → running` with a 30 s lease. A second claim → 409 with the current
  status and lease expiry (ownership conflict, not proof of abandonment).
- `POST /api/internal/runs/:id/heartbeat` — body `{ "workerId": "..." }`;
  extends the lease for the owning worker only.
- `POST /api/internal/runs/:id/recover` — finalizes `running → error` **only
  when the lease has expired**; otherwise 409.
- `POST /api/internal/runs/:id/attempts` — record one delivery attempt
  (number, eventId, httpStatus?, outcome `delivered|error|timeout`,
  durationMs, errorDetail?). Only accepted while the run is `running`.
- `POST /api/internal/runs/:id/assertions` — record an assertion result
  (`name`, `expected`, `actual`, `passed`). Only while `running`.
- `POST /api/internal/runs/:id/finalize` — terminal transition to
  `passed|failed|error` with summary and optional safe error. Only while
  `running`; a second finalize → 409.

## End-to-end smoke test

`npm run smoke` runs the full duplicate-delivery scenario against the live
local stack and verifies the required outcome:

1. Creates a real run through the public API.
2. Polls the run until a terminal state (bounded, default 90 s).
3. Checks: run `passed`, 3 delivery attempts, 3 accepted (2xx) deliveries,
   exactly one business effect.
4. Cleans up the platform run (attempts/assertions cascade) and the receiver
   rows it created — even when the check fails.

Exit code `0` = pass, `1` = assertion failure or execution error (CI-friendly).
Prerequisites: Control API, RabbitMQ, Scenario Runner, and the Demo Receiver
(with `RELAYCHECK_TEST_MODE=true`) all running. `DATABASE_URL` and
`SMOKE_DEMO_DATABASE_URL` are used only for cleanup.

### Self-starting variant

`npm run smoke:stack` provisions the local stack for you (infra, receiver in
test mode, API, runner), runs the smoke test, then stops the app processes
again. Requires Docker running, sibling checkouts of the receiver and runner,
and existing builds (`npm run build` once per repo).

## Optional public API token

By default the public run endpoints rely on loopback binding (local-only).
If you override `HOST` (or otherwise expose the API), set `API_AUTH_TOKEN`
and send `Authorization: Bearer <token>` with every `/api/runs` and
`/api/metrics` request. `/api/health` stays public. This is a single shared
token, not user accounts or tenancy; unauthenticated mode remains the local
default.

## Operational metrics

`GET /api/metrics` returns aggregate counts only (guarded by
`API_AUTH_TOKEN` when set): runs by status, outbox pending/sending/failed and
oldest pending age, and RabbitMQ work/dead-letter queue depths. The dashboard
renders this on its **Diagnostics** page.

`GET /api/metrics/prometheus` exposes the same data in Prometheus text format
for scraping:

```yaml
scrape_configs:
  - job_name: relaycheck
    static_configs:
      - targets: ['127.0.0.1:3200']
    metrics_path: /api/metrics/prometheus
    authorization:
      credentials: <API_AUTH_TOKEN>   # only if configured
```

Useful alert thresholds: `relaycheck_queue_depth{queue="work"} > 100`,
`relaycheck_outbox_oldest_pending_seconds > 60`,
`relaycheck_outbox_events{state="failed"} > 0`,
`relaycheck_queue_depth{queue="dead_letter"} > 0`.

## Local safety valves

- `RATE_LIMIT_PER_MINUTE` (default 120, `0` disables) — per-IP fixed window on
  public API requests.
- `API_MAX_RUNS_PER_DAY` (default `0` = unlimited) — UTC daily run quota;
  exceeding it returns 429.

These are local safeguards, not a multi-tenant quota system.

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