import { randomUUID } from 'crypto';
import {
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OutboxDispatcher } from '../queue/outbox.dispatcher';
import { AuthContext } from '../auth/auth.types';
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
interface ScenarioDefinition {
  deliveryCount: number;
  timeoutMs: number;
  summary: string;
}

const SCENARIOS: Record<string, ScenarioDefinition> = {
  duplicate_delivery: {
    deliveryCount: 3,
    timeoutMs: 5000,
    summary: '3 deliveries of one event ID must produce one business effect',
  },
  receiver_failure: {
    deliveryCount: 1,
    timeoutMs: 3000,
    summary: 'Receiver returns a controlled 503; no business effect may be applied',
  },
  receiver_timeout: {
    deliveryCount: 1,
    timeoutMs: 1000,
    summary: 'Receiver delays past the client timeout; the delivery must be recorded as timed out',
  },
};

@Injectable()
export class RunsService {
  private readonly logger = new Logger(RunsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxDispatcher,
  ) {}

  async createRun(dto: CreateRunDto, auth?: AuthContext): Promise<CreateRunResult> {
    const scenario = SCENARIOS[dto.scenario];
    if (!scenario) {
      throw new InternalServerErrorException(`Unsupported scenario ${dto.scenario}`);
    }

    const maxPerDay = Number(process.env.API_MAX_RUNS_PER_DAY ?? 0);
    if (Number.isFinite(maxPerDay) && maxPerDay > 0) {
      const startOfDay = new Date();
      startOfDay.setUTCHours(0, 0, 0, 0);
      const today = await this.prisma.testRun.count({
        where: {
          createdAt: { gte: startOfDay },
          ...(auth ? { workspaceId: auth.workspaceId } : {}),
        },
      });
      if (today >= maxPerDay) {
        throw new HttpException(
          {
            statusCode: 429,
            error: 'Too Many Requests',
            message: `Daily run quota exceeded (${maxPerDay} per day)`,
          },
          429,
        );
      }
    }

    const runId = randomUUID();
    const params: RunParams = {
      eventType: 'payment.succeeded',
      eventId: `evt_${randomUUID()}`,
      orderId: `ord_${randomUUID()}`,
      deliveryCount: scenario.deliveryCount,
      timeoutMs: scenario.timeoutMs,
    };

    // Transactional outbox: the run row and the job payload commit together.
    // A crash between commit and publish cannot strand the run — the
    // dispatcher retries pending payloads and only marks them sent after the
    // broker confirms.
    const [run] = await this.prisma.$transaction([
      this.prisma.testRun.create({
        data: {
          id: runId,
          workspaceId: auth?.workspaceId ?? null,
          scenario: dto.scenario,
          status: 'queued',
          params: params as unknown as object,
          summary: scenario.summary,
        },
      }),
      this.prisma.outboxEvent.create({
        data: {
          id: randomUUID(),
          runId,
          payload: {
            schemaVersion: 1,
            runId,
            scenario: dto.scenario,
            params,
          } as unknown as object,
        },
      }),
    ]);

    this.outbox.kick();

    return {
      runId: run.id,
      status: 'queued',
      scenario: run.scenario,
      createdAt: run.createdAt.toISOString(),
    };
  }

  async listRuns(query: ListRunsQueryDto, auth?: AuthContext) {
    const take = query.take ?? 20;

    let cursorFilter: object = {};
    if (query.cursor) {
      const cursorRun = await this.prisma.testRun.findUnique({
        where: { id: query.cursor },
        select: { createdAt: true, id: true },
      });
      if (cursorRun) {
        cursorFilter = {
          OR: [
            { createdAt: { lt: cursorRun.createdAt } },
            { createdAt: cursorRun.createdAt, id: { lt: cursorRun.id } },
          ],
        };
      }
    }

    const runs = await this.prisma.testRun.findMany({
      where: {
        ...(auth ? { workspaceId: auth.workspaceId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...cursorFilter,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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
      nextCursor: runs.length === take ? runs[runs.length - 1]?.id ?? null : null,
    };
  }

  async getRun(runId: string, auth?: AuthContext) {
    const run = await this.prisma.testRun.findUnique({
      where: { id: runId },
      include: {
        attempts: { orderBy: { attemptNumber: 'asc' } },
        assertions: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!run || (auth && run.workspaceId !== auth.workspaceId)) {
      throw new NotFoundException(`No run with id ${runId}`);
    }
    const { workspaceId: _workspaceId, ...publicRun } = run;
    return {
      ...publicRun,
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


