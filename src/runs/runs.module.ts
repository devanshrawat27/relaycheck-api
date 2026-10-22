import { Module } from '@nestjs/common';
import { ApiTokenGuard } from '../auth/api-token.guard';
import { RateLimitGuard } from '../auth/rate-limit.guard';
import { QueueModule } from '../queue/queue.module';
import { RunsController } from './runs.controller';
import { RunsService } from './runs.service';

@Module({
  imports: [QueueModule],
  controllers: [RunsController],
  providers: [RunsService, ApiTokenGuard, RateLimitGuard],
})
export class RunsModule {}

