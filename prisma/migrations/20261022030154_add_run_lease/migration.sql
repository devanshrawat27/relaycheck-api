-- AlterTable
ALTER TABLE "test_runs" ADD COLUMN     "claimedBy" TEXT,
ADD COLUMN     "leaseExpiresAt" TIMESTAMP(3);
