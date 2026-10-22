import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService, RunJob } from '../queue/queue.service';

const DISPATCH_INTERVAL_MS = 1000;
const BATCH_SIZE = 20;
const MAX_ATTEMPTS = 20;
/** A row claimed for publishing but not completed within this window is retried. */
const LOCK_STALE_MS = 60_000;

/**
 * Transactional-outbox dispatcher.
 *
 * Run creation commits the run row AND the job payload in one database
 * transaction. This dispatcher then publishes pending payloads with
 * publisher confirms and marks them sent. A crash between commit and
 * publish therefore loses nothing: the pending row is retried.
 *
 * Rows are claimed atomically (`pending → sending` with `lockedAt`) so
 * multiple API instances cannot publish the same payload concurrently;
 * stale `sending` claims are released back to `pending`.
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
      await this.releaseStaleClaims();

      const candidates = await this.prisma.outboxEvent.findMany({
        where: { status: 'pending' },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take: BATCH_SIZE,
      });

      for (const candidate of candidates) {
        const claimed = await this.prisma.outboxEvent.updateMany({
          where: { id: candidate.id, status: 'pending' },
          data: { status: 'sending', lockedAt: new Date() },
        });
        if (claimed.count === 0) {
          // Another instance claimed it first.
          continue;
        }

        const event = await this.prisma.outboxEvent.findUnique({ where: { id: candidate.id } });
        if (!event) {
          continue;
        }

        try {
          await this.queue.publishRunJob(event.payload as unknown as RunJob);
          await this.prisma.outboxEvent.update({
            where: { id: event.id },
            data: {
              status: 'sent',
              processedAt: new Date(),
              lastError: null,
              lockedAt: null,
            },
          });
        } catch (error) {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2025'
          ) {
            this.logger.debug(`Outbox row ${event.id} disappeared; skipping`);
            continue;
          }
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
                status: exhausted ? 'failed' : 'pending',
                attempts,
                lastError: message.slice(0, 500),
                lockedAt: null,
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
            if (
              updateError instanceof Prisma.PrismaClientKnownRequestError &&
              updateError.code === 'P2025'
            ) {
              this.logger.debug(`Outbox row ${event.id} disappeared during failure recording`);
            } else {
              this.logger.warn(
                `Could not record outbox failure for ${event.id}: ${
                  updateError instanceof Error ? updateError.message : updateError
                }`,
              );
            }
          }
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Release claims held by a crashed dispatcher so another pass can retry them. */
  private async releaseStaleClaims(): Promise<void> {
    const staleBefore = new Date(Date.now() - LOCK_STALE_MS);
    const released = await this.prisma.outboxEvent.updateMany({
      where: { status: 'sending', lockedAt: { lt: staleBefore } },
      data: { status: 'pending', lockedAt: null },
    });
    if (released.count > 0) {
      this.logger.warn(`Released ${released.count} stale outbox claim(s) for retry`);
    }
  }
}
