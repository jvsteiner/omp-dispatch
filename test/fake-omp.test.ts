import { test, expect } from "bun:test";

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
