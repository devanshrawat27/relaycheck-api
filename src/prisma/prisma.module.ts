import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/** Shared database access for platform tables. The Control API is their sole writer. */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
