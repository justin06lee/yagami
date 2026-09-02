/** One model-native reasoning setting. */
export interface EngineReasoningEffort {
  id: string;
  description?: string;
}

/** One provider service tier (for example Codex's priority tier). */
export interface EngineServiceTier {
  id: string;
  display_name: string;
  description?: string;
}

export type EngineInputModality = "text" | "image" | "audio" | "document" | (string & {});

/** A model a provider reports as available, including its native controls. */
export interface EngineModel {
  id: string;
  display_name: string;
  description?: string;
  /** Canonical wire id an alias resolves to (e.g. "sonnet" → "claude-sonnet-5"). */
  resolved_model?: string;
  /** Provider that serves this model (set by the engine when aggregating). */
  provider?: string;
  /** Reasoning levels this particular model accepts. */
  reasoning_efforts?: EngineReasoningEffort[];
  default_reasoning_effort?: string;
  input_modalities?: EngineInputModality[];
  supports_adaptive_thinking?: boolean;
  supports_fast_mode?: boolean;
  supports_auto_mode?: boolean;
  supports_personality?: boolean;
  /** Provider-native multi-agent runtime, when the catalog reports one. */
  multi_agent?: string;
  service_tiers?: EngineServiceTier[];
  default_service_tier?: string;
  is_default?: boolean;
}
