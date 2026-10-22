import 'dotenv/config';
import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Workspace roles, invitations and switching (e2e)', () => {
  jest.setTimeout(60000);

  let app: INestApplication;
  let prisma: PrismaClient;
  const emails: string[] = [];
  const workspaceIds: string[] = [];
  const runIds: string[] = [];

  const password = 'correct-horse-battery';

  beforeAll(async () => {
    process.env.AUTH_REQUIRED = 'true';
    process.env.API_MAX_RUNS_PER_DAY = '0';
    process.env.RATE_LIMIT_PER_MINUTE = '0';
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
    delete process.env.API_MAX_RUNS_PER_DAY;
    delete process.env.RATE_LIMIT_PER_MINUTE;
    await prisma.outboxEvent.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.testRun.deleteMany({ where: { id: { in: runIds } } });
    await prisma.user.deleteMany({ where: { email: { in: emails } } });
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await prisma.$disconnect();
    await app.close();
  });

  function email(): string {
    const value = `ws-${randomUUID()}@example.test`;
    emails.push(value);
    return value;
  }

  async function register(address: string, label: string) {
    const response = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: address, password })
      .expect(201);
    workspaceIds.push(response.body.user.workspaceId as string);
    return {
      token: response.body.token as string,
      userId: response.body.user.id as string,
      workspaceId: response.body.user.workspaceId as string,
      label,
    };
  }

  it('supports invitations, role changes, scoped runs and workspace switching', async () => {
    const owner = await register(email(), 'owner');
    const ownerAuth = { authorization: `Bearer ${owner.token}` };

    // Invite a member and accept with a second account.
    const invite = await request(app.getHttpServer())
      .post('/api/workspace/invitations')
      .set(ownerAuth)
      .send({ email: 'invitee@example.test', role: 'member' })
      .expect(201);
    expect(typeof invite.body.token).toBe('string');

    const member = await register(email(), 'member');
    const memberAuth = { authorization: `Bearer ${member.token}` };

    const accepted = await request(app.getHttpServer())
      .post('/api/workspace/accept-invitation')
      .set(memberAuth)
      .send({ token: invite.body.token })
      .expect(201);
    expect(accepted.body.workspaceId).toBe(owner.workspaceId);
    expect(accepted.body.workspaceRole).toBe('member');
    expect(accepted.body.workspaces).toHaveLength(2);

    // Reusing the token is rejected.
    await request(app.getHttpServer())
      .post('/api/workspace/accept-invitation')
      .set(memberAuth)
      .send({ token: invite.body.token })
      .expect(400);

    // Both see the same workspace; member can create a run, owner sees it.
    const created = await request(app.getHttpServer())
      .post('/api/runs')
      .set(memberAuth)
      .send({ scenario: 'duplicate_delivery' })
      .expect(202);
    runIds.push(created.body.runId as string);

    const ownerList = await request(app.getHttpServer())
      .get('/api/runs')
      .set(ownerAuth)
      .expect(200);
    expect((ownerList.body.items as { id: string }[]).some((i) => i.id === created.body.runId)).toBe(
      true,
    );

    // Members cannot invite; owners promote to admin, who then can.
    await request(app.getHttpServer())
      .post('/api/workspace/invitations')
      .set(memberAuth)
      .send({ role: 'member' })
      .expect(403);

    await request(app.getHttpServer())
      .patch(`/api/workspace/members/${member.userId}`)
      .set(ownerAuth)
      .send({ role: 'admin' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/workspace/invitations')
      .set(memberAuth)
      .send({ role: 'member' })
      .expect(201);

    // Admins cannot remove the owner; the last owner cannot be demoted.
    await request(app.getHttpServer())
      .delete(`/api/workspace/members/${owner.userId}`)
      .set(memberAuth)
      .expect(403);
    await request(app.getHttpServer())
      .patch(`/api/workspace/members/${owner.userId}`)
      .set(ownerAuth)
      .send({ role: 'member' })
      .expect(400);
    await request(app.getHttpServer())
      .delete(`/api/workspace/members/${owner.userId}`)
      .set(ownerAuth)
      .expect(409);

    // Switching back to the member's personal workspace hides owner runs.
    const switched = await request(app.getHttpServer())
      .post('/api/workspace/switch')
      .set(memberAuth)
      .send({ workspaceId: member.workspaceId })
      .expect(201);
    expect(switched.body.workspaceId).toBe(member.workspaceId);

    const ownList = await request(app.getHttpServer())
      .get('/api/runs')
      .set(memberAuth)
      .expect(200);
    expect((ownList.body.items as { id: string }[]).some((i) => i.id === created.body.runId)).toBe(
      false,
    );
  });

  it('rejects switching to a workspace you do not belong to', async () => {
    const user = await register(email(), 'outsider');
    const other = await register(email(), 'other');
    await request(app.getHttpServer())
      .post('/api/workspace/switch')
      .set('authorization', `Bearer ${user.token}`)
      .send({ workspaceId: other.workspaceId })
      .expect(400);
  });
});
