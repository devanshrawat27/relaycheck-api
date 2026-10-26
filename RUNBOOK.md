# RelayCheck Runbook

Operational guidance for running RelayCheck locally. Each section maps an
observable symptom to the likely cause and the steps to resolve it.

## Where to look

- **Dashboard Diagnostics** (`/diagnostics`): service health, run counts,
  work-queue depth, dead-letter queue depth, outbox backlog.
- **RabbitMQ management UI**: `http://localhost:15672` (guest/guest).
- **Mailpit UI**: `http://localhost:8025` (outbound password-reset and alert mail).
- **Prometheus metrics**: `GET /api/metrics/prometheus`.
- **API health**: `GET /api/health`.

## Symptoms and resolutions

### A run stays `queued` forever
- Likely: the runner is down, the queue is unreachable, or the outbox failed to publish.
- Check: `docker compose -f infra/docker-compose.yml ps` (RabbitMQ healthy); the
  runner process is running; the Diagnostics outbox backlog.
- Fix: start the runner; if the outbox has a backlog, confirm RabbitMQ is reachable
  (`AMQP_URL`) and restart the API so the outbox dispatcher retries.

### A run finalizes `error` with a lease/duplicate message
- Likely: the runner crashed mid-execution and a duplicate job recovered it.
- Check: the run's safe error on the run detail page; runner logs.
- Fix: restart the runner; re-run the scenario. This is safe-at-least-once, so one
  extra attempt may be recorded.

### A run finalizes `failed` (assertion mismatch)
- Likely: the receiver applied an unexpected business effect (or none).
- Check: the run's attempts and assertion expected-vs-actual values; the receiver
  fault state (`GET /api/__test__/faults`), and its business-effect count.
- Fix: clear any injected fault (`DELETE /api/__test__/faults`) and re-run; if the
  mismatch persists, inspect the receiver integration.

### The dead-letter queue is growing
- Likely: malformed or repeatedly-failing jobs.
- Check: the DLQ in the RabbitMQ UI or the diagnostics page.
- Fix: inspect the poison messages, fix the producer/consumer, then replay or purge
  with the DLQ tooling.

### Email alerts or password-reset mail are not arriving
- Likely: `ALERT_EMAIL`/`SMTP_*` unset, or Mailpit is down.
- Check: `SMTP_HOST`/`SMTP_PORT` in `relaycheck-api/.env` (default `localhost:1025`);
  the Mailpit container is running; the Mailpit UI for queued messages.
- Fix: set the SMTP/ALERT vars, ensure `mailpit` is up, restart the API.

### The API is unreachable
- Check: `GET /api/health`; the API process and the Postgres container.
- Fix: start Postgres (`docker compose -f infra/docker-compose.yml up -d postgres`),
  apply migrations (`npx prisma migrate deploy`), then start the API.

## Backups

- Database: `docker exec relaycheck-postgres pg_dumpall -U relaycheck > backup.sql`.
- Restore: `docker exec -i relaycheck-postgres psql -U relaycheck < backup.sql`.
- See `SETUP.md` for the full backup/restore and upgrade procedure.
