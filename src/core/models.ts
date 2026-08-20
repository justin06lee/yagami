/** A model a provider reports as available. */
export interface EngineModel {
  id: string;
  display_name: string;
  description?: string;
  /** Canonical wire id an alias resolves to (e.g. "sonnet" → "claude-sonnet-5"). */
  resolved_model?: string;
  /** Provider that serves this model (set by the engine when aggregating). */
  provider?: string;
}
