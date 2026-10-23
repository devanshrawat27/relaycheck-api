import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { RateLimitGuard } from '../auth/rate-limit.guard';
import { AuthedRequest, SessionAuthGuard } from '../auth/session-auth.guard';
import { TargetsService } from './targets.service';
import { PublicTarget } from './targets.types';

/** Configured delivery targets (names only; URLs are never exposed). */
@Controller('targets')
@UseGuards(SessionAuthGuard, RateLimitGuard)
export class TargetsController {
  constructor(private readonly targets: TargetsService) {}

  @Get()
  list(@Req() _request: AuthedRequest): PublicTarget[] {
    return this.targets.listPublic();
  }
}

