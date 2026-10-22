import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

/** Scenarios currently supported. Deliveries always target the fixed local demo receiver. */
export const SUPPORTED_SCENARIOS = [
  'duplicate_delivery',
  'receiver_failure',
  'receiver_timeout',
] as const;
export type ScenarioId = (typeof SUPPORTED_SCENARIOS)[number];

/**
 * Bounded, scenario-specific parameters. Everything else (event IDs, target)
 * is generated server-side; unknown/irrelevant parameters are rejected.
 */
export class CreateRunDto {
  @IsIn(SUPPORTED_SCENARIOS)
  scenario!: ScenarioId;

  /** duplicate_delivery only: 1-5 attempts. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  deliveryCount?: number;

  /** Per-delivery timeout (bounded); default depends on the scenario. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(500)
  @Max(15000)
  timeoutMs?: number;

  /** receiver_failure only: injected HTTP status, 400-599. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(400)
  @Max(599)
  httpStatus?: number;

  /** receiver_timeout only: injected delay; must exceed the timeout. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  delayMs?: number;
}
