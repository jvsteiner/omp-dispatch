#!/usr/bin/env bun
/**
 * The one test that spends money. Everything else runs against test/fake-omp.ts.
 *
 * Dispatches a trivial task to a real model in a throwaway git repo, then
 * checks the agent actually did it — not that it said it did.
 */
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp/server.ts";

const MODEL = process.env.SMOKE_MODEL ?? "deepseek/deepseek-flash";

const repo = mkdtempSync(join(tmpdir(), "omp-smoke-"));
await Bun.$`git init -q`.cwd(repo).quiet();
writeFileSync(join(repo, "README.md"), "smoke\n");
await Bun.$`git add -A`.cwd(repo).quiet();
await Bun.$`git -c user.email=t@t -c user.name=t commit -qm init`.cwd(repo).quiet();

const [a, b] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "smoke", version: "0" }, { capabilities: {} });
await Promise.all([createServer().connect(a), client.connect(b)]);

const fail = (m: string) => { console.error(`FAIL: ${m}`); process.exit(1); };

console.error(`dispatching to ${MODEL} in ${repo} ...`);
const r: any = await client.callTool({
  name: "omp_agent",
  arguments: {
    description: "smoke write file",
    prompt: "Create a file called hello.md containing exactly one line: it works\n" +
            "Then stop. Do not read or write anything else.",
    model: MODEL,
    name: "smoke",
    workdir: repo,
  },
});

const text = r.content?.[0]?.text ?? "";
console.error("--- agent report ---");
console.error(text);
console.error("--------------------");

if (r.isError) fail(`dispatch errored: ${text}`);

// The point of the test: did it actually happen, not did it claim to.
const target = join(repo, "hello.md");
if (!existsSync(target)) fail("hello.md was not created — the agent reported success it did not achieve");
const body = readFileSync(target, "utf8").trim();
if (!/it works/i.test(body)) fail(`hello.md says ${JSON.stringify(body)}`);

if (!/stopped_because=completed/.test(text)) fail("the run did not stop cleanly");
if (!/files_changed|hello\.md/.test(text) && !existsSync(target)) fail("files_changed did not reflect the write");

// A second turn on the same run — the resume path, against a real model.
console.error("continuing the same run ...");
const r2: any = await client.callTool({
  name: "omp_send_message",
  arguments: { to: "smoke", message: "Now add a second line to hello.md saying: and it talks back" },
});
const text2 = r2.content?.[0]?.text ?? "";
console.error(text2);
if (r2.isError) fail(`send_message errored: ${text2}`);

const after = readFileSync(target, "utf8");
if (!/talks back/i.test(after)) fail(`the follow-up did not land; hello.md is ${JSON.stringify(after)}`);

const turns1 = Number(/turns=(\d+)/.exec(text)![1]);
const turns2 = Number(/turns=(\d+)/.exec(text2)![1]);
if (!(turns2 > turns1)) fail(`the resumed run ran no further turn (${turns1} -> ${turns2})`);

await client.close();
console.error(`\nSMOKE OK  — ${repo}`);
