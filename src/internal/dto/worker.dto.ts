import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Identifies the worker instance that owns a run lease. */
export class WorkerDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  workerId!: string;
}
