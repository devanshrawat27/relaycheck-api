import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService, RunJob } from '../queue/queue.service';

const DISPATCH_INTERVAL_MS = 1000;
const BATCH_SIZE = 20;
const MAX_ATTEMPTS = 20;

/**
 * Transactional-outbox dispatcher.
 *
 * Run creation commits the run row AND the job payload in one database
 * transaction. This dispatcher then publishes pending payloads with
 * publisher confirms and marks them sent. A crash between commit and
 * publish therefore loses nothing: the pending row is retried.
 *
 * MVP scope: a single API instance dispatches. Multi-instance deployment
 * would need row-level claiming (SELECT ... FOR UPDATE SKIP LOCKED).
 */
@Injectable()
export class OutboxDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxDispatcher.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.dispatchOnce().catch((error: unknown) => {
        this.logger.error(`Outbox dispatch pass failed: ${error instanceof Error ? error.message : error}`);
      });
    }, DISPATCH_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Best-effort immediate dispatch after a create (the interval is the safety net). */
  kick(): void {
    void this.dispatchOnce().catch((error: unknown) => {
      this.logger.error(`Outbox kick failed: ${error instanceof Error ? error.message : error}`);
    });
  }

  async dispatchOnce(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const pending = await this.prisma.outboxEvent.findMany({
        where: { status: 'pending' },
        orderBy: { createdAt: 'asc' },
        take: BATCH_SIZE,
      });

      for (const event of pending) {
        try {
          await this.queue.publishRunJob(event.payload as unknown as RunJob);
          await this.prisma.outboxEvent.update({
            where: { id: event.id },
            data: { status: 'sent', processedAt: new Date(), lastError: null },
          });
        } catch (error) {
          const attempts = event.attempts + 1;
          const exhausted = attempts >= MAX_ATTEMPTS;
          const message = error instanceof Error ? error.message : 'Unknown error';
          this.logger.error(
            `Outbox dispatch failed for run ${event.runId} (attempt ${attempts}/${MAX_ATTEMPTS}): ${message}`,
          );
          try {
            await this.prisma.outboxEvent.update({
              where: { id: event.id },
              data: {
                attempts,
                lastError: message.slice(0, 500),
                ...(exhausted ? { status: 'failed' } : {}),
              },
            });
            if (exhausted) {
              await this.prisma.testRun.updateMany({
                where: { id: event.runId, status: 'queued' },
                data: {
                  status: 'error',
                  safeError: 'Run job could not be published (outbox retries exhausted)',
                  finishedAt: new Date(),
                },
              });
            }
          } catch (updateError) {
            // The row (or run) may have been cleaned up concurrently; keep going.
            this.logger.warn(
              `Could not record outbox failure for ${event.id}: ${
                updateError instanceof Error ? updateError.message : updateError
              }`,
            );
          }
        }
      }
    } finally {
      this.running = false;
    }
  }
}
