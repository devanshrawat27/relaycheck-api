import { Injectable, Logger } from '@nestjs/common';
import amqp from 'amqplib';

export const RUN_JOBS_QUEUE = 'relaycheck.run.jobs';

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

/**
 * Publishes run jobs to RabbitMQ. The queue is durable and messages are
 * persistent. A connection is opened per publish — simple and correct for
 * MVP volume; revisit only under measured load.
 */
@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  async publishRunJob(job: RunJob): Promise<void> {
    const url = process.env.AMQP_URL ?? 'amqp://guest:guest@localhost:5672';
    const connection = await amqp.connect(url);
    try {
      const channel = await connection.createChannel();
      try {
        await channel.assertQueue(RUN_JOBS_QUEUE, { durable: true });
        channel.sendToQueue(RUN_JOBS_QUEUE, Buffer.from(JSON.stringify(job)), {
          persistent: true,
          contentType: 'application/json',
        });
        this.logger.debug(`Published run job for run ${job.runId}`);
      } finally {
        await channel.close();
      }
    } finally {
      await connection.close();
    }
  }
}
