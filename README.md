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
- Scenario parameters are generated server-side by default and may be overridden within hard bounds.

## Endpoints

- `GET /api/health` - service health.
- `POST /api/runs` - body `{ "scenario": "...", "target": "<name>" }` plus
  optional bounded parameters: `deliveryCount` (duplicate only, 1-5),
  `timeoutMs` (500-15000), `httpStatus` (failure only, 400-599),
  `delayMs` (timeout only, 0-10000 and must exceed `timeoutMs`), and
  `target` (a configured target name). Irrelevant parameters are rejected
  with 400. Returns **202** with `{ runId, status: "queued", scenario, createdAt }`.
  Unknown scenarios/targets and extra fields (e.g. `destinationUrl`) are
  rejected with 400. Event IDs are always generated server-side.
- `GET /api/runs?take=&status=&cursor=` - bounded list (default 20, max 50)
  with an opaque **cursor** for older pages (`nextCursor`); status filter
  limited to `queued|running|passed|failed|error`.
- `GET /api/runs/:id` - full detail: status, timestamps/duration, params,
  summary, `attempts[]`, `assertions[]`; 404 for unknown ids.
- `GET /api/targets` - configured delivery targets by **name only** (never
  URLs). The built-in `demo-receiver` always exists; additional entries come
  from `TARGETS_JSON`.

`receiver_failure`/`receiver_timeout` require `demo-receiver`; remote
targets are allowed for `duplicate_delivery` and verify delivery status only
(no business-effect oracle).

`TARGETS_JSON` example:

```json
[
  { "name": "staging-webhook", "url": "https://staging.example.test/hooks", "oracle": false },
  { "name": "local-fixture", "url": "http://127.0.0.1:3202", "allowPrivate": true, "oracle": false }
]
```

Entries with private/loopback hosts are dropped unless `allowPrivate` is
explicitly `true`; the runner independently re-checks its own copy of the
registry, blocks redirects, and fails closed on DNS failures.
Creating a run commits the run row and its job payload in a single database
transaction (**transactional outbox**). A dispatcher claims pending payloads
atomically (`pending â†’ sending` with a lock, so multiple API instances can
run safely), publishes them to the durable queue `relaycheck.run.jobs` using
a **publisher-confirm channel**, marks them sent, and retries failures â€”
including releasing stale claims after a crash. A broker outage or a crash
between database commit and publishing cannot strand a run. `POST /api/runs`
therefore always returns 202 for a valid request; the run is `queued` until
the runner claims it.

## Private internal endpoints (not for the dashboard)

All require header `x-internal-token: <INTERNAL_API_TOKEN>` (unconfigured
token / missing / wrong token â†’ 401):

- `POST /api/internal/runs/:id/claim` â€” body `{ "workerId": "..." }`;
  `queued â†’ running` with a 30 s lease. A second claim â†’ 409 with the current
  status and lease expiry (ownership conflict, not proof of abandonment).
- `POST /api/internal/runs/:id/heartbeat` â€” body `{ "workerId": "..." }`;
  extends the lease for the owning worker only.
- `POST /api/internal/runs/:id/recover` â€” finalizes `running â†’ error` **only
  when the lease has expired**; otherwise 409.
- `POST /api/internal/runs/:id/attempts` â€” record one delivery attempt
  (number, eventId, httpStatus?, outcome `delivered|error|timeout`,
  durationMs, errorDetail?). Only accepted while the run is `running`.
- `POST /api/internal/runs/:id/assertions` â€” record an assertion result
  (`name`, `expected`, `actual`, `passed`). Only while `running`.
- `POST /api/internal/runs/:id/finalize` â€” terminal transition to
  `passed|failed|error` with summary and optional safe error. Only while
  `running`; a second finalize â†’ 409.

## End-to-end smoke test

`npm run smoke` runs the full duplicate-delivery scenario against the live
local stack and verifies the required outcome:

1. Creates a real run through the public API.
2. Polls the run until a terminal state (bounded, default 90 s).
3. Checks: run `passed`, 3 delivery attempts, 3 accepted (2xx) deliveries,
   exactly one business effect.
4. Cleans up the platform run (attempts/assertions cascade) and the receiver
   rows it created â€” even when the check fails.

Exit code `0` = pass, `1` = assertion failure or execution error (CI-friendly).
Prerequisites: Control API, RabbitMQ, Scenario Runner, and the Demo Receiver
(with `RELAYCHECK_TEST_MODE=true`) all running. `DATABASE_URL` and
`SMOKE_DEMO_DATABASE_URL` are used only for cleanup.

### Self-starting variant

`npm run smoke:stack` provisions the local stack for you (infra, receiver in
test mode, API, runner), runs the smoke test, then stops the app processes
again. Requires Docker running, sibling checkouts of the receiver and runner,
and existing builds (`npm run build` once per repo).

## Accounts, workspaces and scoping

Set `AUTH_REQUIRED=true` to enable multi-user mode:

- `POST /api/auth/register` `{ email, password }` â€” creates a user, a personal
  workspace, and a session (httpOnly cookie + `token` in the body).
- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
  (`/me` always answers, reporting `authRequired` and the current user).
- Runs created by a signed-in user are stamped with their workspace; list and
  detail queries are scoped to that workspace (foreign runs return 404).
- Sessions are opaque random tokens stored **hashed** (SHA-256) in
  PostgreSQL; passwords are hashed with scrypt; logout revokes the session.
- `API_AUTH_TOKEN` doubles as a machine credential for local automation/CI:
  it can call public endpoints without a user session (loopback-only tool).

With `AUTH_REQUIRED` unset (the default in `.env.example`), RelayCheck runs in
local mode: no login, all runs visible, and `API_AUTH_TOKEN` optionally guards
access. Existing local-mode runs have no workspace and are not visible in
account mode.

### Workspace roles and invitations

Users can belong to several workspaces and switch the active one.

- Roles: `owner` (manage everything), `admin` (invite/manage non-owners),
  `member` (create/read runs). Enforced server-side; the last owner cannot be
  removed or demoted.
- `GET /api/workspace/members` â€” members of the active workspace.
- `POST /api/workspace/invitations` `{ email?, role }` â€” owner/admin creates a
  **one-time invite token** (valid 7 days, stored hashed). Returned once; the
  dashboard shows it as a `/join?token=...` link (no email is sent).
- `POST /api/workspace/accept-invitation` `{ token }` â€” joins the workspace,
  marks the invite used, and switches the active workspace.
- `POST /api/workspace/switch` `{ workspaceId }` â€” membership required.
- `PATCH /api/workspace/members/:userId` `{ role }` â€” owner only.
- `DELETE /api/workspace/members/:userId` â€” owner/admin (not yourself, never
  the last owner).

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

- `RATE_LIMIT_PER_MINUTE` (default 120, `0` disables) â€” per-IP fixed window on
  public API requests.
- `API_MAX_RUNS_PER_DAY` (default `0` = unlimited) â€” UTC daily run quota;
  exceeding it returns 429.

These are local safeguards, not a multi-tenant quota system.

## Setup

1. Start PostgreSQL (see the workspace root README).
2. `cp .env.example .env` â€” this API owns the `relaycheck` platform database.
3. `npm ci && npm run db:migrate`.

## Commands

- `npm run lint` / `npm run type-check` â€” static checks.
- `npm test` â€” Jest + Supertest e2e suite (validation, 202 success, bounded
  list, 404, SSRF-attempt rejection).
- `npm run build` / `npm start` / `npm run start:dev` â€” build and run on port 3200.

Package manager: **npm** (lockfiles are committed). Node >= 20.
