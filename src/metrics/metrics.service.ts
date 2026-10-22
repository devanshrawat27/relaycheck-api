import { Injectable } from '@nestjs/common';
import { AuthContext } from '../auth/auth.types';
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

  async snapshot(auth?: AuthContext): Promise<MetricsResponse> {
    const grouped = await this.prisma.testRun.groupBy({
      by: ['status'],
      where: auth ? { workspaceId: auth.workspaceId } : {},
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

  /** Prometheus text exposition (no external client dependency). */
  async prometheus(auth?: AuthContext): Promise<string> {
    const metrics = await this.snapshot(auth);
    const lines: string[] = [];

    lines.push('# HELP relaycheck_runs_total Persisted runs by status.');
    lines.push('# TYPE relaycheck_runs_total gauge');
    for (const [status, count] of Object.entries(metrics.runs)) {
      lines.push(`relaycheck_runs_total{status="${status}"} ${count}`);
    }

    lines.push('# HELP relaycheck_outbox_events Outbox entries by state.');
    lines.push('# TYPE relaycheck_outbox_events gauge');
    lines.push(`relaycheck_outbox_events{state="pending"} ${metrics.outbox.pending}`);
    lines.push(`relaycheck_outbox_events{state="sending"} ${metrics.outbox.sending}`);
    lines.push(`relaycheck_outbox_events{state="failed"} ${metrics.outbox.failed}`);

    lines.push('# HELP relaycheck_outbox_oldest_pending_seconds Age of the oldest unpublished job.');
    lines.push('# TYPE relaycheck_outbox_oldest_pending_seconds gauge');
    lines.push(
      `relaycheck_outbox_oldest_pending_seconds ${
        metrics.outbox.oldestPendingAgeMs === null
          ? 0
          : Math.round(metrics.outbox.oldestPendingAgeMs / 1000)
      }`,
    );

    lines.push('# HELP relaycheck_queue_depth Messages ready in a queue (-1 unavailable).');
    lines.push('# TYPE relaycheck_queue_depth gauge');
    lines.push(`relaycheck_queue_depth{queue="work"} ${metrics.queues.work}`);
    lines.push(`relaycheck_queue_depth{queue="dead_letter"} ${metrics.queues.deadLetter}`);

    return `${lines.join('\n')}\n`;
  }
}

