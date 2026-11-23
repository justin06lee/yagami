# yagami — architecture

The shape of this project, for a model that has never seen it: where to change what, the stack it is built as, how the parts connect, where things are, how to run it. Where the work stands — git, decisions, what worked and what didn't, what's open — is in catchup.md beside this file.
Don't edit this file: ruri writes it. `ruri architecture` prints it with every line numbered, and once you have read it that way you can put right what your work changed — `ruri architecture add|set|drop <section> …`. The user corrects it on the architecture page.

Read from the repo at 5021b0e; folded forward from finished turns since. Where it and the code disagree, the code is right.

yagami is a self-hosted gateway that exposes the coding-agent CLIs already installed and signed in on a machine (Claude Code, Codex, OpenCode, Gemini CLI, and any ACP agent) as an Anthropic- and OpenAI-compatible API. It also ships a zero-config library so local apps can drive those CLIs without URLs or API keys. Intended for personal use only.

## The stack, top to bottom

1. **Packaging and CLI** — Node CLI built with commander; start, stop, status, key, daemon mode; tsup bundling to dist/cli.js (`src/, ./, scripts/ · 5 files`)
2. **HTTP server** — Hono app on @hono/node-server; routes for Anthropic and OpenAI dialects, key auth, server config and state files (`src/, src/server/ · 1 file`)
3. **Engine** — YagamiEngine core: request normalization, prefix keys, provider routing, SSE synthesis, error mapping (`src/core/ · 10 files`)
4. **Library client** — Zero-config Yagami client, host config loading, harness listing, Claude Code session wrapper (`src/core/, scripts/ · 8 files`)
5. **Provider adapters** — Provider interface and adapters: Claude Agent SDK, codex exec, ACP, print and JSONL process runners, queues (`src/core/, src/core/providers/, scripts/ +1 · 7 files`)
6. **Diagnostics** — Logging sink for swallowed failures; the one place caught errors are reported (`src/core/log.ts`)
7. **Node runtime** — Node 20+ with Bun for install and build; Claude Code, Codex and ACP CLIs installed on the host

## How it flows

- **An HTTP request:** client app → src/server/app.ts (Hono routes) → src/core/openai.ts or src/core/transcript.ts (dialect translation) → src/core/engine.ts (YagamiEngine) → src/core/providers/ (provider adapter) → src/core/sse.ts or completion body → client app
- **A library call:** Yagami client (src/core/client.ts) → src/core/hostConfig.ts (host config) → src/core/engine.ts (YagamiEngine) → src/core/providers/registry.ts (provider selection) → CLI subprocess or Agent SDK
- **A server tool or MCP turn:** src/core/serverTools.ts or src/core/mcp.ts (tool resolution) → src/core/engine.ts → src/core/providers/claude.ts → Claude Code CLI with WebSearch, WebFetch or MCP servers → mcp_tool_use and mcp_tool_result blocks in reply

## Where things are

- src/cli.ts — yagami binary entry: commander commands
- src/index.ts — library entry: Yagami, YagamiEngine, claudeCodeSession exports
- src/server.ts — startYagami: wires engine, session cache and Hono app
- src/server/app.ts — HTTP routes and auth
- src/server/config.ts — config file, API key, server state paths
- src/core/engine.ts — YagamiEngine, the central request handler
- src/core/client.ts — zero-config library client
- src/core/providers/ — one adapter per CLI or protocol
- src/core/transcript.ts — request normalization and prefix keys
- src/core/openai.ts — OpenAI Chat Completions translation
- test/ — vitest suites, with test/providers/ and test/helpers/fakeProvider.ts
- scripts/ — smoke and live checks against real CLIs
- Makefile — build, install, update targets
- package.json — scripts, dependencies, bin entry

## How to run it

- make — bun install, build, and link yagami into ~/.local/bin
- make update — stop running server, rebuild, reinstall, restart it
- yagami start — run the server; first run generates and saves an API key
- bun run dev — run the CLI from source with tsx
- bun run build — bundle with tsup into dist/
- bun run typecheck — tsc --noEmit
- bun run test — vitest run
- bun run smoke / live:providers / live:session / live:harnesses — script checks in scripts/

## Conventions

- Package manager is bun; the Makefile runs bun install and bun run build
- prepublishOnly must pass typecheck and test before publish
- Keep the endpoint private and do not share API keys (README)

## What it does

- Serves Anthropic /v1/messages and OpenAI /v1/chat/completions with one API key
- Drives signed-in Claude Code via the Agent SDK, no separate vendor keys
- Drives Codex via codex exec and ACP-registry agents via Agent Client Protocol
- Zero-config Yagami library client mirroring Anthropic and OpenAI SDK surfaces
- Library syncs with the host's yagami config file and environment variables
- Anthropic server tools web_search and web_fetch run inside the engine
- MCP connector: mcp_servers and mcp_toolset connect tools for a single turn
- Streaming SSE responses synthesized in both Anthropic and OpenAI dialects
- Full agentic Claude Code sessions embeddable for building UIs
- Session cache maps conversation prefixes to Claude Code session ids for resume
- Detects installed and signed-in CLIs and reports harness status
- Settings parity modes: terminal, project, or isolated config loading
