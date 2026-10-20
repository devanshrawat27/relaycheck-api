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

  it('GET /api/runs/:id returns 404 for an unknown run id', async () => {
    await request(app.getHttpServer())
      .get('/api/runs/00000000-0000-0000-0000-000000000000')
      .expect(404);
  });
});
