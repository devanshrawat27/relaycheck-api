import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { HealthController } from './health/health.controller';
import { InternalModule } from './internal/internal.module';
import { MetricsModule } from './metrics/metrics.module';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';
import { RunsModule } from './runs/runs.module';
import { WorkspacesModule } from './workspaces/workspaces.module';

@Module({
  imports: [PrismaModule, QueueModule, RunsModule, InternalModule, MetricsModule, AuthModule, WorkspacesModule],
  controllers: [HealthController],
  providers: [],
})
export class AppModule {}


