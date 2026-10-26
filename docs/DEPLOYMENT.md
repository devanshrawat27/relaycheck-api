# RelayCheck Deployment

Two supported ways to run RelayCheck beyond a single laptop.

## Option A — Single host (Docker Compose + Caddy)

The production stack (`infra/docker-compose.prod.yml`) runs every service behind
Caddy with HTTPS: the Control API, demo receiver, scenario runner, dashboard,
Postgres, and RabbitMQ.

1. Provision a small Linux host (any VPS with Docker + Compose).
2. `git clone` this repo, copy `infra/.env.prod.example` → `infra/.env`, fill in
   real values (`INTERNAL_API_TOKEN`, `API_AUTH_TOKEN`, DB and RabbitMQ
   credentials).
3. `docker compose -f infra/docker-compose.prod.yml up -d --build`.
4. Point your domain at the host; Caddy provisions a certificate.
5. Verify `https://<domain>/api/health` → 200 and the dashboard loads.

Only 80/443 are published; every other service is internal.

---

## Option B — Render (backend) + Vercel (frontend) + CloudAMQP (RabbitMQ)

> **Verified live (2026-10-27):** frontend `https://relaycheck-web.vercel.app`,
> API `https://relaycheck-api.onrender.com`, receiver
> `https://relaycheck-receiver.onrender.com`, runner
> `https://relaycheck-runner.onrender.com` (free web service), Neon Postgres,
> CloudAMQP RabbitMQ. A real run returns `passed` with 3 attempts / 1 effect.

Split deployment: the Next.js dashboard on Vercel, the three backend services
and Postgres on Render, and RabbitMQ on CloudAMQP (Render has no managed
RabbitMQ).

### Architecture

| Piece | Where | Reachable from internet? |
|---|---|---|
| Dashboard (Next.js) | Vercel | yes (public) |
| Control API (NestJS) | Render web service | yes (session-auth required) |
| Scenario Runner (NestJS) | Render **worker** | no (outbound only) |
| Demo Receiver (NestJS) | Render web service | yes (test-mode controls) |
| Postgres (`relaycheck` + `relaycheck_demo`) | Render Postgres | no |
| RabbitMQ | CloudAMQP (TLS) | no (broker URL only) |

The dashboard sets its **own** session cookie and calls the API server-to-server
with `Authorization: Bearer <session>`, so split domains are fine — no CORS and
no cross-domain cookie setup is needed.

### Prerequisites

- **Render** account (backend).
- **Vercel** account (frontend).
- **CloudAMQP** account (free plan) → an `amqps://...` URL.
- Optional: a real SMTP relay for password-reset / alert mail (Brevo, Resend,
  SendGrid, …). Without it the reset link is only logged to the API console.

### 1. RabbitMQ — CloudAMQP

1. Create a free instance (e.g. "Little Lemur").
2. Copy the **AMQP URL** from the instance page. It looks like:
   `amqps://<user>:<password>@<host>.lmq.cloudamqp.com/<vhost>`
3. Keep it secret; you will paste it into the API and runner env vars.

### 2. Postgres — Render

1. Render → **New → Postgres**. Note the internal connection string.
2. Two databases are needed: the API uses `relaycheck`, the demo receiver uses
   `relaycheck_demo`.
3. In the Render Postgres **PSQL** console run:
   ```sql
   CREATE DATABASE relaycheck_demo;
   ```
4. Connection strings (copy from Render and change the trailing database name):
   - API: `postgresql://...@<host>/relaycheck`
   - Receiver: `postgresql://...@<host>/relaycheck_demo`

> **Verified setup (2026-10-27):** the live deployment uses **Neon** (neon.tech,
> free, expires never) with databases `relaycheck` and `relaycheck_demo`, because
> Render's free Postgres is deleted after 30 days. Either works; Neon is the
> free-forever choice. Use the **direct** (non-`-pooler`) host for migrations.

### 3. Control API — Render web service

- **New → Web Service →** connect the `relaycheck-api` repo → **Docker**.
- Health check path: `/api/health`. Port: `3200`.

