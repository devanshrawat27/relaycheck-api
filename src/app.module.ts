import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { RunsModule } from './runs/runs.module';

@Module({
  imports: [PrismaModule, RunsModule],
  controllers: [HealthController],
  providers: [],
})
export class AppModule {}
