import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Rate limiting and daily run quota (e2e)', () => {
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
    delete process.env.API_MAX_RUNS_PER_DAY;
    delete process.env.RATE_LIMIT_PER_MINUTE;
    await prisma.outboxEvent.deleteMany({ where: { runId: { in: createdRunIds } } });
    await prisma.testRun.deleteMany({ where: { id: { in: createdRunIds } } });
    await prisma.$disconnect();
    await app.close();
  });

  afterEach(() => {
    delete process.env.API_MAX_RUNS_PER_DAY;
    delete process.env.RATE_LIMIT_PER_MINUTE;
  });

  it('rate-limits public requests', async () => {
    process.env.RATE_LIMIT_PER_MINUTE = '2';
    const server = app.getHttpServer();

    // First requests in this module instance: the window starts empty.
    await request(server).get('/api/runs').expect(200);
    await request(server).get('/api/runs').expect(200);
    const limited = await request(server).get('/api/runs').expect(429);
    expect(limited.body.message).toContain('Rate limit');
  });

  it('enforces the daily run quota', async () => {
    // A high rate limit keeps the previous window from interfering.
    process.env.RATE_LIMIT_PER_MINUTE = '1000';

    // Quota counts all runs created today, so allow exactly one more.
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const today = await prisma.testRun.count({ where: { createdAt: { gte: startOfDay } } });
    process.env.API_MAX_RUNS_PER_DAY = String(today + 1);

    const first = await request(app.getHttpServer())
      .post('/api/runs')
      .send({ scenario: 'duplicate_delivery' })
      .expect(202);
    createdRunIds.push(first.body.runId as string);

    const second = await request(app.getHttpServer())
      .post('/api/runs')
      .send({ scenario: 'duplicate_delivery' })
      .expect(429);
    expect(second.body.message).toContain('quota');
  });
});
