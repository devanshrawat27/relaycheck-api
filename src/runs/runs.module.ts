import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RateLimitGuard } from '../auth/rate-limit.guard';
import { QueueModule } from '../queue/queue.module';
import { TargetsModule } from '../targets/targets.module';
import { RunsController } from './runs.controller';
import { RunsService } from './runs.service';

@Module({
  imports: [QueueModule, AuthModule, TargetsModule],
  controllers: [RunsController],
  providers: [RunsService, RateLimitGuard],
})
export class RunsModule {}

