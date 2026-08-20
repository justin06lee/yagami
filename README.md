<div align="center">

<img src="assets/yagami.png" alt="yagami" width="330" />

# yagami

**Your signed-in coding-agent CLIs as one self-hosted Anthropic-compatible API.**<br>
*Claude Code, Codex, OpenCode, Gemini CLI and any ACP agent — point any Anthropic client at your own subscriptions, or embed the engine as a library.*

</div>

---

yagami does the T3-Code trick, generalized: it drives the coding-agent CLIs you already installed and logged into — Claude Code through the Agent SDK (`pathToClaudeCodeExecutable`), Codex through `codex exec`, and OpenCode, Gemini CLI, Copilot, Cursor, Qwen Code, Kimi, Goose and the rest of the [ACP registry](https://agentclientprotocol.com) through the Agent Client Protocol. No API keys from any vendor, no separate auth — each spawned engine uses the same login your terminal sessions do. On top it serves `POST /v1/messages` with Anthropic request/response shapes and SSE streaming, so anything that accepts an Anthropic `baseURL` + `apiKey` can use it as a drop-in, and pick a harness per request with `model: "<provider>:<model>"`.

> **Personal use only.** This exists so *you* can point *your own tools* at *your own subscriptions*. Offering subscription-backed access to other people is against every one of these vendors' terms. Keep the endpoint private and don't share keys.

## Install

```sh
make          # bun install + build + install `yagami` onto your PATH (~/.local/bin)
yagami start  # first run generates + saves an API key and prints it
```

`make update` stops any running yagami server, rebuilds, reinstalls, and restarts it.

```
yagami v0.4.0
  listening   http://127.0.0.1:8787
  provider    claude — /Users/you/.local/bin/claude (2.1.238 (Claude Code))
  also        codex, opencode (use model "<provider>:<model>")
  api key     ygm_…
```

Then from any Anthropic client:

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "http://127.0.0.1:8787",
  apiKey: process.env.YAGAMI_KEY, // your ygm_ key
});

await client.messages.create({ model: "sonnet", max_tokens: 1024, messages: [{ role: "user", content: "hello" }] });
await client.messages.create({ model: "codex:gpt-5.6-sol", max_tokens: 1024, messages: [{ role: "user", content: "hello" }] });
await client.messages.create({ model: "opencode:anthropic/claude-sonnet-4", max_tokens: 1024, messages: [{ role: "user", content: "hello" }] });
```

Or raw curl:

```sh
curl http://127.0.0.1:8787/v1/messages \
  -H "x-api-key: ygm_..." -H "content-type: application/json" \
  -d '{"model":"codex","max_tokens":64,"messages":[{"role":"user","content":"ping"}]}'
