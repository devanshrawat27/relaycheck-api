import { Module } from '@nestjs/common';
import { OutboxDispatcher } from './outbox.dispatcher';
import { QueueService } from './queue.service';

@Module({
  providers: [QueueService, OutboxDispatcher],
  exports: [QueueService, OutboxDispatcher],
})
export class QueueModule {}
