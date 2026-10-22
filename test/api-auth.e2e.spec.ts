import 'dotenv/config';
import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';

const TOKEN = 'test-api-token';

describe('Optional public API token (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  const createdRunIds: string[] = [];

  beforeAll(async () => {
    process.env.API_AUTH_TOKEN = TOKEN;
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
    delete process.env.API_AUTH_TOKEN;
    await app.close();
  });

  it('rejects unauthenticated run requests when a token is configured', async () => {
    await request(app.getHttpServer()).get('/api/runs').expect(401);
    await request(app.getHttpServer())
      .post('/api/runs')
      .send({ scenario: 'duplicate_delivery' })
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/runs')
      .set('authorization', 'Bearer wrong-token')
      .expect(401);
  });

  it('allows requests with the configured bearer token', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/runs')
      .set('authorization', `Bearer ${TOKEN}`)
      .send({ scenario: 'duplicate_delivery' })
      .expect(202);
    createdRunIds.push(created.body.runId as string);

    await request(app.getHttpServer())
      .get('/api/runs')
      .set('authorization', `Bearer ${TOKEN}`)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/api/runs/${created.body.runId}`)
      .set('authorization', `Bearer ${TOKEN}`)
      .expect(200);
  });

  it('keeps health public', async () => {
    await request(app.getHttpServer()).get('/api/health').expect(200);
  });

  it('is harmless when the token is not configured (local default)', async () => {
    delete process.env.API_AUTH_TOKEN;
    await request(app.getHttpServer()).get('/api/runs').expect(200);
    const runId = `sanity-${randomUUID()}`;
    expect(runId).toBeTruthy();
  });
});
