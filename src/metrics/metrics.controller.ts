import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { ApiTokenGuard } from '../auth/api-token.guard';
import { RateLimitGuard } from '../auth/rate-limit.guard';
import { MetricsResponse, MetricsService } from './metrics.service';

/** Aggregate operational metrics (counts only). */
@Controller('metrics')
@UseGuards(ApiTokenGuard, RateLimitGuard)
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  get(): Promise<MetricsResponse> {
    return this.metrics.snapshot();
  }

  @Get('prometheus')
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  prometheus(): Promise<string> {
    return this.metrics.prometheus();
  }
}

