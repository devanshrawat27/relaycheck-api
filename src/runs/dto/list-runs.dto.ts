import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** Persisted run statuses — the public contract (docs: ARCHITECTURE.md). */
export const RUN_STATUSES = ['queued', 'running', 'passed', 'failed', 'error'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export class ListRunsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  take?: number;

  @IsOptional()
  @IsIn(RUN_STATUSES)
  status?: RunStatus;

  /** Opaque cursor: the id of the last run from the previous page. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  cursor?: string;
}
