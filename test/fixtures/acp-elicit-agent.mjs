// A real ACP agent over stdio for wire-level tests: each prompt asks the
// client one form question and replies with the answer it got.
import { Readable, Writable } from "node:stream";
import { agent, methods, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk/unstable";

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const connection = agent({ name: "wire-agent" })
  .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }))
  .onRequest(methods.agent.session.new, () => ({
    sessionId: "ses-wire",
    configOptions: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "m1", options: [{ value: "m1", name: "Model One" }] }],
  }))
  .onNotification(methods.agent.session.cancel, () => {})
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    const { sessionId } = params;
    const answer = await client.request(methods.client.elicitation.create, {
      sessionId,
      mode: "form",
      message: "Name the workspace",
      requestedSchema: { type: "object", properties: { name: { type: "string", title: "Workspace name" } }, required: ["name"] },
    });
    await client.notify(methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(answer) } },
    });
    await client.notify(methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "usage_update", used: 15, size: 4096, cost: { amount: 0.001, currency: "USD" } },
    });
    return { stopReason: "end_turn", usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 } };
  })
  .connect(stream);
await connection.closed;
