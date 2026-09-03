import type { EngineModel } from "../../src/core/models.js";
import type { Provider, ProviderCapabilities, TurnEvent, TurnRequest } from "../../src/core/provider.js";

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
};

export interface ReplyOptions {
  sessionId?: string;
  thinking?: string;
  costUsd?: number;
  model?: string;
  /** Split the text into these chunks instead of one event. */
  chunks?: string[];
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
}

export async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}
