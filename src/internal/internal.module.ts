import { Module } from '@nestjs/common';
import { InternalAuthGuard } from './internal-auth.guard';
import { InternalController } from './internal.controller';
import { InternalService } from './internal.service';

@Module({
  controllers: [InternalController],
  providers: [InternalAuthGuard, InternalService],
})
export class InternalModule {}
