import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { InternalModule } from './internal/internal.module';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';
import { RunsModule } from './runs/runs.module';

@Module({
  imports: [PrismaModule, QueueModule, RunsModule, InternalModule],
  controllers: [HealthController],
  providers: [],
})
export class AppModule {}
