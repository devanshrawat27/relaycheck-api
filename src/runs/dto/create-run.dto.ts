import { IsIn } from 'class-validator';

/** Scenarios currently supported. Deliveries always target the fixed local demo receiver. */
export const SUPPORTED_SCENARIOS = [
  'duplicate_delivery',
  'receiver_failure',
  'receiver_timeout',
] as const;
export type ScenarioId = (typeof SUPPORTED_SCENARIOS)[number];

export class CreateRunDto {
  @IsIn(SUPPORTED_SCENARIOS)
  scenario!: ScenarioId;
}
