import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { AuthContext } from './auth.types';
import { AuthService } from './auth.service';

export interface AuthedRequest extends Request {
  auth?: AuthContext;
}

/**
 * Public endpoint guard.
 *
 * - AUTH_REQUIRED=true: a valid session is mandatory; the resolved identity
 *   (user + workspace) is attached as `request.auth`.
 * - AUTH_REQUIRED unset/false (local default): no login is needed; the
 *   optional shared API token still applies when API_AUTH_TOKEN is set.
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();

    if (this.auth.isAuthRequired()) {
      // Machine access (local automation/CI): the shared API token may access
      // public endpoints without a user session. Loopback-only by default.
      const machineToken = process.env.API_AUTH_TOKEN;
      const authorization = request.header('authorization') ?? '';
      const bearer = authorization.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length)
        : '';
      if (machineToken && bearer === machineToken) {
        return true;
      }

      const identity = await this.auth.resolveToken(this.auth.tokenFromRequest(request));
      if (!identity) {
        throw new UnauthorizedException('Authentication required');
      }
      request.auth = identity;
      return true;
    }

    const expected = process.env.API_AUTH_TOKEN;
    if (expected) {
      const authorization = request.header('authorization') ?? '';
      const token = authorization.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length)
        : '';
      if (token !== expected) {
        throw new UnauthorizedException('Missing or invalid API token');
      }
    }
    return true;
  }
}
