// A real ACP agent over stdio for wire-level tests: each prompt asks the
// client one form question and replies with the answer it got.
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const conn = new AgentSideConnection(
  (client) => ({
    initialize: async () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }),
    newSession: async () => ({ sessionId: "ses-wire" }),
    authenticate: async () => ({}),
    cancel: async () => {},
    prompt: async ({ sessionId }) => {
      const answer = await client.createElicitation({
        sessionId,
        mode: "form",
        message: "Name the workspace",
        requestedSchema: { type: "object", properties: { name: { type: "string", title: "Workspace name" } }, required: ["name"] },
      });
      await client.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(answer) } } });
      return { stopReason: "end_turn" };
    },
  }),
  stream,
);
await conn.closed;
