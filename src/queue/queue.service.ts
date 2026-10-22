import { Injectable, Logger } from '@nestjs/common';
import amqp from 'amqplib';

export const RUN_JOBS_QUEUE = 'relaycheck.run.jobs';
export const RUN_JOBS_DLQ = 'relaycheck.run.jobs.dlq';

/** Versioned run job consumed by the Scenario Runner (validated at its boundary). */
export interface RunJob {
  schemaVersion: 1;
  runId: string;
  scenario: string;
  params: {
    eventType: string;
    eventId: string;
    orderId: string;
    deliveryCount: number;
    timeoutMs: number;
  };
}

export interface QueueDepths {
  work: number;
  deadLetter: number;
}

/**
 * Publishes run jobs to RabbitMQ. The queue is durable and messages are
 * persistent. A connection is opened per operation — simple and correct for
 * MVP volume; revisit only under measured load.
 */
@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  private url(): string {
    return process.env.AMQP_URL ?? 'amqp://guest:guest@localhost:5672';
  }

  async publishRunJob(job: RunJob): Promise<void> {
    const connection = await amqp.connect(this.url());
    try {
      // Confirm channel: only report success once the broker has accepted the
      // message (publisher confirms), not merely when it was written to a socket.
      const channel = await connection.createConfirmChannel();
      try {
        await channel.assertQueue(RUN_JOBS_QUEUE, { durable: true });
        channel.sendToQueue(RUN_JOBS_QUEUE, Buffer.from(JSON.stringify(job)), {
          persistent: true,
          contentType: 'application/json',
        });
        await channel.waitForConfirms();
        this.logger.debug(`Published run job for run ${job.runId} (confirmed)`);
      } finally {
        await channel.close();
      }
    } finally {
      await connection.close();
    }
  }

  /** Read-only queue depth for diagnostics/metrics. */
  async getQueueDepths(): Promise<QueueDepths> {
    const connection = await amqp.connect(this.url());
    try {
      const channel = await connection.createChannel();
      try {
        await channel.assertQueue(RUN_JOBS_QUEUE, { durable: true });
        await channel.assertQueue(RUN_JOBS_DLQ, { durable: true });
        const work = await channel.checkQueue(RUN_JOBS_QUEUE);
        const deadLetter = await channel.checkQueue(RUN_JOBS_DLQ);
        return { work: work.messageCount, deadLetter: deadLetter.messageCount };
      } finally {
        await channel.close();
      }
    } finally {
      await connection.close();
    }
  }
}
