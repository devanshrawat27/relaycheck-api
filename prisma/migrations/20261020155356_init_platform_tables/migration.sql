-- CreateTable
CREATE TABLE "test_runs" (
    "id" TEXT NOT NULL,
    "scenario" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "params" JSONB NOT NULL,
    "summary" TEXT,
    "safeError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,

    CONSTRAINT "test_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_attempts" (
    "id" SERIAL NOT NULL,
    "runId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "eventId" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "outcome" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "errorDetail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assertion_results" (
    "id" SERIAL NOT NULL,
    "runId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "expected" TEXT NOT NULL,
    "actual" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assertion_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "test_runs_status_createdAt_idx" ON "test_runs"("status", "createdAt");

-- CreateIndex
CREATE INDEX "delivery_attempts_runId_idx" ON "delivery_attempts"("runId");

-- CreateIndex
CREATE INDEX "assertion_results_runId_idx" ON "assertion_results"("runId");

-- AddForeignKey
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_runId_fkey" FOREIGN KEY ("runId") REFERENCES "test_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assertion_results" ADD CONSTRAINT "assertion_results_runId_fkey" FOREIGN KEY ("runId") REFERENCES "test_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
