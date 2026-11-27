# yagami — Provider adapters

One layer of yagami's stack, owning `src/core/provider.ts, src/core/providers/, src/core/executable.ts, src/core/permission.ts, src/core/interaction.ts, src/core/errors.ts, scripts/live-providers.ts, test/helpers/fakeProvider.ts`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer providers` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer providers add|set|drop <section> …`. Where it and the code disagree, the code is right.

The provider adapters layer turns a Provider interface into concrete runners for each harness: the Claude Agent SDK, `codex exec` and `codex app-server`, ACP agents, and generic print or JSONL process CLIs. Each adapter yields the same TurnEvent stream, and capabilities declare what each can natively honor. A newcomer must grasp that the engine emulates or rejects whatever a provider's capabilities do not declare, and that child processes are ended as whole trees, not single PIDs.

## Where to change what

- **Provider interface and capabilities:** src/core/provider.ts, src/core/providers/registry.ts
- **Claude Code adapter (Agent SDK):** src/core/providers/claude.ts, src/core/permission.ts, src/core/claudeModels.ts
- **Codex adapter (exec and app-server sessions):** src/core/providers/codex.ts, src/core/providers/codexSession.ts
- **ACP adapter:** src/core/providers/acp.ts
- **Print and JSONL process runners:** src/core/providers/print.ts, src/core/providers/jsonl.ts
- **Provider presets and registry:** src/core/providers/registry.ts
- **Permission and elicitation prompts from a harness:** src/core/permission.ts, src/core/interaction.ts
- **Process lifecycle and tree kill:** src/core/providers/process.ts, src/core/executable.ts
- **Failure classification:** src/core/errors.ts
- **Turn queue:** src/core/providers/queue.ts
- **Test double and live check:** test/helpers/fakeProvider.ts, scripts/live-providers.ts

## How it works

- **A completion turn through a process provider:** The engine calls the provider's turn method with a TurnRequest → The adapter resolves its CLI binary via executable.ts (explicit path, PATH, then common install dirs) → The adapter spawns the CLI with its non-interactive arguments, writing the prompt to stdin when there is no {prompt} placeholder → Output is read line by line (readline, or JSONL for jsonl.ts) and mapped to TurnEvent values such as session, thinking, text and done → Failures are classified in errors.ts into ProviderError, UsageLimitError or AuthRequiredError → When the turn ends, killTree in process.ts ends the whole process tree
- **A harness asks for permission or input mid-turn:** The adapter receives a tool-permission request or an elicitation from the CLI → permission.ts or interaction.ts converts it into the host-facing request type → The host handler returns a decision → The adapter translates the decision back into the CLI's protocol reply → If no handler is set, a handler throws, or the request is aborted, the configured default decision is used

## Key files

- src/core/provider.ts — the Provider interface, TurnRequest/TurnEvent types and ProviderCapabilities
- src/core/providers/registry.ts — built-in harness presets and provider creation and detection
- src/core/providers/claude.ts — the Claude Code adapter over the Agent SDK
- src/core/providers/codex.ts — the Codex adapter running codex exec
- src/core/providers/codexSession.ts — the live Codex session over codex app-server
- src/core/providers/acp.ts — the ACP client connection and provider
- src/core/providers/print.ts — the generic print-mode CLI runner
- src/core/providers/jsonl.ts — the generic JSONL process runner
- src/core/providers/process.ts — child spawning and whole-tree termination
- src/core/providers/queue.ts — the async queue that serializes events
- src/core/permission.ts — the permission request and decision types and adapter
- src/core/interaction.ts — converts elicitation schemas into input requests and responses
- src/core/errors.ts — typed failures and classification of provider output
- src/core/executable.ts — finds a CLI binary on the host
- test/helpers/fakeProvider.ts — a scripted provider for tests
- scripts/live-providers.ts — manual check against the real signed-in CLIs

## Rules and traps

- Every provider must declare its capabilities honestly; the engine emulates or rejects anything not declared
- Ending a CLI must go through killTree, never a bare child.kill(), because launchers and MCP servers can outlive the top process
- A prompt written as a CLI argument can be read as a flag or exceed the argument limit, so prefer stdin when the args have no {prompt} placeholder
- Failures must be classified in errors.ts so the engine maps them to the right API error
- Permission and elicitation decisions must be translated through permission.ts and interaction.ts, not ad hoc
- Caught errors in this layer are reported through log.ts, not silently dropped

## What it talks to

- Engine — the engine calls each provider's turn and session methods and maps TurnEvent values into SSE and responses
- Engine — reads ProviderCapabilities to decide what to emulate or reject
- Library client — session wrappers and harness listing use the same provider and session types
- Diagnostics — debug() from log.ts reports swallowed failures
- Wire contract — the typed TurnRequest and TurnEvent shapes in provider.ts and types.ts
- Node runtime — spawns the Claude Code, Codex and ACP CLIs installed on the host
