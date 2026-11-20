import type { EngineModel } from "../../src/core/models.js";
import type { PlanLimit, PlanUsage, Provider, ProviderCapabilities, ProviderStatus, TurnEvent, TurnRequest } from "../../src/core/provider.js";

export const FULL_CAPS: ProviderCapabilities = {
  resume: true,
  fork: true,
  images: true,
  documents: true,
  systemPrompt: true,
  thinking: true,
  effort: true,
  streaming: "tokens",
  serverTools: true,
  mcpServers: true,
};

export interface ReplyOptions {
  sessionId?: string;
  thinking?: string;
  costUsd?: number;
  model?: string;
  /** Split the text into these chunks instead of one event. */
  chunks?: string[];
  contextWindow?: number;
  limits?: PlanLimit[];
}

/** Events for one successful turn. */
export function reply(text: string, opts: ReplyOptions = {}): TurnEvent[] {
  const events: TurnEvent[] = [{ type: "session", sessionId: opts.sessionId ?? "sess-1" }];
  if (opts.thinking) events.push({ type: "thinking", text: opts.thinking });
  for (const chunk of opts.chunks ?? [text]) events.push({ type: "text", text: chunk });
  events.push({
    type: "done",
    usage: { input_tokens: 3, output_tokens: 5 },
    costUsd: opts.costUsd ?? 0.01,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.contextWindow ? { contextWindow: opts.contextWindow } : {}),
    ...(opts.limits ? { limits: opts.limits } : {}),
  });
  return events;
}

export type Script = (req: TurnRequest) => TurnEvent[] | Error;

/** A scripted provider: records every turn and replays the configured events. */
export class FakeProvider implements Provider {
  readonly executable = "/fake/bin";
  readonly loginCommand = "fake login";
  readonly calls: TurnRequest[] = [];
  models: EngineModel[] = [{ id: "fake-1", display_name: "Fake 1" }];
  modelsError: Error | undefined;
  script: Script;
  /** Set to give the provider a sign-in check (`status()`); a thrown Error is thrown. */
  signIn: ProviderStatus | Error | undefined;
  /** Set to give the provider plan usage (`limits()`). */
  plan: PlanUsage | undefined;

  constructor(
    readonly id: string,
    readonly capabilities: ProviderCapabilities = FULL_CAPS,
    script: Script = () => reply("hello"),
    readonly label = id,
  ) {
    this.script = script;
  }

  async *run(req: TurnRequest): AsyncGenerator<TurnEvent, void, undefined> {
    this.calls.push(req);
    const out = this.script(req);
    if (out instanceof Error) throw out;
    for (const ev of out) {
      if (req.signal?.aborted) return;
      yield ev;
    }
  }

  async listModels(): Promise<EngineModel[]> {
    if (this.modelsError) throw this.modelsError;
    return this.models;
  }

  async version(): Promise<string | undefined> {
    return "fake 1.0";
  }

  async status(): Promise<ProviderStatus> {
    if (this.signIn instanceof Error) throw this.signIn;
    return this.signIn ?? {};
  }

  async limits(): Promise<PlanUsage | undefined> {
    return this.plan;
  }
}

export async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}
