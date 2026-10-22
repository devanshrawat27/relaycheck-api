import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { RateLimitGuard } from '../auth/rate-limit.guard';
import { AuthedRequest, SessionAuthGuard } from '../auth/session-auth.guard';
import {
  AcceptInvitationDto,
  InviteMemberDto,
  SwitchWorkspaceDto,
  UpdateMemberRoleDto,
} from './workspaces.dto';
import { WorkspacesService } from './workspaces.service';

/** Workspace (tenant) administration for the active workspace. */
@Controller('workspace')
@UseGuards(SessionAuthGuard, RateLimitGuard)
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Get('members')
  listMembers(@Req() request: AuthedRequest) {
    return this.workspaces.listMembers(request.auth);
  }

  @Post('invitations')
  invite(@Req() request: AuthedRequest, @Body() dto: InviteMemberDto) {
    return this.workspaces.invite(request.auth, dto);
  }

  @Patch('members/:userId')
  updateRole(
    @Req() request: AuthedRequest,
    @Param('userId') userId: string,
    @Body() dto: UpdateMemberRoleDto,
  ) {
    return this.workspaces.updateRole(request.auth, userId, dto);
  }

  @Delete('members/:userId')
  removeMember(@Req() request: AuthedRequest, @Param('userId') userId: string) {
    return this.workspaces.removeMember(request.auth, userId);
  }

  @Post('switch')
  switchWorkspace(@Req() request: AuthedRequest, @Body() dto: SwitchWorkspaceDto) {
    return this.workspaces.switchWorkspace(request.auth, dto.workspaceId);
  }

  @Post('accept-invitation')
  acceptInvitation(@Req() request: AuthedRequest, @Body() dto: AcceptInvitationDto) {
    return this.workspaces.acceptInvitation(request.auth, dto.token);
  }
}
