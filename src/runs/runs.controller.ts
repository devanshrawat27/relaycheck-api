import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTokenGuard } from '../auth/api-token.guard';
import { CreateRunDto } from './dto/create-run.dto';
import { ListRunsQueryDto } from './dto/list-runs.dto';
import { CreateRunResult, RunsService } from './runs.service';

@Controller('runs')
@UseGuards(ApiTokenGuard)
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  /** Create a run: 202 + runId + queued status; dispatch happens via the outbox. */
  @Post()
  @HttpCode(202)
  createRun(@Body() dto: CreateRunDto): Promise<CreateRunResult> {
    return this.runs.createRun(dto);
  }

  @Get()
  listRuns(@Query() query: ListRunsQueryDto) {
    return this.runs.listRuns(query);
  }

  @Get(':id')
  getRun(@Param('id') id: string) {
    return this.runs.getRun(id);
  }
}
