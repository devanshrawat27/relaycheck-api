import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { AuthContext, PublicIdentity } from './auth.types';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

export const SESSION_COOKIE = 'relaycheck_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_BYTES = 32;

export interface IssuedSession {
  token: string;
  user: PublicIdentity;
}

/**
 * Minimal multi-user auth: users belong to a workspace (tenant), sessions are
 * opaque tokens stored hashed in PostgreSQL and revocable by logout or expiry.
 * Passwords are hashed with scrypt (no external dependencies).
 */
@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16).toString('hex');
    const derived = await scryptAsync(password, salt, 64);
    return `scrypt$${salt}$${derived.toString('hex')}`;
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

  private async issueSession(userId: string): Promise<string> {
    const token = randomBytes(TOKEN_BYTES).toString('hex');
    await this.prisma.session.create({
      data: {
        id: this.hashToken(token),
        userId,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      },
    });
    return token;
  }

  private async identityFor(userId: string): Promise<PublicIdentity> {
    const membership = await this.prisma.membership.findFirst({
      where: { userId },
      include: { user: true, workspace: true },
    });
    if (!membership) {
      throw new UnauthorizedException('User has no workspace');
    }
    return {
      id: membership.userId,
      email: membership.user.email,
      role: membership.user.role,
      workspaceId: membership.workspaceId,
      workspaceName: membership.workspace.name,
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

    const token = await this.issueSession(userId);
    return { token, user: await this.identityFor(userId) };
  }

  async login(email: string, password: string): Promise<IssuedSession> {
    const normalized = email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email: normalized } });
    if (!user || !(await this.verifyPassword(password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid email or password');
    }
    const token = await this.issueSession(user.id);
    return { token, user: await this.identityFor(user.id) };
  }

  async logout(token: string | null): Promise<void> {
    if (!token) {
      return;
    }
    await this.prisma.session.deleteMany({ where: { id: this.hashToken(token) } });
  }

  async resolveToken(token: string | null): Promise<AuthContext | null> {
    if (!token) {
      return null;
    }
    const session = await this.prisma.session.findUnique({
      where: { id: this.hashToken(token) },
      include: { user: true },
    });
    if (!session) {
      return null;
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      await this.prisma.session.deleteMany({ where: { id: session.id } });
      return null;
    }
    const identity = await this.identityFor(session.userId);
    return { ...identity, userId: identity.id };
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

