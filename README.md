<div align="center">

<img src="assets/yagami.svg" alt="yagami" width="330" />

# yagami

**Your signed-in Claude Code CLI as a self-hosted Anthropic-compatible API.**<br>
*Point any Anthropic client at your own subscription — or embed the engine as a library.*

</div>

---

yagami does the T3-Code trick: it drives the Claude Agent SDK with `pathToClaudeCodeExecutable` pointed at the `claude` binary you already installed and logged into. No API key from Anthropic, no separate auth — the spawned engine uses the same login your terminal sessions do. On top of that it serves `POST /v1/messages` with Anthropic request/response shapes and SSE streaming, so anything that accepts an Anthropic `baseURL` + `apiKey` can use it as a drop-in.

> **Personal use only.** This exists so *you* can point *your own tools* at *your own subscription*. Offering subscription-backed access to other people is against Anthropic's terms. Keep the endpoint private and don't share keys.

## Install

```sh
make          # bun install + build + install `yagami` onto your PATH (~/.local/bin)
yagami start  # first run generates + saves an API key and prints it
```

`make update` stops any running yagami server, rebuilds, reinstalls, and restarts it.

```
yagami v0.1.0
  listening   http://127.0.0.1:8787
  claude      /Users/you/.local/bin/claude (2.1.235 (Claude Code))
  api key     ygm_…
```

Then from any Anthropic client:

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "http://127.0.0.1:8787",
  apiKey: process.env.YAGAMI_KEY, // your ygm_ key
});

const msg = await client.messages.create({
  model: "claude-sonnet-5",       // any model id/alias your CLI accepts, e.g. "sonnet"
  max_tokens: 1024,
  messages: [{ role: "user", content: "hello" }],
});
```

Or raw curl:

```sh
curl http://127.0.0.1:8787/v1/messages \
  -H "x-api-key: ygm_..." -H "content-type: application/json" \
  -d '{"model":"sonnet","max_tokens":64,"messages":[{"role":"user","content":"ping"}]}'
```

### CLI

| Command | What it does |
|---|---|
| `yagami start` | Start the server (`-p` port, `-H` host, `--claude <path>`, `--cors`) |
| `yagami keygen` | Generate another API key and save it to the config |
| `yagami doctor` | Check binary/config/keys; `--live` sends one tiny real completion |

### Config

`~/.config/yagami/config.json` (override dir with `YAGAMI_CONFIG_DIR`):

```jsonc
{
  "host": "127.0.0.1",          // keep loopback unless you know what you're doing
  "port": 8787,
  "apiKeys": ["ygm_..."],
  "claudePath": "~/.local/bin/claude",  // optional; auto-resolved from PATH
  "claudeConfigDir": null,      // optional CLAUDE_CONFIG_DIR isolation for the engine
  "defaultModel": "sonnet",     // used when a request omits `model`
  "cors": false
}
```

Env overrides: `YAGAMI_HOST`, `YAGAMI_PORT`, `YAGAMI_API_KEY`, `YAGAMI_CLAUDE_PATH`, `YAGAMI_DEFAULT_MODEL`.

## Library mode

For apps that want the engine in-process with no HTTP hop (e.g. a desktop app like ruri):

```ts
import { YagamiEngine, claudeCodeSession } from "yagami";

// 1. Anthropic-shaped completions, Claude Code underneath:
const engine = new YagamiEngine({ defaultModel: "sonnet" });
const { response } = await engine.complete({
  messages: [{ role: "user", content: "hello" }],
});

// streaming (Anthropic SSE event objects):
const { events } = engine.stream({ model: "sonnet", messages: [...], stream: true });
for await (const ev of events) { /* ev.event, ev.data */ }

// 2. Full agentic Claude Code sessions — tools, permissions, the works.
//    Uses the `claude_code` system prompt preset by default, so behavior
//    matches the interactive CLI. This is the primitive for building UIs.
for await (const msg of claudeCodeSession("fix the failing test", {
  options: { cwd: "/path/to/project", permissionMode: "acceptEdits" },
})) {
  // render SDK messages however you like
}
```

The server is also embeddable: `import { startYagami } from "yagami/server"`.

## How it works

- **Engine**: each `/v1/messages` request becomes a Claude Agent SDK `query()` against your installed CLI with `tools: []` (no built-in tools exist for the model), `settingSources: []` (your CLAUDE.md/skills never leak into API completions), `maxTurns: 1`, a deny-all permission callback, and a throwaway working directory. The API is pure text-in/text-out; a leaked key can never execute anything on the host.
- **Multi-turn**: the Messages API is stateless but Claude Code sessions aren't. yagami hashes each conversation prefix and remembers which session produced it; a follow-up request resumes (forking) that session and sends only the new user message. Unmatched histories fall back to replaying the transcript in a single prompt. The cache persists across restarts at `~/.config/yagami/sessions.json`.
- **Streaming**: the SDK's partial-message events carry raw Anthropic stream events, which are passed through nearly verbatim — `message_start` → `content_block_delta` → `message_stop`, like the real API.
- **Auth**: `x-api-key` or `Authorization: Bearer`, compared in constant time. Binds to `127.0.0.1` by default and warns loudly on anything else.

Extra response headers: `x-yagami-cost-usd` (what the turn would have cost at API prices), `x-yagami-session`, `x-yagami-ignored` (accepted-but-unsupported params).

## Limitations (v1)

- No `tools` / `tool_choice` (rejected with 400 — by design, see above).
- Text content blocks only: no images, documents, or tool results.
- Assistant prefill (a trailing `assistant` message) is emulated: the engine is instructed to continue from the prefill text, and the response carries only the continuation, like the real API. An accidentally repeated prefill is stripped from the reply, including mid-stream.
- `max_tokens`, `temperature`, `top_p`, `top_k`, `stop_sequences` are accepted but ignored (reported via `x-yagami-ignored`) — the CLI engine doesn't expose them.
- `thinking` and a yagami-extension `effort` ("low"…"max") are passed through to the engine.

## Development

```sh
bun run typecheck && bun run test   # unit tests (no tokens spent)
bun run smoke                       # live end-to-end through your real CLI (tiny token cost)
make build                          # build dist/ only
```
