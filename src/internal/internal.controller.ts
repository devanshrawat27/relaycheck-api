import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { FinalizeRunDto, RecordAssertionDto, RecordAttemptDto } from './dto/internal.dto';
import { InternalAuthGuard } from './internal-auth.guard';
import { InternalService } from './internal.service';

/**
 * Private runner-reporting endpoints. NOT for the dashboard: they require
 * the internal token and write platform data on behalf of the Scenario
 * Runner, which never connects to the platform database itself.
 */
@Controller('internal/runs')
@UseGuards(InternalAuthGuard)
export class InternalController {
  constructor(private readonly internal: InternalService) {}

  @Post(':id/claim')
  claim(@Param('id') id: string) {
    return this.internal.claimRun(id);
  }

  @Post(':id/attempts')
  recordAttempt(@Param('id') id: string, @Body() dto: RecordAttemptDto) {
    return this.internal.recordAttempt(id, dto);
  }

  @Post(':id/assertions')
  recordAssertion(@Param('id') id: string, @Body() dto: RecordAssertionDto) {
    return this.internal.recordAssertion(id, dto);
  }

  @Post(':id/finalize')
  finalize(@Param('id') id: string, @Body() dto: FinalizeRunDto) {
    return this.internal.finalizeRun(id, dto);
  }
}
