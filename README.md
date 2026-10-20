# RelayCheck Control API

NestJS HTTP API. Validates run requests, creates run records, enqueues run
jobs to RabbitMQ, and serves the public run/result contracts.

Ownership boundaries (see `ARCHITECTURE.md` at the workspace root):

- Sole writer for the RelayCheck platform tables: `test_runs`,
  `delivery_attempts`, `assertion_results`.
- Exposes private authenticated endpoints for Scenario Runner lifecycle and
  evidence updates; these are never public dashboard endpoints.
- Does not execute delivery loops inside HTTP requests and never accepts
  arbitrary destination URLs.

Status: workspace initialized (T001). Implementation starts at T020.
Tasks and acceptance criteria live in `TASKS.md` at the workspace root.

## Commands

- `npm install` - install dependencies (verified from a clean checkout).

`npm run type-check`, `npm run build`, `npm run test`, and `npm run lint` are
added when their service's phase task lands (see `TASKS.md`). No placeholder
scripts are included, so nothing here fails silently.

Package manager: **npm** (lockfiles are committed). Node >= 20.