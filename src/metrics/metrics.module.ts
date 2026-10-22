import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RateLimitGuard } from '../auth/rate-limit.guard';
import { QueueModule } from '../queue/queue.module';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

@Module({
  imports: [QueueModule, AuthModule],
  controllers: [MetricsController],
  providers: [MetricsService, RateLimitGuard],
})
export class MetricsModule {}
