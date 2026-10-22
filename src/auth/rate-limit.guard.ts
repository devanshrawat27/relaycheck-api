import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { Request } from 'express';

interface WindowState {
  count: number;
  resetAt: number;
}

/**
 * Simple in-memory rate limiter for the public API (per client IP, fixed
 * 60-second window). Disabled when RATE_LIMIT_PER_MINUTE is unset or 0.
 * Intended as a local safety valve, not a distributed rate limiter.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly windows = new Map<string, WindowState>();

  canActivate(context: ExecutionContext): boolean {
    const limit = Number(process.env.RATE_LIMIT_PER_MINUTE ?? 120);
    if (!Number.isFinite(limit) || limit <= 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const key = request.ip ?? 'unknown';
    const now = Date.now();

    const current = this.windows.get(key);
    if (!current || current.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + 60_000 });
      return true;
    }

    current.count += 1;
    if (current.count > limit) {
      throw new HttpException(
        { statusCode: 429, error: 'Too Many Requests', message: 'Rate limit exceeded' },
        429,
      );
    }
    return true;
  }
}