```

## Providers

A bare model id goes to the **default provider** (Claude Code unless you change it). `"<provider>:<model>"` routes to another harness; a bare provider id (`"codex"`) means that harness's own default model. `GET /v1/models` and `yagami models` list everything that's actually installed, with ids ready to paste.

| Provider | Driven through | Resume | Images | System prompt | Thinking / effort |
|---|---|---|---|---|---|
| `claude` — Claude Code | Agent SDK → your `claude` binary | yes, forking | yes (+ documents) | native | native |
| `codex` — Codex CLI | `codex exec --json` (read-only sandbox) | yes | yes | emulated | effort only |
| `opencode`, `gemini`, `copilot`, `cursor`, `qwen`, `goose`, `kimi`, `kilo`, `cline`, `auggie`, `amp`, `grok`, `droid`, `codex-acp`, `claude-acp` | Agent Client Protocol over stdio | if the agent supports it | if the agent supports it | emulated | — |

"Emulated" means the system prompt is folded into the user turn as a `<system>` block; unsupported `thinking`/`effort` are accepted and reported in `x-yagami-ignored` rather than rejected. Without native forking, a resumed session is single-use: a sibling branch of the same conversation falls back to transcript replay instead of corrupting the shared session.

Any other ACP agent works too — add it to config with its launch command:

```jsonc
{
  "defaultProvider": "claude",
  "providers": {
    "codex":    { "sandbox": "read-only" },                 // "workspace-write" if you trust the callers
    "gemini":   { "path": "/opt/homebrew/bin/gemini" },
    "my-agent": { "command": "my-agent", "args": ["acp"], "label": "My Agent" },
    "goose":    { "enabled": false }                        // hide a preset even if installed
  }
}
```

`yagami doctor` shows every known harness, whether it's installed and signed in, its version, and — for Claude — whether the bundled Agent SDK build matches your binary. Launch commands come from the ACP registry; sign-in hints are best-effort.

### CLI

| Command | What it does |
|---|---|
| `yagami start` | Start the server (`-p` port, `-H` host, `--provider <id>` default provider, `--claude <path>`, `--cors`). Add `--daemon` to run it in the background (`--log <file>` overrides the default log at `~/.config/yagami/yagami.log`) |
| `yagami stop` | Stop the running server |
| `yagami status` | Show whether it's running, plus uptime, request count, and cumulative would-be API cost |
| `yagami models` | List models across every installed provider (`--provider <id>` to filter) |
| `yagami keygen` | Generate another API key and save it to the config |
| `yagami doctor` | Check every harness CLI; `--live` sends one tiny real completion (`--provider <id>` to pick which) |

Every request is logged as one line (time, status, model, duration, cost, session) to stdout — or to the log file in `--daemon` mode.

### Config

`~/.config/yagami/config.json` (override dir with `YAGAMI_CONFIG_DIR`):

```jsonc
{
  "host": "127.0.0.1",          // keep loopback unless you know what you're doing
  "port": 8787,
  "apiKeys": ["ygm_..."],
  "defaultProvider": "claude",  // provider for bare model ids
  "defaultModel": "sonnet",     // used when a request omits `model` (may be "provider:model")
  "providers": { ... },         // see above; every preset is auto-detected when omitted
  "cors": false
}
```

Env overrides: `YAGAMI_HOST`, `YAGAMI_PORT`, `YAGAMI_API_KEY`, `YAGAMI_PROVIDER`, `YAGAMI_DEFAULT_MODEL`, `YAGAMI_CLAUDE_PATH`, `YAGAMI_CODEX_PATH`. The older `claudePath` / `claudeConfigDir` keys still work as shorthands for `providers.claude`.

## Library mode

For apps that want the engine in-process with no HTTP hop (e.g. a desktop app):

```ts
import { YagamiEngine, claudeCodeSession, ClaudeProvider, CodexProvider, AcpProvider } from "yagami";

// 1. Anthropic-shaped completions across every installed harness:
const engine = new YagamiEngine({ defaultModel: "sonnet" });
const { response } = await engine.complete({ messages: [{ role: "user", content: "hello" }] });
const codex = await engine.complete({ model: "codex", messages: [{ role: "user", content: "hello" }] });

// streaming (Anthropic SSE event objects):
const { events } = engine.stream({ model: "opencode", messages: [...], stream: true });
for await (const ev of events) { /* ev.event, ev.data */ }

// hand-pick providers instead of auto-detecting:
const custom = new YagamiEngine({
  providers: [new ClaudeProvider(), new AcpProvider({ id: "gemini", label: "Gemini", command: "gemini", args: ["--acp"] })],
});

// 2. Full agentic Claude Code sessions — tools, permissions, the works.
for await (const msg of claudeCodeSession("fix the failing test", {
  options: { cwd: "/path/to/project", permissionMode: "acceptEdits" },
})) {
  // render SDK messages however you like
}
```

Every provider implements one small `Provider` contract (`run(turn)` → normalized `session`/`text`/`thinking`/`done` events, plus `listModels()` and `version()`), so adding a harness that isn't ACP-capable is one file. Failures are typed: `AuthRequiredError` (carries the login command), `ProviderNotInstalledError` (carries the install hint), `ProviderError`.

### Building a UI on Claude Code

`YagamiEngine` is completions-only by design. To build an actual coding UI — tools, permissions, plan mode, a warm session across turns — use `AgentSession`, which wraps the full Claude Code agent with the lifecycle the interactive terminal gives you for free:

```ts
import { AgentSession } from "yagami";

const session = new AgentSession({
  cwd: "/path/to/project",
  parity: "terminal",          // load your CLAUDE.md, skills, hooks, .mcp.json — like the CLI
  appName: "my-app",           // reported to Claude as the client
  onPermission: async (req) => {
    // Your approve/deny UI. Policy stays here; yagami owns the state machine.
    const ok = await showDialog(req.toolName, req.input);
    return ok ? { behavior: "allow" } : { behavior: "deny", message: "user declined" };
  },
});

