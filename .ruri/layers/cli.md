# yagami — Packaging and CLI

One layer of yagami's stack, owning `src/cli.ts, src/index.ts, src/version.ts, tsup.config.ts, scripts/smoke.ts`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer cli` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer cli add|set|drop <section> …`. Where it and the code disagree, the code is right.

This layer is the `yagami` command-line tool and the package's build and public entry points. Commander defines the commands (start, stop, status, key, and daemon mode) in src/cli.ts, which starts the HTTP server through the server layer. tsup bundles the entries into ESM under dist/, and src/index.ts defines the library surface. Before changing anything here, know that the CLI is a thin wrapper that drives the server layer, and that the public API is whatever src/index.ts exports.

## Where to change what

- **CLI commands: start, stop, status, key, daemon mode:** src/cli.ts
- **Version reported by yagami --version:** src/version.ts, src/cli.ts
- **Public library exports (what the package exposes):** src/index.ts
- **Build output and bundle entries (dist/cli.js, index, server, type declarations):** tsup.config.ts
- **End-to-end smoke test against the real Claude Code CLI:** scripts/smoke.ts

## How it works

- **Starting the server from the CLI:** Commander parses the start flags (port, host, claude path, provider) in src/cli.ts → The CLI loads the saved config and the config file through server/config.js → The CLI calls startYagami from the server layer → The running server's state is written to the state file via writeServerState → Later status and stop calls read that state and check whether the recorded process is alive
- **Building the package:** tsup reads tsup.config.ts → It bundles three ESM entries: index, server, and cli → It targets node20 with sourcemaps → Type declarations are emitted for index and server only → clean: true clears dist/ before writing dist/cli.js
- **Smoke test:** scripts/smoke.ts starts the server on a random local port with a throwaway key → It sends a non-streaming request to /v1/messages through the real Claude Code CLI → It checks the response status and text → It exits with code 1 on failure → It is run manually because it spends real tokens

## Key files

- src/cli.ts — the commander commands and daemon handling for the yagami binary
- src/index.ts — the library entry: re-exports the client, harness listing, and Anthropic/OpenAI helpers
- tsup.config.ts — bundle entries, format, target, and declaration setup
- src/version.ts — the VERSION constant shown by the CLI
- scripts/smoke.ts — manual end-to-end check of a real completion

## Rules and traps

- Smoke test costs real tokens against the signed-in Claude Code CLI; run it only by hand
- Declarations are emitted only for index and server, so cli has no .d.ts output
- clean: true in tsup wipes dist/ on every build
- Anything exported from src/index.ts is public API; changing an export changes what library users get
- Server mode is reached through the server entry (yagami/server), not the library index
- src/cli.ts keeps the node shebang; the built dist/cli.js is the executable

## What it talks to

- HTTP server — the CLI starts it with startYagami and reads or writes its state and config files
- Engine — smoke.ts reads the running server's engine.claudePath; index.ts re-exports the engine
- Library client — index.ts re-exports the Yagami client, harness listing, and session types
- Provider adapters — cli.ts uses ClaudeProvider and createProvider to select the backend
- Diagnostics — cli.ts reports through the debug function in core/log
- Node runtime — the bundle targets node20 and runs as an ESM Node program
