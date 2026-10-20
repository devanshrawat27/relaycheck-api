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
    const msg = await ch.get(RUN_JOBS_QUEUE, { noAck: true });
    if (!msg) {
      throw new Error(`Expected a job in ${RUN_JOBS_QUEUE}, found none`);
    }
    return JSON.parse(msg.content.toString()) as Record<string, unknown>;
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

  it('claims queued -> running once; a second claim is refused (409)', async () => {
    const runId = await createRun();
    await consumeOneJob();

    const claim = await request(server())
      .post(`/api/internal/runs/${runId}/claim`)
      .set('x-internal-token', TOKEN)
      .expect(201);
    expect(claim.body).toEqual({ runId, status: 'running' });

    await request(server())
      .post(`/api/internal/runs/${runId}/claim`)
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

  it('handles publication failure explicitly: run becomes error and POST returns 500', async () => {
    const originalUrl = process.env.AMQP_URL;
    process.env.AMQP_URL = 'amqp://guest:guest@localhost:5999';
    try {
      const res = await request(server())
        .post('/api/runs')
        .send({ scenario: 'duplicate_delivery' });
      expect(res.status).toBe(500);

      // The failing create still leaves a row: look it up to check its state.
      const list = await request(server()).get('/api/runs').query({ take: 5 }).expect(200);
      const failed = (list.body.items as { id: string; status: string }[]).find(
        (i) => i.status === 'error',
      );
      expect(failed).toBeTruthy();
      createdRunIds.push(failed!.id);

      const detail = await request(server()).get(`/api/runs/${failed!.id}`).expect(200);
      expect(detail.body.status).toBe('error');
      expect(detail.body.safeError).toContain('queue');
    } finally {
      process.env.AMQP_URL = originalUrl;
    }
  });
});
