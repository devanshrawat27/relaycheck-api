import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** Delivery outcomes the runner may record for an attempt. */
export const ATTEMPT_OUTCOMES = ['delivered', 'error', 'timeout'] as const;

export class RecordAttemptDto {
  @IsInt()
  @Min(1)
  @Max(1000)
  attemptNumber!: number;

  @IsString()
  @IsNotEmpty()
  eventId!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(599)
  httpStatus?: number;

  @IsIn(ATTEMPT_OUTCOMES)
  outcome!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  durationMs!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  errorDetail?: string;
}

export class RecordAssertionDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  expected!: string;

  @IsString()
  actual!: string;

  @IsBoolean()
  passed!: boolean;
}

export class FinalizeRunDto {
  @IsIn(['passed', 'failed', 'error'])
  status!: 'passed' | 'failed' | 'error';

  @IsString()
  @MaxLength(2000)
  summary!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  safeError?: string;
}