session.send("fix the failing test");     // process starts here and stays warm
for await (const msg of session) {        // raw SDKMessages — render however you like
  render(msg);
  if (msg.type === "result") break;
}
session.send("now add a test for the edge case");   // next turn resumes the same session
await session.interrupt();                // the CLI's Esc
await session.setModel("opus");           // the CLI's /model
await session.setPermissionMode("plan");  // shift+tab
session.close();
```

This resolves the parts of embedding Claude Code that every host would otherwise reimplement identically — process lifecycle, session resume, interrupt, settings parity, and the permission state machine. What stays yours are the genuinely app-specific choices: rendering the `SDKMessage` stream, deciding what to auto-approve, and picking the working directory. `parity` is `"terminal"` (load user+project+local settings, matching your CLI), `"project"` (project+local only), or `"isolated"` (load nothing — reproducible, no personal config). The permission `fallback` defaults to `"deny"`, so a session is safe before the UI is wired up; `autoAllow`/`autoDeny` skip the handler for named tools.

For a lower-level handle, `claudeCodeSession(prompt, { options })` returns the raw Agent SDK `Query`.

The server is also embeddable: `import { startYagami } from "yagami/server"`.

## How it works

- **Engine**: each `/v1/messages` request becomes one sandboxed turn on the chosen harness. Claude runs with `tools: []`, `settingSources: []` (your CLAUDE.md/skills never leak into API completions), `maxTurns: 1` and a deny-all permission callback; Codex runs in its read-only sandbox with no approvals; ACP agents are moved to a plan/read-only mode when they offer one and every permission request is refused. All of them work in a throwaway directory. The API is text-in/text-out; a leaked key can burn tokens but never edit anything on the host — though note that agents other than Claude keep their own read-only tools, so they can still *look* at that empty directory.
- **Multi-turn**: the Messages API is stateless but harness sessions aren't. yagami hashes each conversation prefix (per provider) and remembers which session produced it; a follow-up request resumes that session and sends only the new user message. Unmatched histories fall back to replaying the transcript in a single prompt, and if a cached session turns out to be gone, the stale mapping is dropped and the request transparently retries via replay. The cache persists across restarts at `~/.config/yagami/sessions.json`.
- **Streaming**: every harness's output is normalized into deltas and re-emitted as a proper Anthropic SSE sequence — `message_start` → thinking/text content blocks → `message_delta` → `message_stop`. Claude and ACP agents stream tokens; Codex streams per message part.
- **Models**: `GET /v1/models` asks each installed CLI what it supports (Claude via the SDK, Codex via its app-server protocol, ACP agents via their session config) — probed once per process, then cached. Failed probes are skipped and retried next time; a static fallback list is served only if nothing answers (`x-yagami-models-source` says which).
- **Auth**: `x-api-key` or `Authorization: Bearer`, compared in constant time. Binds to `127.0.0.1` by default and warns loudly on anything else.

Extra response headers: `x-yagami-provider`, `x-yagami-cost-usd` (what the turn would have cost at API prices, when the harness reports it), `x-yagami-session`, `x-yagami-ignored` (accepted-but-unsupported params). `/healthz` (unauthenticated) reports the default provider, installed providers, uptime, request count, and the cumulative would-be cost — `yagami status` shows the same.

## Limitations

- No `tools` / `tool_choice` (rejected with 400 — by design, see above). `tool_use`/`tool_result` content blocks are rejected too.
- User messages may contain `text`, `image`, and `document` blocks (documents: Claude only; images: base64 sources only outside Claude); `system` and assistant messages are text-only. Thinking blocks echoed back in assistant history are dropped, not rejected. A conversation whose *history* contains images/documents can only be continued while the server that produced it still has that session cached.
- Assistant prefill (a trailing `assistant` message) is emulated: the engine is instructed to continue from the prefill text, and the response carries only the continuation, like the real API. An accidentally repeated prefill is stripped from the reply, including mid-stream.
- `max_tokens`, `temperature`, `top_p`, `top_k`, `stop_sequences` are accepted but ignored (reported via `x-yagami-ignored`) — none of the CLI engines expose them.
- `thinking` and a yagami-extension `effort` ("low"…"max") are passed through where the harness supports them (see the provider table) and reported as ignored elsewhere.
- Cost is reported only by harnesses that price their own turns (Claude, OpenCode); Codex reports token usage without cost.

## Development

```sh
bun run typecheck && bun run test   # unit tests (no tokens spent)
bun run smoke                       # live end-to-end through your real Claude CLI (tiny token cost)
bun run live:providers              # live check across every installed harness (tiny token cost each)
make build                          # build dist/ only
```
