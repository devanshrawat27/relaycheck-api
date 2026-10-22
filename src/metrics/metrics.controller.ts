import { Controller, Get, Header, Req, UseGuards } from '@nestjs/common';
import { RateLimitGuard } from '../auth/rate-limit.guard';
import { AuthedRequest, SessionAuthGuard } from '../auth/session-auth.guard';
import { MetricsResponse, MetricsService } from './metrics.service';

/** Aggregate operational metrics (counts only). */
@Controller('metrics')
@UseGuards(SessionAuthGuard, RateLimitGuard)
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  get(@Req() request: AuthedRequest): Promise<MetricsResponse> {
    return this.metrics.snapshot(request.auth);
  }

  @Get('prometheus')
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  prometheus(@Req() request: AuthedRequest): Promise<string> {
    return this.metrics.prometheus(request.auth);
  }
}