Environment variables:

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` |
| `PORT` | `3200` |
| `AUTH_REQUIRED` | `true` |
| `DATABASE_URL` | the `.../relaycheck` connection string |
| `AMQP_URL` | the CloudAMQP `amqps://...` URL |
| `INTERNAL_API_TOKEN` | a strong random token (**same value in the runner**) |
| `API_AUTH_TOKEN` | optional automation key; leave unset unless you need it |
| `DEMO_RECEIVER_URL` | the receiver's public URL (set after step 5) |
| `APP_URL` | the Vercel URL (set after step 6; used in reset links) |
| `SMTP_HOST` | e.g. `smtp-relay.brevo.com` (optional) |
| `SMTP_PORT` | e.g. `587` |
| `SMTP_SECURE` | `false` (use STARTTLS on 587) |
| `SMTP_USER` | your SMTP login |
| `SMTP_PASS` | your SMTP password |
| `EMAIL_FROM` | a verified sender address |
| `ALERT_EMAIL` | optional: address to email on run `failed`/`error` |

The image applies Prisma migrations automatically on start.

### 4. Scenario Runner — Render (free web service)

Render has **no free background-worker plan** (workers start at ~$7/month). The
runner now has an optional HTTP health endpoint, so it can run as a **free web
service** instead:

- **New → Web Service →** connect the `relaycheck-runner` repo → **Docker**,
  plan **Free**.
- Health check path: `/`.

| Key | Value |
|---|---|
| `CONTROL_API_URL` | the API's public URL |
| `INTERNAL_API_TOKEN` | **exactly the same** value as the API |
| `DEMO_RECEIVER_URL` | the receiver's public URL |
| `AMQP_URL` | the CloudAMQP `amqps://...` URL |
| `SELF_URL` | this runner's own URL (self-ping keeps the free instance awake) |

The health endpoint is inert locally because `PORT` is unset there. Note that a
free web service can still cold-start; a paid worker is the always-on option.

### 5. Demo Receiver — Render web service

- **New → Web Service →** connect the `relaycheck-demo-receiver` repo → **Docker**.
- Health check path: `/api/health`. Port: `3100`.

| Key | Value |
|---|---|
| `HOST` | `0.0.0.0` |
| `PORT` | `3100` |
| `DATABASE_URL` | the `.../relaycheck_demo` connection string |
| `RELAYCHECK_TEST_MODE` | `true` (scenarios need the fault/oracle controls) |

The image applies Prisma migrations automatically on start.

### 6. Dashboard — Vercel

- **Add New → Project →** import the `relaycheck-web` repo.
- Framework preset: **Next.js** (auto-detected). No build override needed.
- Environment variable:

| Key | Value |
|---|---|
| `CONTROL_API_URL` | the API's public URL (e.g. `https://relaycheck-api.onrender.com`) |

Deploy. Then copy the Vercel production URL into the API's `APP_URL` and
redeploy the API (so password-reset links point at the dashboard).

### 7. Verify

1. `https://<api>/api/health` → `200`.
2. `https://<receiver>/api/health` → `200`.
3. Open the Vercel URL → register an account → run a duplicate-delivery scenario
   → the run reaches `passed` with **3 attempts / 1 business effect**.
4. (Optional) Trigger a failing run and confirm the `ALERT_EMAIL` arrives.

### Caveats

- **Demo receiver test controls are public.** Its `RELAYCHECK_TEST_MODE=true`
  exposes `/api/__test__/faults` and the oracle. The data is fake, but anyone
  who can reach it can inject faults. For a locked-down deployment, put the
  receiver behind an internal network / access control.
- **Free tiers sleep.** Render free web services spin down after ~15 min idle,
  so the first request can take ~1 minute (cold start).
- **RabbitMQ is external.** Keep the CloudAMQP URL (with password) out of git.
- **Secrets never go in a repo or the blueprint.** Set them in the Render /
  Vercel dashboards only. `INFRA/.env` and `.env` are git-ignored.

---

## Requirements and caveats (both options)

- **Credentials:** deployment needs provider accounts; nothing is deployed until
  you provide them.
- **Secrets:** never commit `.env` / `infra/.env`; generate `INTERNAL_API_TOKEN`
  and keep the same value in the API and runner.
- **Email:** password-reset and run-failure alerts use `SMTP_HOST`; without it the
  reset link is logged to the API console. There is no email verification.
- **Certificates:** Option A uses Caddy (internal CA by default — use a real ACME
  certificate for a public domain). Render and Vercel provide TLS automatically.

See `RUNBOOK.md` for operational runbooks and `SETUP.md` for backup/restore.
