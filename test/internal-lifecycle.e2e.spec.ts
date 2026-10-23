import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { connect } from 'amqplib';
import type { Channel, ChannelModel } from 'amqplib';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { RUN_JOBS_QUEUE } from '../src/queue/queue.service';

const AMQP = 'amqp://guest:guest@localhost:5672';
const TOKEN = 'test-internal-token';

describe('Queue publication + internal lifecycle contract (e2e)', () => {
  jest.setTimeout(60000);

  let app: INestApplication;
  let prisma: PrismaClient;
  let conn: ChannelModel;
  let ch: Channel;
  const createdRunIds: string[] = [];

  function server(): Parameters<typeof request>[0] {
    return app.getHttpServer();
  }

  async function createRun(): Promise<string> {
    const res = await request(server())
      .post('/api/runs')
      .send({ scenario: 'duplicate_delivery' })
      .expect(202);
    const runId = res.body.runId as string;
    createdRunIds.push(runId);
    return runId;
  }

  async function consumeOneJob(): Promise<Record<string, unknown>> {
    // The outbox dispatcher publishes asynchronously; poll for the message.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const msg = await ch.get(RUN_JOBS_QUEUE, { noAck: true });
      if (msg) {
        return JSON.parse(msg.content.toString()) as Record<string, unknown>;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Expected a job in ${RUN_JOBS_QUEUE}, found none`);
  }

  beforeAll(async () => {
    process.env.INTERNAL_API_TOKEN = TOKEN;
    prisma = new PrismaClient();
    conn = await connect(AMQP);
    ch = await conn.createChannel();
    await ch.assertQueue(RUN_JOBS_QUEUE, { durable: true });
    await ch.purgeQueue(RUN_JOBS_QUEUE);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({ where: { runId: { in: createdRunIds } } });
    await prisma.testRun.deleteMany({ where: { id: { in: createdRunIds } } });
    await prisma.$disconnect();
    await ch.close();
    await conn.close();
    await app.close();
  });

  it('publishes a versioned job after the run is persisted', async () => {
    const runId = await createRun();
    const job = await consumeOneJob();

    expect(job.schemaVersion).toBe(1);
    expect(job.runId).toBe(runId);
    expect(job.scenario).toBe('duplicate_delivery');
    const params = job.params as Record<string, unknown>;
    expect(params.eventType).toBe('payment.succeeded');
    expect(params.deliveryCount).toBe(3);
    expect(String(params.eventId)).toMatch(/^evt_/);
  });

  it('rejects unauthenticated internal writes (missing and wrong token)', async () => {
    const runId = await createRun();
    await consumeOneJob();

    await request(server()).post(`/api/internal/runs/${runId}/claim`).expect(401);
    await request(server())
      .post(`/api/internal/runs/${runId}/claim`)
      .set('x-internal-token', 'wrong-token')
      .expect(401);
    await request(server())
      .post(`/api/internal/runs/${runId}/attempts`)
      .send({
        attemptNumber: 1,
        eventId: 'evt_x',
        outcome: 'delivered',
        durationMs: 1,
      })
      .expect(401);
  });

  it('claims queued -> running once with a lease; a second claim is refused (409)', async () => {
    const runId = await createRun();
    await consumeOneJob();

    const claim = await request(server())
      .post(`/api/internal/runs/${runId}/claim`)
      .set('x-internal-token', TOKEN)
      .send({ workerId: 'test-worker' })
      .expect(201);
    expect(claim.body.runId).toBe(runId);
    expect(claim.body.status).toBe('running');
    expect(typeof claim.body.leaseExpiresAt).toBe('string');

    const second = await request(server())
      .post(`/api/internal/runs/${runId}/claim`)
      .set('x-internal-token', TOKEN)
      .send({ workerId: 'other-worker' })
      .expect(409);
    expect(second.body.status).toBe('running');
    expect(typeof second.body.leaseExpiresAt).toBe('string');
  });

  it('extends the lease only for the owning worker', async () => {
    const runId = await createRun();
    await consumeOneJob();

    await request(server())
      .post(`/api/internal/runs/${runId}/claim`)
      .set('x-internal-token', TOKEN)
      .send({ workerId: 'test-worker' })
      .expect(201);

    await request(server())
      .post(`/api/internal/runs/${runId}/heartbeat`)
      .set('x-internal-token', TOKEN)
      .send({ workerId: 'test-worker' })
      .expect(201);

    await request(server())
      .post(`/api/internal/runs/${runId}/heartbeat`)
      .set('x-internal-token', TOKEN)
      .send({ workerId: 'another-worker' })
      .expect(409);
  });

  it('recovers only a run whose lease has expired (never an active worker)', async () => {
    const runId = await createRun();
    await consumeOneJob();

    await request(server())
      .post(`/api/internal/runs/${runId}/claim`)
      .set('x-internal-token', TOKEN)
      .send({ workerId: 'test-worker' })
      .expect(201);

    // Active lease: recovery must be refused.
    await request(server())
      .post(`/api/internal/runs/${runId}/recover`)
      .set('x-internal-token', TOKEN)
      .expect(409);

    // Simulate an abandoned worker by expiring the lease.
    await prisma.testRun.update({
      where: { id: runId },
      data: { leaseExpiresAt: new Date(Date.now() - 60_000) },
    });

    await request(server())
      .post(`/api/internal/runs/${runId}/recover`)
      .set('x-internal-token', TOKEN)
      .expect(201);

    const detail = await request(server()).get(`/api/runs/${runId}`).expect(200);
    expect(detail.body.status).toBe('error');
    expect(detail.body.safeError).toContain('lease expired');

    // Already recovered: second recovery is refused.
    await request(server())
      .post(`/api/internal/runs/${runId}/recover`)
      .set('x-internal-token', TOKEN)
      .expect(409);
  });

  it('records attempt + assertion evidence, then finalizes to a terminal state', async () => {
    const runId = await createRun();
    const job = await consumeOneJob();
    const eventId = (job.params as { eventId: string }).eventId;

    await request(server())
      .post(`/api/internal/runs/${runId}/claim`)
      .set('x-internal-token', TOKEN)
      .send({ workerId: 'test-worker' })
      .expect(201);

    await request(server())
      .post(`/api/internal/runs/${runId}/attempts`)
      .set('x-internal-token', TOKEN)
      .send({
        attemptNumber: 1,
        eventId,
        outcome: 'delivered',
        httpStatus: 200,
        durationMs: 42,
      })
      .expect(201);

    await request(server())
      .post(`/api/internal/runs/${runId}/assertions`)
      .set('x-internal-token', TOKEN)
      .send({
        name: 'business_effect_applied_once',
        expected: '1',
        actual: '1',
        passed: true,
      })
      .expect(201);

    await request(server())
      .post(`/api/internal/runs/${runId}/finalize`)
      .set('x-internal-token', TOKEN)
      .send({ status: 'passed', summary: 'All assertions passed' })
      .expect(201);

    // finalize twice → conflict; the run is already terminal
    await request(server())
      .post(`/api/internal/runs/${runId}/finalize`)
      .set('x-internal-token', TOKEN)
      .send({ status: 'passed', summary: 'All assertions passed' })
      .expect(409);

    const detail = await request(server()).get(`/api/runs/${runId}`).expect(200);
    expect(detail.body.status).toBe('passed');
    expect(detail.body.summary).toBe('All assertions passed');
    expect(typeof detail.body.durationMs).toBe('number');
    expect(detail.body.finishedAt).toBeTruthy();
    expect(detail.body.attempts).toHaveLength(1);
    expect(detail.body.attempts[0]).toMatchObject({
      attemptNumber: 1,
      outcome: 'delivered',
      httpStatus: 200,
      durationMs: 42,
    });
    expect(detail.body.assertions).toHaveLength(1);
    expect(detail.body.assertions[0].name).toBe('business_effect_applied_once');
  });

  it('exposes complete attempt and assertion evidence in run details', async () => {
    const runId = await createRun();
    const job = await consumeOneJob();
    const eventId = (job.params as { eventId: string }).eventId;

    await request(server())
      .post(`/api/internal/runs/${runId}/claim`)
      .set('x-internal-token', TOKEN)
      .send({ workerId: 'test-worker' })
      .expect(201);

    for (const attemptNumber of [1, 2, 3]) {
      await request(server())
        .post(`/api/internal/runs/${runId}/attempts`)
        .set('x-internal-token', TOKEN)
        .send({
          attemptNumber,
          eventId,
          outcome: 'delivered',
          httpStatus: 201,
          durationMs: 10 + attemptNumber,
        })
        .expect(201);
    }

    const assertionPayloads = [
      { name: 'delivery_attempt_count', expected: '3', actual: '3', passed: true },
      { name: 'deliveries_accepted', expected: '3', actual: '3', passed: true },
      { name: 'business_effect_applied_once', expected: '1', actual: '1', passed: true },
    ];
    for (const payload of assertionPayloads) {
      await request(server())
        .post(`/api/internal/runs/${runId}/assertions`)
        .set('x-internal-token', TOKEN)
        .send(payload)
        .expect(201);
    }

    await request(server())
      .post(`/api/internal/runs/${runId}/finalize`)
      .set('x-internal-token', TOKEN)
      .send({ status: 'passed', summary: '3 attempts, 1 business effect' })
      .expect(201);

    const detail = await request(server()).get(`/api/runs/${runId}`).expect(200);
    const attempts = detail.body.attempts as {
      attemptNumber: number;
      eventId: string;
      httpStatus: number;
      outcome: string;
      durationMs: number;
    }[];
    expect(attempts).toHaveLength(3);
    expect(attempts.map((a) => a.attemptNumber)).toEqual([1, 2, 3]);
    expect(attempts.every((a) => a.eventId === eventId)).toBe(true);
    expect(attempts.every((a) => a.outcome === 'delivered' && a.httpStatus === 201)).toBe(true);
    expect(attempts.map((a) => a.durationMs)).toEqual([11, 12, 13]);

    const assertions = detail.body.assertions as {
      name: string;
      expected: string;
      actual: string;
      passed: boolean;
    }[];
    expect(assertions.map(({ name, expected, actual, passed }) => ({ name, expected, actual, passed }))).toEqual(
      assertionPayloads,
    );
  });

  it('resumes an abandoned run and exposes recorded progress (internal only)', async () => {
    const runId = await createRun();
    const job = await consumeOneJob();
    const eventId = (job.params as { eventId: string }).eventId;

    await request(server())
      .post(`/api/internal/runs/${runId}/claim`)
      .set('x-internal-token', TOKEN)
      .send({ workerId: 'first-worker' })
      .expect(201);

    await request(server())
      .post(`/api/internal/runs/${runId}/attempts`)
      .set('x-internal-token', TOKEN)
      .send({
        attemptNumber: 1,
        eventId,
        outcome: 'delivered',
        httpStatus: 200,
        durationMs: 25,
      })
      .expect(201);

    // The progress endpoint is internal-only.
    await request(server()).get(`/api/internal/runs/${runId}/progress`).expect(401);

    const progress = await request(server())
      .get(`/api/internal/runs/${runId}/progress`)
      .set('x-internal-token', TOKEN)
      .expect(200);
    expect(progress.body.status).toBe('running');
    expect(progress.body.attempts).toHaveLength(1);
    expect(progress.body.attempts[0]).toMatchObject({ attemptNumber: 1, outcome: 'delivered' });

    // Simulate an abandoned worker, then take the run over.
    await prisma.testRun.update({
      where: { id: runId },
      data: { leaseExpiresAt: new Date(Date.now() - 60_000) },
    });

    const resumed = await request(server())
      .post(`/api/internal/runs/${runId}/resume-claim`)
      .set('x-internal-token', TOKEN)
      .send({ workerId: 'resuming-worker' })
      .expect(201);
    expect(typeof resumed.body.leaseExpiresAt).toBe('string');

    // An active lease cannot be resumed again.
    await request(server())
      .post(`/api/internal/runs/${runId}/resume-claim`)
      .set('x-internal-token', TOKEN)
      .send({ workerId: 'other-worker' })
      .expect(409);

    await request(server())
      .post(`/api/internal/runs/${runId}/finalize`)
      .set('x-internal-token', TOKEN)
      .send({ status: 'passed', summary: 'resumed and finished' })
      .expect(201);

    const detail = await request(server()).get(`/api/runs/${runId}`).expect(200);
    expect(detail.body.status).toBe('passed');
    expect(detail.body.attempts).toHaveLength(1);
  });

  it('rejects attempts on a queued (not claimed) run', async () => {
    const runId = await createRun();
    await consumeOneJob();

    await request(server())
      .post(`/api/internal/runs/${runId}/attempts`)
      .set('x-internal-token', TOKEN)
      .send({
        attemptNumber: 1,
        eventId: 'evt_x',
        outcome: 'delivered',
        durationMs: 1,
      })
      .expect(409);
  });

  it('keeps the run queued and retries via the outbox when the broker is unavailable', async () => {
    const originalUrl = process.env.AMQP_URL;
    process.env.AMQP_URL = 'amqp://guest:guest@localhost:5999';
    let runId = '';
    try {
      const res = await request(server())
        .post('/api/runs')
        .send({ scenario: 'duplicate_delivery' })
        .expect(202);
      runId = res.body.runId as string;
      createdRunIds.push(runId);

      // The run is persisted and still queued; the job payload is pending.
      const detail = await request(server()).get(`/api/runs/${runId}`).expect(200);
      expect(detail.body.status).toBe('queued');

      // The dispatcher may be mid-claim; wait until the failed publish has
      // returned the row to `pending`.
      let outbox: { status: string; attempts: number }[] = [];
      const outboxDeadline = Date.now() + 10000;
      while (Date.now() < outboxDeadline) {
        outbox = await prisma.outboxEvent.findMany({
          where: { runId },
          select: { status: true, attempts: true },
        });
        if (outbox.length === 1 && outbox[0]?.status === 'pending' && outbox[0].attempts >= 1) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.status).toBe('pending');
      expect(outbox[0]?.attempts).toBeGreaterThanOrEqual(1);
    } finally {
      process.env.AMQP_URL = originalUrl;
    }

    // Once the broker is reachable again, the dispatcher publishes the job.
    const job = await consumeOneJob();
    expect(job.runId).toBe(runId);
    const after = await request(server()).get(`/api/runs/${runId}`).expect(200);
    expect(after.body.status).toBe('queued');
  });
});

