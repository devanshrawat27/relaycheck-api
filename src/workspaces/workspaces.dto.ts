import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export const MEMBER_ROLES = ['owner', 'admin', 'member'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export class InviteMemberDto {
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  /** Invitations can grant admin or member; ownership is transferred explicitly. */
  @IsIn(['admin', 'member'])
  role!: 'admin' | 'member';
}

export class UpdateMemberRoleDto {
  @IsIn(MEMBER_ROLES)
  role!: MemberRole;
}

export class SwitchWorkspaceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  workspaceId!: string;
}

export class AcceptInvitationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  token!: string;
}
