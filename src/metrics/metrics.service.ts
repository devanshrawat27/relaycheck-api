import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RUN_STATUSES } from '../runs/dto/list-runs.dto';

export interface MetricsResponse {
  runs: Record<string, number>;
  outbox: {
    pending: number;
    sending: number;
    failed: number;
    oldestPendingAgeMs: number | null;
  };
  queues: { work: number; deadLetter: number };
  generatedAt: string;
}

/**
 * Aggregate operational metrics for diagnostics. Read-only and public-safe:
 * counts only, never run payloads. Guarded by the optional API token.
 */
@Injectable()
export class MetricsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  async snapshot(): Promise<MetricsResponse> {
    const grouped = await this.prisma.testRun.groupBy({
      by: ['status'],
      _count: { _all: true },
    });

    const runs: Record<string, number> = {};
    for (const status of RUN_STATUSES) {
      runs[status] = 0;
    }
    for (const row of grouped) {
      runs[row.status] = row._count._all;
    }

    const [pending, sending, failed, oldestPending] = await Promise.all([
      this.prisma.outboxEvent.count({ where: { status: 'pending' } }),
      this.prisma.outboxEvent.count({ where: { status: 'sending' } }),
      this.prisma.outboxEvent.count({ where: { status: 'failed' } }),
      this.prisma.outboxEvent.findFirst({
        where: { status: 'pending' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);

    const queues = await this.queue
      .getQueueDepths()
      .catch(() => ({ work: -1, deadLetter: -1 }));

    return {
      runs,
      outbox: {
        pending,
        sending,
        failed,
        oldestPendingAgeMs: oldestPending
          ? Math.max(0, Date.now() - oldestPending.createdAt.getTime())
          : null,
      },
      queues,
      generatedAt: new Date().toISOString(),
    };
  }
}
