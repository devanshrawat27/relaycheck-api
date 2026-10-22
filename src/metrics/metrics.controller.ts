import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTokenGuard } from '../auth/api-token.guard';
import { MetricsResponse, MetricsService } from './metrics.service';

/** Aggregate operational metrics (counts only). */
@Controller('metrics')
@UseGuards(ApiTokenGuard)
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  get(): Promise<MetricsResponse> {
    return this.metrics.snapshot();
  }
}
