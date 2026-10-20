import { randomUUID } from 'crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
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
  constructor(private readonly prisma: PrismaService) {}

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

    // Job publication to RabbitMQ is added in the dispatch task; the run is
    // persisted as `queued` up front so it is guaranteed to exist first.

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
