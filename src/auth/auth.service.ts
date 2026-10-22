import { randomUUID, scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { AuthContext, PublicIdentity } from './auth.types';
import { hashToken, randomToken } from './tokens';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

export const SESSION_COOKIE = 'relaycheck_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface IssuedSession {
  token: string;
  user: PublicIdentity;
}

/**
 * Minimal multi-user auth: users belong to workspaces (tenants), sessions are
 * opaque tokens stored hashed in PostgreSQL and revocable by logout or expiry.
 * Passwords are hashed with scrypt (no external dependencies).
 */
@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  private async hashPassword(password: string): Promise<string> {
    const salt = randomToken(16);
    const derived = (await scryptAsync(password, salt, 64)).toString('hex');
    return `scrypt$${salt}$${derived}`;
  }

  private async verifyPassword(password: string, stored: string): Promise<boolean> {
    const [scheme, salt, hash] = stored.split('$');
    if (scheme !== 'scrypt' || !salt || !hash) {
      return false;
    }
    const derived = await scryptAsync(password, salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  }

  private async issueSession(userId: string, activeWorkspaceId: string | null): Promise<string> {
    const token = randomToken(32);
    await this.prisma.session.create({
      data: {
        id: hashToken(token),
        userId,
        activeWorkspaceId,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      },
    });
    return token;
  }

  /** Resolve the user's identity in their preferred (else first) workspace. */
  async identityFor(userId: string, preferredWorkspaceId?: string | null): Promise<PublicIdentity> {
    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      include: { user: true, workspace: true },
      orderBy: { createdAt: 'asc' },
    });
    if (memberships.length === 0) {
      throw new UnauthorizedException('User has no workspace');
    }
    const active =
      memberships.find((membership) => membership.workspaceId === preferredWorkspaceId) ??
      memberships[0]!;

    return {
      id: active.userId,
      email: active.user.email,
      role: active.user.role,
      workspaceId: active.workspaceId,
      workspaceName: active.workspace.name,
      workspaceRole: active.role,
      workspaces: memberships.map((membership) => ({
        id: membership.workspaceId,
        name: membership.workspace.name,
        role: membership.role,
      })),
    };
  }

  async register(email: string, password: string): Promise<IssuedSession> {
    const normalized = email.trim().toLowerCase();
    const passwordHash = await this.hashPassword(password);
    const userId = randomUUID();
    const workspaceId = randomUUID();

    try {
      await this.prisma.$transaction([
        this.prisma.user.create({
          data: { id: userId, email: normalized, passwordHash },
        }),
        this.prisma.workspace.create({
          data: { id: workspaceId, name: `${normalized}'s workspace` },
        }),
        this.prisma.membership.create({
          data: { userId, workspaceId, role: 'owner' },
        }),
      ]);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Email is already registered');
      }
      throw error;
    }

    const token = await this.issueSession(userId, workspaceId);
    return { token, user: await this.identityFor(userId, workspaceId) };
  }

  async login(email: string, password: string): Promise<IssuedSession> {
    const normalized = email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email: normalized } });
    if (!user || !(await this.verifyPassword(password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid email or password');
    }
    const membership = await this.prisma.membership.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
    });
    if (!membership) {
      throw new UnauthorizedException('User has no workspace');
    }
    const token = await this.issueSession(user.id, membership.workspaceId);
    return { token, user: await this.identityFor(user.id, membership.workspaceId) };
  }

  async logout(token: string | null): Promise<void> {
    if (!token) {
      return;
    }
    await this.prisma.session.deleteMany({ where: { id: hashToken(token) } });
  }

  async resolveToken(token: string | null): Promise<AuthContext | null> {
    if (!token) {
      return null;
    }
    const session = await this.prisma.session.findUnique({
      where: { id: hashToken(token) },
      include: { user: true },
    });
    if (!session) {
      return null;
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      await this.prisma.session.deleteMany({ where: { id: session.id } });
      return null;
    }
    const identity = await this.identityFor(session.userId, session.activeWorkspaceId);
    return {
      userId: identity.id,
      sessionId: session.id,
      email: identity.email,
      role: identity.role,
      workspaceId: identity.workspaceId,
      workspaceName: identity.workspaceName,
      workspaceRole: identity.workspaceRole,
      memberships: identity.workspaces,
    };
  }

  /** Switch the session's active workspace (membership required). */
  async switchWorkspace(
    userId: string,
    sessionId: string,
    workspaceId: string,
  ): Promise<PublicIdentity> {
    const membership = await this.prisma.membership.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
    });
    if (!membership) {
      throw new BadRequestException('You are not a member of that workspace');
    }
    await this.prisma.session.updateMany({
      where: { id: sessionId, userId },
      data: { activeWorkspaceId: workspaceId },
    });
    return this.identityFor(userId, workspaceId);
  }

  /** Join a workspace via a one-time invitation token. */
  async acceptInvitation(
    userId: string,
    sessionId: string,
    token: string,
  ): Promise<PublicIdentity> {
    const invitation = await this.prisma.invitation.findUnique({
      where: { tokenHash: hashToken(token) },
    });
    if (!invitation || invitation.acceptedAt || invitation.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('Invitation is invalid, used, or expired');
    }

    const existing = await this.prisma.membership.findUnique({
      where: {
        userId_workspaceId: { userId, workspaceId: invitation.workspaceId },
      },
    });
    if (!existing) {
      await this.prisma.membership.create({
        data: {
          userId,
          workspaceId: invitation.workspaceId,
          role: invitation.role,
        },
      });
    }
    await this.prisma.invitation.update({
      where: { id: invitation.id },
      data: { acceptedAt: new Date() },
    });
    await this.prisma.session.updateMany({
      where: { id: sessionId, userId },
      data: { activeWorkspaceId: invitation.workspaceId },
    });
    return this.identityFor(userId, invitation.workspaceId);
  }

  /** Accepts `Authorization: Bearer <token>` or the session cookie. */
  tokenFromRequest(request: Request): string | null {
    const authorization = request.header('authorization') ?? '';
    if (authorization.startsWith('Bearer ')) {
      return authorization.slice('Bearer '.length).trim() || null;
    }
    const cookieHeader = request.header('cookie') ?? '';
    for (const part of cookieHeader.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === SESSION_COOKIE) {
        return rest.join('=') || null;
      }
    }
    return null;
  }

  isAuthRequired(): boolean {
    return process.env.AUTH_REQUIRED === 'true';
  }
}
