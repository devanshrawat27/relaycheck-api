import 'dotenv/config';
import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('User accounts, workspaces and run isolation (e2e)', () => {
  jest.setTimeout(60000);

  let app: INestApplication;
  let prisma: PrismaClient;
  const emails: string[] = [];
  const runIds: string[] = [];
  const workspaceIds: string[] = [];

  const password = 'correct-horse-battery';

  beforeAll(async () => {
    process.env.AUTH_REQUIRED = 'true';
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
    delete process.env.AUTH_REQUIRED;
    await prisma.outboxEvent.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.testRun.deleteMany({ where: { id: { in: runIds } } });
    await prisma.user.deleteMany({ where: { email: { in: emails } } });
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await prisma.$disconnect();
    await app.close();
  });

  function email(): string {
    const value = `user-${randomUUID()}@example.test`;
    emails.push(value);
    return value;
  }

  it('registers a user with a personal workspace and an authenticated session', async () => {
    const address = email();
    const register = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: address, password })
      .expect(201);

    expect(register.body.user.email).toBe(address);
    expect(typeof register.body.token).toBe('string');
    expect(typeof register.body.user.workspaceId).toBe('string');
    workspaceIds.push(register.body.user.workspaceId as string);

    const me = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('authorization', `Bearer ${register.body.token}`)
      .expect(200);
    expect(me.body).toMatchObject({ authRequired: true });
    expect(me.body.user.email).toBe(address);
  });

  it('rejects duplicate emails and wrong passwords', async () => {
    const address = email();
    const register = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: address, password })
      .expect(201);
    workspaceIds.push(register.body.user.workspaceId as string);

    await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: address, password })
      .expect(409);

    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: address, password: 'wrong-password' })
      .expect(401);

    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: address, password })
      .expect(200);
  });

  it('requires a session for run endpoints when auth is enabled', async () => {
    await request(app.getHttpServer()).get('/api/runs').expect(401);
    await request(app.getHttpServer())
      .post('/api/runs')
      .send({ scenario: 'duplicate_delivery' })
      .expect(401);
    await request(app.getHttpServer()).get('/api/metrics').expect(401);
  });

  it('isolates runs by workspace', async () => {
    const userA = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: email(), password })
      .expect(201);
    const userB = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: email(), password })
      .expect(201);
    workspaceIds.push(
      userA.body.user.workspaceId as string,
      userB.body.user.workspaceId as string,
    );

    const created = await request(app.getHttpServer())
      .post('/api/runs')
      .set('authorization', `Bearer ${userA.body.token}`)
      .send({ scenario: 'duplicate_delivery' })
      .expect(202);
    const runId = created.body.runId as string;
    runIds.push(runId);

    // A sees it; B must not.
    await request(app.getHttpServer())
      .get(`/api/runs/${runId}`)
      .set('authorization', `Bearer ${userA.body.token}`)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/api/runs/${runId}`)
      .set('authorization', `Bearer ${userB.body.token}`)
      .expect(404);

    const listB = await request(app.getHttpServer())
      .get('/api/runs')
      .set('authorization', `Bearer ${userB.body.token}`)
      .expect(200);
    expect((listB.body.items as { id: string }[]).some((item) => item.id === runId)).toBe(false);

    // The persisted run carries A's workspace.
    const stored = await prisma.testRun.findUnique({ where: { id: runId } });
    expect(stored?.workspaceId).toBe(userA.body.user.workspaceId);
  });

  it('revokes the session on logout', async () => {
    const registered = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: email(), password })
      .expect(201);
    workspaceIds.push(registered.body.user.workspaceId as string);
    const token = registered.body.token as string;

    await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('authorization', `Bearer ${token}`)
      .expect(200);

    await request(app.getHttpServer())
      .get('/api/runs')
      .set('authorization', `Bearer ${token}`)
      .expect(401);

    const me = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(me.body.user).toBeNull();
  });
});
