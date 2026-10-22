#!/usr/bin/env node
/**
 * End-to-end smoke test for the duplicate-delivery scenario.
 *
 * Prerequisites (all running locally):
 *   - Control API            (CONTROL_API_URL, default http://localhost:3200)
 *   - RabbitMQ               (used by the API + runner)
 *   - Scenario Runner        (consumes the job)
 *   - Demo Receiver in test mode (RELAYCHECK_TEST_MODE=true)
 *
 * The script creates a real run, waits for a terminal state, verifies the
 * required assertions, and then deletes the data it created (platform run
 * rows + receiver rows). Exit code 0 = pass, 1 = failure/error.
 *
 * This is test tooling, not a service: it reads DATABASE_URL / SMOKE_DEMO_DATABASE_URL
 * only to clean up the exact rows it created.
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const API_BASE = (process.env.CONTROL_API_URL ?? 'http://localhost:3200').replace(/\/$/, '');
const API_TOKEN = process.env.API_AUTH_TOKEN;
const authHeaders = API_TOKEN ? { authorization: `Bearer ${API_TOKEN}` } : {};
const PLATFORM_DB = process.env.DATABASE_URL;
const DEMO_DB =
  process.env.SMOKE_DEMO_DATABASE_URL ??
  'postgresql://relaycheck:relaycheck@localhost:5432/relaycheck_demo';
const POLL_INTERVAL_MS = Number(process.env.SMOKE_POLL_MS ?? 1500);
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 90000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const startedAt = Date.now();
  let runId = null;
  let orderId = null;
  let eventId = null;
  let failures = 0;

  try {
    const health = await fetch(`${API_BASE}/api/health`).catch(() => null);
    if (!health || !health.ok) {
      throw new Error(
        `Control API is not reachable at ${API_BASE}. Start it before running the smoke test.`,
      );
    }

    const createResponse = await fetch(`${API_BASE}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders },
      body: JSON.stringify({ scenario: 'duplicate_delivery' }),
    });
    if (createResponse.status !== 202) {
      throw new Error(`create-run expected HTTP 202, got ${createResponse.status}`);
    }
    const created = await createResponse.json();
    runId = created.runId;
    console.log(`[smoke] created run ${runId}`);

    const deadline = Date.now() + TIMEOUT_MS;
    let run = null;
    while (Date.now() < deadline) {
      const response = await fetch(`${API_BASE}/api/runs/${runId}`, { headers: authHeaders });
      if (!response.ok) {
        throw new Error(`run detail returned HTTP ${response.status}`);
      }
      run = await response.json();
      if (run.status !== 'queued' && run.status !== 'running') {
        break;
      }
      await sleep(POLL_INTERVAL_MS);
    }

    if (!run || run.status === 'queued' || run.status === 'running') {
      throw new Error(
        `run did not reach a terminal state within ${TIMEOUT_MS}ms (status: ${run?.status ?? 'unknown'})`,
      );
    }

    eventId = run.params && run.params.eventId;
    orderId = run.params && run.params.orderId;

    const attempts = Array.isArray(run.attempts) ? run.attempts : [];
    const assertions = Array.isArray(run.assertions) ? run.assertions : [];
    const delivered = attempts.filter(
      (attempt) =>
        attempt.outcome === 'delivered' &&
        typeof attempt.httpStatus === 'number' &&
        attempt.httpStatus >= 200 &&
        attempt.httpStatus < 300,
    ).length;
    const effectAssertion = assertions.find(
      (assertion) => assertion.name === 'business_effect_applied_once',
    );

    const checks = [
      ['run reached status passed', run.status === 'passed', run.status],
      ['three delivery attempts recorded', attempts.length === 3, attempts.length],
      ['three deliveries accepted (2xx)', delivered === 3, delivered],
      [
        'exactly one business effect applied',
        Boolean(effectAssertion) && effectAssertion.passed === true && effectAssertion.actual === '1',
        effectAssertion ? effectAssertion.actual : 'missing',
      ],
    ];

    for (const [name, ok, actual] of checks) {
      console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${name} (actual: ${actual})`);
      if (!ok) {
        failures += 1;
      }
    }

    const elapsed = Date.now() - startedAt;
    console.log(
      `[smoke] measured: end-to-end ${elapsed} ms, run duration ${
        typeof run.durationMs === 'number' ? `${run.durationMs} ms` : 'unknown'
      } (local machine, single run — not a benchmark)`,
    );
  } catch (error) {
    console.error(`[smoke] ERROR: ${error instanceof Error ? error.message : error}`);
    failures += 1;
  } finally {
    await cleanup({ runId, orderId, eventId });
  }

  if (failures > 0) {
    console.error(`[smoke] FAILED (${failures} problem${failures === 1 ? '' : 's'})`);
    process.exitCode = 1;
    return;
  }
  console.log('[smoke] PASSED');
}

async function cleanup({ runId, orderId, eventId }) {
  if (runId && PLATFORM_DB) {
    const prisma = new PrismaClient({ datasourceUrl: PLATFORM_DB });
    try {
      // Attempts/assertions cascade with the run.
      const deleted = await prisma.testRun.deleteMany({ where: { id: runId } });
      console.log(`[smoke] cleaned platform run rows (${deleted.count})`);
    } catch (error) {
      console.warn(`[smoke] could not clean platform rows: ${error.message}`);
    } finally {
      await prisma.$disconnect();
    }
  }

  if (orderId && eventId) {
    const demo = new PrismaClient({ datasourceUrl: DEMO_DB });
    try {
      await demo.$executeRaw`DELETE FROM business_effects WHERE "orderId" = ${orderId}`;
      await demo.$executeRaw`DELETE FROM demo_orders WHERE id = ${orderId}`;
      await demo.$executeRaw`DELETE FROM processed_events WHERE "eventId" = ${eventId}`;
      console.log('[smoke] cleaned receiver rows');
    } catch (error) {
      console.warn(`[smoke] could not clean receiver rows: ${error.message}`);
    } finally {
      await demo.$disconnect();
    }
  }
}

main().catch((error) => {
  console.error(`[smoke] UNEXPECTED: ${error instanceof Error ? error.stack : error}`);
  process.exitCode = 1;
});

