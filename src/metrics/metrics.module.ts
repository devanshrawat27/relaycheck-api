import { Module } from '@nestjs/common';
import { ApiTokenGuard } from '../auth/api-token.guard';
import { QueueModule } from '../queue/queue.module';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

@Module({
  imports: [QueueModule],
  controllers: [MetricsController],
  providers: [MetricsService, ApiTokenGuard],
})
export class MetricsModule {}
