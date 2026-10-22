import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FinalizeRunDto, RecordAssertionDto, RecordAttemptDto } from './dto/internal.dto';

/** How long a worker owns a run before its lease is considered abandoned. */
const LEASE_MS = 30_000;

export interface ClaimResponse {
  runId: string;
  status: 'running';
  leaseExpiresAt: string;
}

export interface ClaimConflict {
  status: string;
  leaseExpiresAt: string | null;
  message: string;
}

/**
 * Private runner-reporting contract. The Scenario Runner does NOT connect
 * to the platform database — it calls these endpoints, and only this writer
 * (the Control API) touches platform tables.
 *
 * Ownership model: claiming a run grants a time-bounded *lease*. The runner
 * heartbeats to extend it while executing. A duplicate job can only recover
 * a run whose lease has actually expired — an active worker is never
 * prematurely failed just because a second message arrived.
 */
@Injectable()
export class InternalService {
  constructor(private readonly prisma: PrismaService) {}

  private leaseExpiry(): Date {
    return new Date(Date.now() + LEASE_MS);
  }

  /** queued -> running, with an expiring lease owned by `workerId`. */
  async claimRun(runId: string, workerId: string): Promise<ClaimResponse> {
    const leaseExpiresAt = this.leaseExpiry();
    const updated = await this.prisma.testRun.updateMany({
      where: { id: runId, status: 'queued' },
      data: {
        status: 'running',
        startedAt: new Date(),
        claimedBy: workerId,
        leaseExpiresAt,
      },
    });
    if (updated.count === 1) {
      return { runId, status: 'running', leaseExpiresAt: leaseExpiresAt.toISOString() };
    }

    const existing = await this.prisma.testRun.findUnique({ where: { id: runId } });
    if (!existing) {
      throw new NotFoundException(`No run with id ${runId}`);
    }
    const conflict: ClaimConflict = {
      status: existing.status,
      leaseExpiresAt: existing.leaseExpiresAt ? existing.leaseExpiresAt.toISOString() : null,
      message: `Run ${runId} is already ${existing.status}; claim refused`,
    };
    throw new ConflictException(conflict);
  }

  /** Extend the lease while the owning worker is still executing. */
  async heartbeatRun(runId: string, workerId: string): Promise<{ extended: boolean }> {
    const leaseExpiresAt = this.leaseExpiry();
    const updated = await this.prisma.testRun.updateMany({
      where: { id: runId, status: 'running', claimedBy: workerId },
      data: { leaseExpiresAt },
    });
    if (updated.count === 1) {
      return { extended: true };
    }
    throw new ConflictException(
      `Run ${runId} is not owned by worker ${workerId} (finished, recovered, or never claimed)`,
    );
  }

  /**
   * Recover a run only when its lease has expired. This is the sole path
   * that may finalize an otherwise-running run from a duplicate job.
   */
  async recoverRun(runId: string): Promise<{ recovered: boolean }> {
    const now = new Date();
    const updated = await this.prisma.testRun.updateMany({
      where: { id: runId, status: 'running', leaseExpiresAt: { lt: now } },
      data: {
        status: 'error',
        summary: 'Execution was interrupted before completion',
        safeError: 'Run lease expired without a finalize; recovered by a duplicate job',
        finishedAt: now,
        claimedBy: null,
        leaseExpiresAt: null,
      },
    });
    if (updated.count === 1) {
      return { recovered: true };
    }
    throw new ConflictException(
      `Run ${runId} is not recoverable (terminal, missing, or lease still active)`,
    );
  }

  async recordAttempt(runId: string, dto: RecordAttemptDto) {
    const run = await this.prisma.testRun.findUnique({ where: { id: runId } });
    if (!run) {
      throw new NotFoundException(`No run with id ${runId}`);
    }
    if (run.status !== 'running') {
      throw new ConflictException(`Attempts are accepted only while a run is running (is ${run.status})`);
    }
    return this.prisma.deliveryAttempt.create({
      data: {
        runId,
        attemptNumber: dto.attemptNumber,
        eventId: dto.eventId,
        httpStatus: dto.httpStatus ?? null,
        outcome: dto.outcome,
        durationMs: dto.durationMs,
        errorDetail: dto.errorDetail ?? null,
      },
    });
  }

  async recordAssertion(runId: string, dto: RecordAssertionDto) {
    const run = await this.prisma.testRun.findUnique({ where: { id: runId } });
    if (!run) {
      throw new NotFoundException(`No run with id ${runId}`);
    }
    if (run.status !== 'running') {
      throw new ConflictException(`Assertions are accepted only while a run is running (is ${run.status})`);
    }
    return this.prisma.assertionResult.create({
      data: {
        runId,
        name: dto.name,
        expected: dto.expected,
        actual: dto.actual,
        passed: dto.passed,
      },
    });
  }

  /** running -> passed | failed | error (terminal). */
  async finalizeRun(runId: string, dto: FinalizeRunDto): Promise<{ runId: string; status: string }> {
    const existing = await this.prisma.testRun.findUnique({ where: { id: runId } });
    if (!existing) {
      throw new NotFoundException(`No run with id ${runId}`);
    }
    const finishedAt = new Date();
    const durationMs = existing.startedAt
      ? Math.max(0, finishedAt.getTime() - existing.startedAt.getTime())
      : null;
    const updated = await this.prisma.testRun.updateMany({
      where: { id: runId, status: 'running' },
      data: {
        status: dto.status,
        summary: dto.summary,
        safeError: dto.safeError ?? null,
        finishedAt,
        durationMs,
        claimedBy: null,
        leaseExpiresAt: null,
      },
    });
    if (updated.count === 0) {
      throw new ConflictException(`Run ${runId} is not running (is ${existing.status}); finalize refused`);
    }
    return { runId, status: dto.status };
  }
}
