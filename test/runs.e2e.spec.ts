import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Control API runs endpoints (e2e)', () => {
  jest.setTimeout(30000);

  let app: INestApplication;
  let prisma: PrismaClient;
  const createdRunIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaClient();
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
    await app.close();
  });

  it('GET /api/health returns ok', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(res.body).toEqual({ status: 'ok', service: 'control-api' });
  });

  it('POST /api/runs creates a queued run (202) and its params are server-generated', async () => {
    const server = app.getHttpServer();
    const res = await request(server)
      .post('/api/runs')
      .send({ scenario: 'duplicate_delivery' })
      .expect(202);

    expect(res.body.status).toBe('queued');
    expect(res.body.scenario).toBe('duplicate_delivery');
    expect(typeof res.body.runId).toBe('string');
    createdRunIds.push(res.body.runId as string);

    const detail = await request(server).get(`/api/runs/${res.body.runId}`).expect(200);
    // persisted run shape: status, scenario identifier, timestamps, summary
    expect(detail.body.status).toBe('queued');
    expect(detail.body.scenario).toBe('duplicate_delivery');
    expect(typeof detail.body.createdAt).toBe('string');
    expect(detail.body.startedAt).toBeNull();
    expect(detail.body.finishedAt).toBeNull();
    expect(detail.body.summary).toContain('3 deliveries');
    const params = detail.body.params as Record<string, unknown>;
    expect(params.eventType).toBe('payment.succeeded');
    expect(params.deliveryCount).toBe(3);
    expect(params.timeoutMs).toBe(5000);
    expect(String(params.eventId)).toMatch(/^evt_/);
    // destination is never in params — the runner uses a fixed configured target
    expect('destinationUrl' in params).toBe(false);
    expect('url' in params).toBe(false);
    expect(Array.isArray(detail.body.attempts)).toBe(true);
    expect(Array.isArray(detail.body.assertions)).toBe(true);
  });

  it('POST /api/runs creates a receiver_failure run with bounded params', async () => {
    const server = app.getHttpServer();
    const res = await request(server)
      .post('/api/runs')
      .send({ scenario: 'receiver_failure' })
      .expect(202);
    expect(res.body.scenario).toBe('receiver_failure');
    createdRunIds.push(res.body.runId as string);

    const detail = await request(server).get(`/api/runs/${res.body.runId}`).expect(200);
    const params = detail.body.params as Record<string, unknown>;
    expect(params.deliveryCount).toBe(1);
    expect(params.timeoutMs).toBe(3000);
    expect(detail.body.summary).toContain('controlled 503');
  });

  it('POST /api/runs creates a receiver_timeout run with a bounded timeout', async () => {
    const server = app.getHttpServer();
    const res = await request(server)
      .post('/api/runs')
      .send({ scenario: 'receiver_timeout' })
      .expect(202);
    createdRunIds.push(res.body.runId as string);

    const detail = await request(server).get(`/api/runs/${res.body.runId}`).expect(200);
    const params = detail.body.params as Record<string, unknown>;
    expect(params.deliveryCount).toBe(1);
    expect(params.timeoutMs).toBe(1000);
    expect(detail.body.summary).toContain('timed out');
  });

  it('honors bounded custom parameters per scenario', async () => {
    const server = app.getHttpServer();

    const duplicate = await request(server)
      .post('/api/runs')
      .send({ scenario: 'duplicate_delivery', deliveryCount: 5, timeoutMs: 2000 })
      .expect(202);
    createdRunIds.push(duplicate.body.runId as string);
    const duplicateDetail = await request(server)
      .get(`/api/runs/${duplicate.body.runId}`)
      .expect(200);
    expect(duplicateDetail.body.params.deliveryCount).toBe(5);
    expect(duplicateDetail.body.params.timeoutMs).toBe(2000);
    expect(duplicateDetail.body.summary).toContain('5 deliveries');

    const failure = await request(server)
      .post('/api/runs')
      .send({ scenario: 'receiver_failure', httpStatus: 429, timeoutMs: 2500 })
      .expect(202);
    createdRunIds.push(failure.body.runId as string);
    const failureDetail = await request(server)
      .get(`/api/runs/${failure.body.runId}`)
      .expect(200);
    expect(failureDetail.body.params.httpStatus).toBe(429);
    expect(failureDetail.body.summary).toContain('429');

    const timeout = await request(server)
      .post('/api/runs')
      .send({ scenario: 'receiver_timeout', timeoutMs: 800, delayMs: 1500 })
      .expect(202);
    createdRunIds.push(timeout.body.runId as string);
    const timeoutDetail = await request(server)
      .get(`/api/runs/${timeout.body.runId}`)
      .expect(200);
    expect(timeoutDetail.body.params.delayMs).toBe(1500);
    expect(timeoutDetail.body.params.timeoutMs).toBe(800);
  });

  it('rejects parameters that do not apply to the scenario', async () => {
    const server = app.getHttpServer();
    await request(server)
      .post('/api/runs')
      .send({ scenario: 'duplicate_delivery', httpStatus: 500 })
      .expect(400);
    await request(server)
      .post('/api/runs')
      .send({ scenario: 'receiver_failure', delayMs: 2000 })
      .expect(400);
    await request(server)
      .post('/api/runs')
      .send({ scenario: 'receiver_timeout', httpStatus: 500 })
      .expect(400);
  });

  it('rejects out-of-bounds and contradictory parameters', async () => {
    const server = app.getHttpServer();
    await request(server)
      .post('/api/runs')
      .send({ scenario: 'duplicate_delivery', deliveryCount: 9 })
      .expect(400);
    await request(server)
      .post('/api/runs')
      .send({ scenario: 'duplicate_delivery', timeoutMs: 100 })
      .expect(400);
    await request(server)
      .post('/api/runs')
      .send({ scenario: 'receiver_timeout', timeoutMs: 1000, delayMs: 500 })
      .expect(400);
  });

  it('POST /api/runs rejects an unknown scenario (400)', async () => {
    await request(app.getHttpServer())
      .post('/api/runs')
      .send({ scenario: 'mass_refund_everything' })
      .expect(400);
  });

  it('POST /api/runs rejects a missing scenario (400)', async () => {
    await request(app.getHttpServer()).post('/api/runs').send({}).expect(400);
  });

  it('POST /api/runs rejects user-controlled destination input (400)', async () => {
    await request(app.getHttpServer())
      .post('/api/runs')
      .send({ scenario: 'duplicate_delivery', destinationUrl: 'https://evil.example.com/' })
      .expect(400);
  });

  it('GET /api/runs returns the created run in a bounded list', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/runs')
      .query({ take: 10 })
      .expect(200);

    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items.length).toBeLessThanOrEqual(10);
    const ids = (res.body.items as { id: string }[]).map((i) => i.id);
    expect(ids).toContain(createdRunIds[0]);
  });

  it('GET /api/runs rejects an out-of-range take parameter (400)', async () => {
    await request(app.getHttpServer()).get('/api/runs').query({ take: 500 }).expect(400);
  });

  it('paginates with an opaque cursor', async () => {
    const server = app.getHttpServer();
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const created = await request(server)
        .post('/api/runs')
        .send({ scenario: 'duplicate_delivery' })
        .expect(202);
      ids.push(created.body.runId as string);
      createdRunIds.push(created.body.runId as string);
    }

    const first = await request(server).get('/api/runs').query({ take: 2 }).expect(200);
    expect(first.body.items).toHaveLength(2);
    expect(typeof first.body.nextCursor).toBe('string');

    const second = await request(server)
      .get('/api/runs')
      .query({ take: 2, cursor: first.body.nextCursor })
      .expect(200);
    const firstIds = (first.body.items as { id: string }[]).map((i) => i.id);
    const secondIds = (second.body.items as { id: string }[]).map((i) => i.id);
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
    expect([...firstIds, ...secondIds].filter((id) => ids.includes(id))).toHaveLength(3);
  });

  it('GET /api/runs/:id returns 404 for an unknown run id', async () => {
    await request(app.getHttpServer())
      .get('/api/runs/00000000-0000-0000-0000-000000000000')
      .expect(404);
  });
});
