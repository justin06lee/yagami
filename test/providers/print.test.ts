import { describe, expect, it } from "vitest";
import { PrintProvider } from "../../src/core/providers/print.js";
import { AuthRequiredError, ProviderError, ProviderNotInstalledError } from "../../src/core/errors.js";
import { collect } from "../helpers/fakeProvider.js";

/** A print-mode CLI made of node itself: `script` sees the arguments after it as argv. */
function cli(script: string, extra: Partial<ConstructorParameters<typeof PrintProvider>[0]> = {}, args: string[] = []) {
  return new PrintProvider({ id: "fake", label: "Fake", command: process.execPath, args: ["-e", script, "--", ...args], ...extra });
}

const ECHO_STDIN = 'process.stdin.pipe(process.stdout)';
const ECHO_ARGS = 'process.stdout.write(process.argv.slice(1).join("|"))';

describe("PrintProvider", () => {
  it("writes the prompt to stdin and returns what the CLI prints, without its last newline", async () => {
    const p = cli('let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log("got: "+s))');
    const events = await collect(p.run({ prompt: "ping\n-not-a-flag" }));
    expect(events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("")).toBe("got: ping\n-not-a-flag");
    expect(events.at(-1)).toEqual({ type: "done", usage: { input_tokens: 0, output_tokens: 0 }, stopReason: "end_turn" });
  });

  it("puts the prompt where {prompt} is, and the model where modelArgs say", async () => {
    const p = cli(ECHO_ARGS, { modelArgs: ["--model", "{model}"] }, ["-p", "{prompt}"]);
    expect(p.buildArgs({ prompt: "hi" }).stdin).toBe(false);
    const events = await collect(p.run({ prompt: "hi there", model: "big" }));
    // the model flag follows the mode's own arguments, as a subcommand's flags must
    expect(events[0]).toEqual({ type: "text", text: "-p|hi there|--model|big" });
  });

  it("refuses a model when the print mode takes none", async () => {
    await expect(collect(cli(ECHO_STDIN).run({ prompt: "hi", model: "big" }))).rejects.toThrowError(/takes no model/);
  });

  it("strips terminal colour and keeps inner blank lines", async () => {
    const p = cli('process.stdout.write("\\u001b[32mone\\u001b[0m\\n\\n");setTimeout(()=>process.stdout.write("two\\n"),30)');
    const events = await collect(p.run({ prompt: "" }));
    expect(events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("")).toBe("one\n\ntwo");
  });

  it("fails with the CLI's own words on a non-zero exit, and types a sign-in problem", async () => {
    await expect(collect(cli('console.error("boom: bad flag");process.exit(2)').run({ prompt: "hi" }))).rejects.toThrowError(/exited with code 2: boom: bad flag/);
    const err = await collect(cli('console.error("Not logged in");process.exit(1)').run({ prompt: "hi" })).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(AuthRequiredError);
  });

  it("fails when the CLI prints nothing", async () => {
    const err = await collect(cli("").run({ prompt: "hi" })).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).toMatch(/printed nothing/);
  });

  it("stops the CLI when the turn is aborted", async () => {
    const controller = new AbortController();
    const p = cli('console.log("first");setInterval(()=>{},1000)');
    const seen: string[] = [];
    for await (const ev of p.run({ prompt: "hi", signal: controller.signal })) {
      if (ev.type === "text") {
        seen.push(ev.text);
        controller.abort();
      }
    }
    expect(seen).toEqual(["first"]);
  });

  it("lists the models it was given and reports a missing CLI as not installed", async () => {
    expect(await cli(ECHO_STDIN, { models: ["a", "b"] }).listModels()).toEqual([
      { id: "a", display_name: "a" },
      { id: "b", display_name: "b" },
    ]);
    expect(() => new PrintProvider({ id: "x", label: "X", command: "definitely-not-a-real-binary-xyz" })).toThrowError(ProviderNotInstalledError);
  });
});
