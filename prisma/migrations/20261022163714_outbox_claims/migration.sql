-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN     "lockedAt" TIMESTAMP(3);
