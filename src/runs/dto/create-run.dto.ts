import { IsIn } from 'class-validator';

/** Scenarios currently supported. Deliveries always target the fixed local demo receiver. */
export const SUPPORTED_SCENARIOS = ['duplicate_delivery'] as const;
export type ScenarioId = (typeof SUPPORTED_SCENARIOS)[number];

export class CreateRunDto {
  @IsIn(SUPPORTED_SCENARIOS)
  scenario!: ScenarioId;
}
