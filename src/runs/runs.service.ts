import { randomUUID } from 'crypto';
import { Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { CreateRunDto } from './dto/create-run.dto';
import { ListRunsQueryDto } from './dto/list-runs.dto';

export interface RunParams {
  eventType: string;
  eventId: string;
  orderId: string;
  deliveryCount: number;
  timeoutMs: number;
}

export interface CreateRunResult {
  runId: string;
  status: 'queued';
  scenario: string;
  createdAt: string;
}

/** Server-side bounds — timeout and delivery count are never user-controlled. */
const DUPLICATE_SCENARIO = {
  eventType: 'payment.succeeded',
  deliveryCount: 3,
  timeoutMs: 5000,
} as const;

@Injectable()
export class RunsService {
  private readonly logger = new Logger(RunsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  async createRun(dto: CreateRunDto): Promise<CreateRunResult> {
    const runId = randomUUID();
    const params: RunParams = {
      eventType: DUPLICATE_SCENARIO.eventType,
      eventId: `evt_${randomUUID()}`,
      orderId: `ord_${randomUUID()}`,
      deliveryCount: DUPLICATE_SCENARIO.deliveryCount,
      timeoutMs: DUPLICATE_SCENARIO.timeoutMs,
    };

    const run = await this.prisma.testRun.create({
      data: {
        id: runId,
        scenario: dto.scenario,
        status: 'queued',
        params: params as unknown as object,
        summary: `3 deliveries of one event ID must produce one business effect`,
      },
    });

    // The run is persisted BEFORE publishing so a job can never reference a
    // missing run. If publication fails, the run is explicitly moved to
    // `error` with a safe message — never left silently queued forever.
    try {
      await this.queue.publishRunJob({
        schemaVersion: 1,
        runId,
        scenario: dto.scenario,
        params,
      });
    } catch (error) {
      this.logger.error(`Failed to publish job for run ${runId}: ${(error as Error).message}`);
      await this.prisma.testRun.update({
        where: { id: runId },
        data: {
          status: 'error',
          safeError: 'Run job could not be published to the queue',
          finishedAt: new Date(),
        },
      });
      throw new InternalServerErrorException('Run job could not be published to the queue');
    }

    return {
      runId: run.id,
      status: 'queued',
      scenario: run.scenario,
      createdAt: run.createdAt.toISOString(),
    };
  }

  async listRuns(query: ListRunsQueryDto) {
    const take = query.take ?? 20;
    const runs = await this.prisma.testRun.findMany({
      where: query.status ? { status: query.status } : {},
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        scenario: true,
        status: true,
        summary: true,
        createdAt: true,
        finishedAt: true,
        durationMs: true,
      },
    });
    return {
      items: runs.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
      })),
    };
  }

  async getRun(runId: string) {
    const run = await this.prisma.testRun.findUnique({
      where: { id: runId },
      include: {
        attempts: { orderBy: { attemptNumber: 'asc' } },
        assertions: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!run) {
      throw new NotFoundException(`No run with id ${runId}`);
    }
    return {
      ...run,
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      finishedAt: run.finishedAt?.toISOString() ?? null,
      attempts: run.attempts.map((a) => ({
        ...a,
        createdAt: a.createdAt.toISOString(),
      })),
      assertions: run.assertions.map((a) => ({
        ...a,
        createdAt: a.createdAt.toISOString(),
      })),
    };
  }
}
