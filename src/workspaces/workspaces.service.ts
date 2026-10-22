import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthContext, PublicIdentity } from '../auth/auth.types';
import { AuthService } from '../auth/auth.service';
import { hashToken, randomToken } from '../auth/tokens';
import { InviteMemberDto, MemberRole, UpdateMemberRoleDto } from './workspaces.dto';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Workspace (tenant) administration. All mutations re-check the caller's role
 * in the *active* workspace; roles are owner > admin > member.
 */
@Injectable()
export class WorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  private requireAuth(auth?: AuthContext): AuthContext {
    if (!auth) {
      throw new UnauthorizedException('Sign in to manage workspaces');
    }
    return auth;
  }

  private requireRole(auth: AuthContext, roles: MemberRole[]): void {
    if (!roles.includes(auth.workspaceRole as MemberRole)) {
      throw new ForbiddenException(`Requires role: ${roles.join(' or ')}`);
    }
  }

  async listMembers(authContext?: AuthContext) {
    const auth = this.requireAuth(authContext);
    const memberships = await this.prisma.membership.findMany({
      where: { workspaceId: auth.workspaceId },
      include: { user: true },
      orderBy: { createdAt: 'asc' },
    });
    return {
      workspaceId: auth.workspaceId,
      workspaceName: auth.workspaceName,
      members: memberships.map((membership) => ({
        userId: membership.userId,
        email: membership.user.email,
        role: membership.role,
        joinedAt: membership.createdAt.toISOString(),
      })),
    };
  }

  async invite(authContext: AuthContext | undefined, dto: InviteMemberDto) {
    const auth = this.requireAuth(authContext);
    this.requireRole(auth, ['owner', 'admin']);

    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
    await this.prisma.invitation.create({
      data: {
        id: randomToken(16),
        workspaceId: auth.workspaceId,
        email: dto.email?.trim().toLowerCase() ?? null,
        role: dto.role,
        tokenHash: hashToken(token),
        expiresAt,
        createdBy: auth.userId,
      },
    });
    return {
      token,
      role: dto.role,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async updateRole(
    authContext: AuthContext | undefined,
    userId: string,
    dto: UpdateMemberRoleDto,
  ) {
    const auth = this.requireAuth(authContext);
    this.requireRole(auth, ['owner']);

    const target = await this.prisma.membership.findUnique({
      where: { userId_workspaceId: { userId, workspaceId: auth.workspaceId } },
    });
    if (!target) {
      throw new NotFoundException('Member not found in this workspace');
    }
    if (target.role === 'owner' && dto.role !== 'owner') {
      await this.assertNotLastOwner(auth.workspaceId);
    }
    await this.prisma.membership.update({
      where: { userId_workspaceId: { userId, workspaceId: auth.workspaceId } },
      data: { role: dto.role },
    });
    return { userId, role: dto.role };
  }

  async removeMember(authContext: AuthContext | undefined, userId: string) {
    const auth = this.requireAuth(authContext);
    this.requireRole(auth, ['owner', 'admin']);
    if (userId === auth.userId) {
      throw new ConflictException('You cannot remove yourself from the workspace');
    }

    const target = await this.prisma.membership.findUnique({
      where: { userId_workspaceId: { userId, workspaceId: auth.workspaceId } },
    });
    if (!target) {
      throw new NotFoundException('Member not found in this workspace');
    }
    if (target.role === 'owner') {
      if (auth.workspaceRole !== 'owner') {
        throw new ForbiddenException('Only an owner can remove an owner');
      }
      await this.assertNotLastOwner(auth.workspaceId);
    }

    await this.prisma.membership.delete({
      where: { userId_workspaceId: { userId, workspaceId: auth.workspaceId } },
    });
    return { removed: userId };
  }

  async switchWorkspace(authContext: AuthContext | undefined, workspaceId: string): Promise<PublicIdentity> {
    const auth = this.requireAuth(authContext);
    return this.auth.switchWorkspace(auth.userId, auth.sessionId, workspaceId);
  }

  async acceptInvitation(authContext: AuthContext | undefined, token: string): Promise<PublicIdentity> {
    const auth = this.requireAuth(authContext);
    return this.auth.acceptInvitation(auth.userId, auth.sessionId, token);
  }

  private async assertNotLastOwner(workspaceId: string): Promise<void> {
    const owners = await this.prisma.membership.count({
      where: { workspaceId, role: 'owner' },
    });
    if (owners <= 1) {
      throw new BadRequestException('A workspace must keep at least one owner');
    }
  }
}
