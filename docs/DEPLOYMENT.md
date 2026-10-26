# RelayCheck Deployment

Two ways to run RelayCheck publicly. Both reuse the existing Docker images and
production Compose stack from `infra/`.

## Option A — Single host (recommended)

The production stack (`infra/docker-compose.prod.yml`) already runs every
service behind Caddy with HTTPS: the Control API, demo receiver, scenario
runner, dashboard, Postgres, and RabbitMQ.

1. Provision a small Linux host (any VPS: DigitalOcean, Hetzner, AWS EC2, ...).
2. Install Docker + Compose, clone this repository.
3. Copy `infra/.env.prod.example` to `infra/.env` and fill in real values
   (`INTERNAL_API_TOKEN`, `API_AUTH_TOKEN`, DB and RabbitMQ credentials).
4. `docker compose -f infra/docker-compose.prod.yml up -d --build`.
5. Point your domain's A/AAAA records at the host; Caddy provisions an internal
   CA certificate (see `SETUP.md` for trusting it, or swap in a real certificate).
6. Verify: `https://<domain>/api/health` returns 200 and the dashboard loads.

Only ports 80/443 are published; every other service is internal to the Compose
network.

## Option B — Render (API + Postgres blueprint)

`render.yaml` deploys the Control API as a web service with a managed Postgres.

1. Push this repository to GitHub and connect it in Render as a Blueprint.
2. Replace the `YOUR_*` placeholders in `render.yaml` (dashboard domain, email,
   RabbitMQ host) before the first deploy.
3. RabbitMQ, Mailpit, the demo receiver, the runner, and the dashboard must run
   separately (see Option A) — Render has no native RabbitMQ service.

## Requirements and caveats

- **Credentials:** actual deployment needs a host/provider account; the config
  here is complete but nothing is deployed until you provide one.
- **Secrets:** never commit `infra/.env`; generate `INTERNAL_API_TOKEN` and
  `API_AUTH_TOKEN`, and set the same `INTERNAL_API_TOKEN` in the runner.
- **Certificates:** the Compose stack uses Caddy's internal CA by default; use a
  real ACME certificate for a public domain.
- **Email:** password-reset and run-failure alert mail goes through `SMTP_HOST`
  (Mailpit locally); point it at a real SMTP relay for production mail. There is
  no email verification.

See `RUNBOOK.md` for operational runbooks and `SETUP.md` for backup/restore.
