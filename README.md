# RelayCheck Control API

NestJS HTTP API. Validates run requests, creates run records, publishes
versioned run jobs to RabbitMQ, and serves the public run/result contracts.
It is the sole writer of the platform tables; the Scenario Runner reports
evidence through private internal endpoints and never connects to the
platform database.

Ownership boundaries (see `ARCHITECTURE.md` at the workspace root):

- Sole writer for the RelayCheck platform tables: `users`, `workspaces`,
  `memberships`, `sessions`, `invitations`, `test_runs`, `delivery_attempts`,
  `assertion_results`, and `outbox_events`.
- Does not execute delivery loops inside HTTP requests and never accepts
  arbitrary destination URLs (unknown request fields are rejected with 400).
- Scenario parameters are generated server-side by default and may be
  overridden within hard bounds (see below).

## Endpoints

- `GET /api/health` - service health.
- `POST /api/runs` - body `{ "scenario": "...", "target": "<name>" }` plus
  optional bounded parameters: `deliveryCount` (duplicate only, 1-5),
  `timeoutMs` (500-15000), `httpStatus` (failure only, 400-599),
  `delayMs` (timeout only, 0-10000 and must exceed `timeoutMs`). Irrelevant
  parameters are rejected with 400. Returns **202** with
  `{ runId, status: "queued", scenario, createdAt }`. Unknown
  scenarios/targets and extra fields (e.g. `destinationUrl`) are rejected with
  400. Event IDs are always generated server-side.
- `GET /api/runs?take=&status=&cursor=` - bounded list (default 20, max 50)
  with an opaque cursor for older pages (`nextCursor`); status filter limited
  to `queued|running|passed|failed|error`.
- `GET /api/runs/:id` - full detail: status, timestamps/duration, params,
  summary, `attempts[]`, `assertions[]`; 404 for unknown ids.
- `GET /api/targets` - configured delivery targets by name only (never URLs).
- `GET /api/metrics` and `GET /api/metrics/prometheus` - aggregate run/outbox/
  queue metrics.
- Auth: `POST /api/auth/register`, `POST /api/auth/login`,
  `POST /api/auth/logout`, `GET /api/auth/me`.
- Workspace: `GET /api/workspace/members`, `POST /api/workspace/invitations`,
  `POST /api/workspace/accept-invitation`, `POST /api/workspace/switch`,
  `PATCH /api/workspace/members/:userId`,
  `DELETE /api/workspace/members/:userId`.

Public run and metrics endpoints are guarded by the optional session auth
(when `AUTH_REQUIRED=true`) or the optional `API_AUTH_TOKEN` machine token.

## Accounts, workspaces and scoping

Set `AUTH_REQUIRED=true` to enable multi-user mode:

- `POST /api/auth/register` `{ email, password }` creates a user, a personal
  workspace, and a session (httpOnly cookie + `token` in the body).
- Sessions are opaque random tokens stored hashed (SHA-256) in PostgreSQL;
  passwords are hashed with scrypt; logout revokes the session.
- Runs are stamped with the caller's workspace; list/detail queries are scoped
  to it (foreign runs return 404). Users can belong to multiple workspaces and
  switch the active one.
- Roles: `owner` (manage everything), `admin` (invite/manage non-owners),
  `member` (create/read runs). The last owner cannot be removed or demoted.
  Invitations are one-time, hashed, and expire after 7 days.
- `API_AUTH_TOKEN` doubles as a machine credential for local automation/CI.

With `AUTH_REQUIRED` unset (the default in `.env.example`) RelayCheck runs in
local mode: no login, all runs visible, and `API_AUTH_TOKEN` optionally guards
access. Local-mode runs have no workspace and are not visible in account mode.

## Delivery targets

Jobs carry a target name and URL, but clients never supply URLs. Additional
targets come from `TARGETS_JSON`:

```json
[
  { "name": "staging-webhook", "url": "https://staging.example.test/hooks", "oracle": false },
  { "name": "local-fixture", "url": "http://127.0.0.1:3202", "allowPrivate": true, "oracle": false }
]
```

Entries with private/loopback hosts are dropped unless `allowPrivate` is
explicitly `true`; the runner independently re-checks its own copy of the
registry, blocks redirects, and fails closed on DNS failures.
`receiver_failure`/`receiver_timeout` require `demo-receiver`; remote targets
verify delivery status only (no business-effect oracle).

## Run creation and dispatch

Creating a run commits the run row and its job payload in a single database
transaction (transactional outbox). A dispatcher claims pending payloads
atomically (`pending -> sending` with a lock, safe across API instances),
publishes them to the durable queue `relaycheck.run.jobs` using a
publisher-confirm channel, marks them sent, and retries failures including
stale claims after a crash. `POST /api/runs` therefore always returns 202 for
a valid request; the run is `queued` until the runner claims it.

## Private internal endpoints (not for the dashboard)

All require `x-internal-token: <INTERNAL_API_TOKEN>`:

- `POST /api/internal/runs/:id/claim` - body `{ "workerId": "..." }`;
  `queued -> running` with a 30 s lease. A second claim -> 409 with the current
  status and lease expiry.
- `POST /api/internal/runs/:id/heartbeat` - extend the lease (owner only).
- `POST /api/internal/runs/:id/resume-claim` - atomically take over a run whose
  lease expired (resume without finalizing).
- `GET /api/internal/runs/:id/progress` - recorded attempts/assertions for
  safe resume.
- `POST /api/internal/runs/:id/recover` - operational fallback: finalize an
  expired-lease run as `error`; otherwise 409.
- `POST /api/internal/runs/:id/attempts` - record one delivery attempt.
- `POST /api/internal/runs/:id/assertions` - record an assertion result.
- `POST /api/internal/runs/:id/finalize` - terminal transition to
  `passed|failed|error`; only while running, second finalize -> 409.

## Local safety valves

- `RATE_LIMIT_PER_MINUTE` (default 120, `0` disables) - per-IP fixed window on
  public API requests.
- `API_MAX_RUNS_PER_DAY` (default `0` = unlimited) - UTC daily run quota.

## End-to-end smoke test

`npm run smoke` runs the duplicate-delivery scenario against the live stack,
verifies 3 attempts and 1 business effect, prints measured durations, and
cleans up. Exit code `0` = pass, `1` = failure. `npm run smoke:stack` starts
the stack, runs the smoke, and stops the app processes.

## Setup

1. Start PostgreSQL (see the workspace root README / `SETUP.md`).
2. `cp .env.example .env` - this API owns the `relaycheck` platform database.
3. `npm ci && npm run db:migrate`.

## Commands

- `npm run lint` / `npm run type-check` - static checks.
- `npm test` - Jest + Supertest suites (auth, workspace roles, runs, queue
  lifecycle, targets, metrics, rate limits).
- `npm run build` / `npm start` / `npm run start:dev` - build and run on 3200.

Package manager: **npm** (lockfiles are committed). Node >= 20.
