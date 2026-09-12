import { test, expect } from "bun:test";

interface Frame { type: string; [key: string]: unknown }

function spawnFake(script: Record<string, unknown>) {
  return Bun.spawn(["bun", `${import.meta.dir}/fake-omp.ts`], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, FAKE_OMP_SCRIPT: JSON.stringify(script) },
  });
}

// Reads stdout continuously in the background and appends parsed frames to
// the returned array, so a test can inspect what has arrived so far without
// racing separate reader.read() calls against each other.
function collectFrames(proc: ReturnType<typeof Bun.spawn>): Frame[] {
  const frames: Frame[] = [];
  const decoder = new TextDecoder();
  let buf = "";
  (async () => {
    const reader = proc.stdout.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) frames.push(JSON.parse(line) as Frame);
      }
    }
  })();
  return frames;
}

function send(proc: ReturnType<typeof Bun.spawn>, obj: unknown) {
  proc.stdin.write(`${JSON.stringify(obj)}\n`);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test("the fake emits a ready frame and answers get_session_stats", async () => {
  const p = Bun.spawn(["bun", `${import.meta.dir}/fake-omp.ts`], {
    stdin: "pipe", stdout: "pipe",
    env: { ...process.env, FAKE_OMP_SCRIPT: JSON.stringify({ turnCostUsd: 0.25 }) },
  });
  p.stdin.write(`${JSON.stringify({ id: "1", type: "get_session_stats" })}\n`);
  const reader = p.stdout.getReader();
  const text = new TextDecoder().decode((await reader.read()).value);
  const frames = text.split("\n").filter(Boolean).map(l => JSON.parse(l));
  expect(frames[0].type).toBe("ready");
  p.kill();
});

test("parks after host_tool_call and emits no agent_end until host_tool_result arrives", async () => {
  const p = spawnFake({ turnCostUsd: 0.01, askOnTurn: 1 });
  const frames = collectFrames(p);
  await sleep(200);

  send(p, { id: "1", type: "set_host_tools", tools: [{ name: "ask_supervisor" }] });
  await sleep(100);
  send(p, { id: "2", type: "prompt", text: "go" });
  await sleep(200);

  expect(frames.some(f => f.type === "host_tool_call")).toBe(true);
  // The turn must be parked, not finished — asserting absence, not just
  // eventual presence, since a fake that emits agent_end anyway would look
  // identical if only the end state were checked.
  expect(frames.some(f => f.type === "agent_end")).toBe(false);

  send(p, { id: "3", type: "host_tool_result", toolCallId: "toolu_1", result: "page A" });
  await sleep(200);

  const ends = frames.filter(f => f.type === "agent_end");
  expect(ends.length).toBe(1);
  expect(ends[0].isTerminal).toBe(true);

  p.kill();
});

test("nonTerminalFirst emits isTerminal:false then isTerminal:true, in that order", async () => {
  const p = spawnFake({ turnCostUsd: 0.01, nonTerminalFirst: true });
  const frames = collectFrames(p);
  await sleep(200);

  send(p, { id: "1", type: "prompt", text: "go" });
  await sleep(200);

  const ends = frames.filter(f => f.type === "agent_end");
  expect(ends.length).toBe(2);
  expect(ends[0].isTerminal).toBe(false);
  expect(ends[1].isTerminal).toBe(true);

  p.kill();
});

test("malformed JSON on stdin gets a parse failure response and the loop keeps running", async () => {
  const p = spawnFake({});
  const frames = collectFrames(p);
  await sleep(200);

  p.stdin.write("not json at all\n");
  await sleep(100);
  send(p, { id: "1", type: "get_session_stats" });
  await sleep(200);

  const parseFailure = frames.find(f => f.command === "parse");
  expect(parseFailure).toBeDefined();
  expect(parseFailure?.success).toBe(false);

  // The loop must not have died on the bad line — a command sent afterward
  // still gets answered.
  const statsResponse = frames.find(f => f.command === "get_session_stats");
  expect(statsResponse).toBeDefined();
  expect(statsResponse?.success).toBe(true);

  p.kill();
});

test("an unimplemented command gets a failure response, not a fake success", async () => {
  const p = spawnFake({});
  const frames = collectFrames(p);
  await sleep(200);

  send(p, { id: "1", type: "totally_made_up_command" });
  await sleep(200);

  const response = frames.find(f => f.command === "totally_made_up_command");
  expect(response).toBeDefined();
  expect(response?.success).toBe(false);

  p.kill();
});
