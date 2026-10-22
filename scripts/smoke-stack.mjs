#!/usr/bin/env node
/**
 * Self-starting smoke test: provisions the local stack, runs the end-to-end
 * smoke test, then shuts the app services down again.
 *
 * Requirements: Docker Desktop running; sibling checkouts of
 * relaycheck-demo-receiver and relaycheck-runner next to this repository;
 * each built (`npm run build`) at least once.
 *
 * Usage (from relaycheck-api):
 *   npm run smoke:stack
 *
 * Infrastructure (PostgreSQL/RabbitMQ containers) is started if needed and
 * left running afterwards; app processes are always stopped.
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, '..');
const workspace = path.resolve(apiDir, '..');
const demoDir = path.join(workspace, 'relaycheck-demo-receiver');
const runnerDir = path.join(workspace, 'relaycheck-runner');
const infraDir = path.join(apiDir, 'infra');

const PLATFORM_DB = process.env.DATABASE_URL ?? 'postgresql://relaycheck:relaycheck@localhost:5432/relaycheck';
const DEMO_DB =
  process.env.SMOKE_DEMO_DATABASE_URL ??
  'postgresql://relaycheck:relaycheck@localhost:5432/relaycheck_demo';
const AMQP_URL = process.env.AMQP_URL ?? 'amqp://guest:guest@localhost:5672';
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN ?? 'test-internal-token';

const children = [];

function fail(message) {
  console.error(`[smoke:stack] ${message}`);
  process.exitCode = 1;
}

function assertBuilds() {
  const checks = [
    [path.join(apiDir, 'dist', 'main.js'), 'relaycheck-api'],
    [path.join(demoDir, 'dist', 'main.js'), 'relaycheck-demo-receiver'],
    [path.join(runnerDir, 'dist', 'main.js'), 'relaycheck-runner'],
  ];
  for (const [file, name] of checks) {
    if (!existsSync(file)) {
      throw new Error(`${name} is not built. Run "npm run build" in ${name} first.`);
    }
  }
  if (!existsSync(path.join(infraDir, 'docker-compose.yml'))) {
    throw new Error('infra/docker-compose.yml missing from relaycheck-api.');
  }
}

async function dockerAvailable() {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function startInfra() {
  console.log('[smoke:stack] starting infrastructure');
  execFileSync('docker', ['compose', 'up', '-d'], { cwd: infraDir, stdio: 'inherit' });
}

async function waitHealthy() {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try {
      const pg = execFileSync('docker', ['inspect', '-f', '{{.State.Health.Status}}', 'relaycheck-postgres'])
        .toString()
        .trim();
      const mq = execFileSync('docker', ['inspect', '-f', '{{.State.Health.Status}}', 'relaycheck-rabbitmq'])
        .toString()
        .trim();
      if (pg === 'healthy' && mq === 'healthy') {
        return;
      }
    } catch {
      // Containers may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('Infrastructure did not become healthy within 120s.');
}

async function waitHttp(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        return;
      }
    } catch {
      // Not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${url} did not become ready within ${timeoutMs}ms.`);
}

function startService(name, cwd, env) {
  console.log(`[smoke:stack] starting ${name}`);
  const child = spawn(process.execPath, ['dist/main'], {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'ignore',
  });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[smoke:stack] ${name} exited with code ${code}`);
    }
  });
  children.push({ name, child });
}

function stopServices() {
  for (const { name, child } of children) {
    try {
      child.kill();
      console.log(`[smoke:stack] stopped ${name}`);
    } catch {
      // Already gone.
    }
  }
}

function runSmoke() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join('scripts', 'smoke.mjs')], {
      cwd: apiDir,
      env: {
        ...process.env,
        DATABASE_URL: PLATFORM_DB,
        SMOKE_DEMO_DATABASE_URL: DEMO_DB,
        CONTROL_API_URL: 'http://127.0.0.1:3200',
      },
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function main() {
  try {
    if (!(await dockerAvailable())) {
      throw new Error('Docker is not running. Start Docker Desktop and retry.');
    }
    assertBuilds();
    startInfra();
    await waitHealthy();

    startService('demo-receiver', demoDir, {
      PORT: '3100',
      HOST: '127.0.0.1',
      DATABASE_URL: DEMO_DB,
      RELAYCHECK_TEST_MODE: 'true',
    });
    startService('control-api', apiDir, {
      PORT: '3200',
      HOST: '127.0.0.1',
      DATABASE_URL: PLATFORM_DB,
      AMQP_URL,
      INTERNAL_API_TOKEN: INTERNAL_TOKEN,
    });
    await waitHttp('http://127.0.0.1:3100/api/health');
    await waitHttp('http://127.0.0.1:3200/api/health');

    startService('runner', runnerDir, {
      CONTROL_API_URL: 'http://127.0.0.1:3200',
      INTERNAL_API_TOKEN: INTERNAL_TOKEN,
      DEMO_RECEIVER_URL: 'http://127.0.0.1:3100',
      AMQP_URL,
    });

    const code = await runSmoke();
    if (code !== 0) {
      fail(`smoke test failed with exit code ${code}`);
    } else {
      console.log('[smoke:stack] PASSED');
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    stopServices();
  }
}

await main();
