import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { RateLimitGuard } from '../auth/rate-limit.guard';
import { AuthedRequest, SessionAuthGuard } from '../auth/session-auth.guard';
import { CreateRunDto } from './dto/create-run.dto';
import { ListRunsQueryDto } from './dto/list-runs.dto';
import { CreateRunResult, RunsService } from './runs.service';

@Controller('runs')
@UseGuards(SessionAuthGuard, RateLimitGuard)
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  /** Create a run: 202 + runId + queued status; dispatch happens via the outbox. */
  @Post()
  @HttpCode(202)
  createRun(@Body() dto: CreateRunDto, @Req() request: AuthedRequest): Promise<CreateRunResult> {
    return this.runs.createRun(dto, request.auth);
  }

  @Get()
  listRuns(@Query() query: ListRunsQueryDto, @Req() request: AuthedRequest) {
    return this.runs.listRuns(query, request.auth);
  }

  @Get(':id')
  getRun(@Param('id') id: string, @Req() request: AuthedRequest) {
    return this.runs.getRun(id, request.auth);
  }
}


