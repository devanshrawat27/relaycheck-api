import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { LoginDto, RegisterDto } from './auth.dto';
import { AuthService, SESSION_COOKIE } from './auth.service';
import { AuthState } from './auth.types';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  private setCookie(response: Response, token: string): void {
    response.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_MS,
    });
  }

  @Post('register')
  @HttpCode(201)
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const session = await this.auth.register(dto.email, dto.password);
    this.setCookie(response, session.token);
    return session;
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) response: Response) {
    const session = await this.auth.login(dto.email, dto.password);
    this.setCookie(response, session.token);
    return session;
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.auth.logout(this.auth.tokenFromRequest(request));
    response.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  /** Always public: tells the dashboard whether auth is enabled and who is signed in. */
  @Get('me')
  async me(@Req() request: Request): Promise<AuthState> {
    if (!this.auth.isAuthRequired()) {
      return { authRequired: false, user: null };
    }
    const identity = await this.auth.resolveToken(this.auth.tokenFromRequest(request));
    if (!identity) {
      return { authRequired: true, user: null };
    }
    return {
      authRequired: true,
      user: {
        id: identity.userId,
        email: identity.email,
        role: identity.role,
        workspaceId: identity.workspaceId,
        workspaceName: identity.workspaceName,
        workspaceRole: identity.workspaceRole,
        workspaces: identity.memberships,
      },
    };
  }
}
