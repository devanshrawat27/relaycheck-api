import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';

/**
 * Optional bearer-token protection for the public run endpoints.
 *
 * Local-first default: when API_AUTH_TOKEN is unset, requests are allowed and
 * the tool relies on loopback binding. When it is set (recommended if HOST is
 * overridden), every public run request must send
 * `Authorization: Bearer <API_AUTH_TOKEN>`.
 *
 * This is deliberately a single shared token, not user accounts or tenancy —
 * multi-user auth remains out of MVP scope.
 */
@Injectable()
export class ApiTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.API_AUTH_TOKEN;
    if (!expected) {
      return true;
    }
    const request = context.switchToHttp().getRequest<Request>();
    const authorization = request.header('authorization') ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
    if (token && token === expected) {
      return true;
    }
    throw new UnauthorizedException('Missing or invalid API token');
  }
}
