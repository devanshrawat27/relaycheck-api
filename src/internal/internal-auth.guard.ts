import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';

/**
 * Guard for private runner-reporting endpoints. Requires the
 * `x-internal-token` header to exactly match INTERNAL_API_TOKEN. If the
 * token is not configured at all, every request is rejected (fail closed).
 */
@Injectable()
export class InternalAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const token = request.header('x-internal-token');
    const expected = process.env.INTERNAL_API_TOKEN;
    if (!expected || token !== expected) {
      throw new UnauthorizedException('Missing or invalid internal token');
    }
    return true;
  }
}
