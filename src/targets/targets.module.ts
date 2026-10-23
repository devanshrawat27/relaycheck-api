import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RateLimitGuard } from '../auth/rate-limit.guard';
import { TargetsController } from './targets.controller';
import { TargetsService } from './targets.service';

@Module({
  imports: [AuthModule],
  controllers: [TargetsController],
  providers: [TargetsService, RateLimitGuard],
  exports: [TargetsService],
})
export class TargetsModule {}
