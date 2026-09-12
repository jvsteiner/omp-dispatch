import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOmpArgs, startRun, type RunOptions } from "../src/runner.ts";
import { newRunId, createRunDir } from "../src/rundir.ts";

// omp already loads its own skills, rules, extensions and MCP servers by
// default. Task 5 removes the three flags that used to strip them (carried
// over from a different project's minimal-token-floor posture, where it made
// sense; it does not belong in a general subagent tool). The default
// direction changed, so asserting presence would have passed under the OLD
// behaviour too — only absence proves the fix.
test("skills, rules and extensions are NOT stripped", () => {
  const argv = buildOmpArgs({ tools: "read,edit", maxSeconds: 300 });
  expect(argv).not.toContain("--no-skills");
  expect(argv).not.toContain("--no-rules");
  expect(argv).not.toContain("--no-extensions");
});

// --tools= is not isolation — it's the agent definition's own `tools:` field
// being honoured, real parity with native Claude subagents — so it stays.
test("the tools allowlist is still passed", () => {
  const argv = buildOmpArgs({ tools: "read,edit", maxSeconds: 300 });
  expect(argv).toContain("--tools=read,edit");
});

// --no-lsp and --no-pty are runtime noise, not capabilities, so they stay
// exactly as before.
test("--no-lsp and --no-pty are still passed", () => {
  const argv = buildOmpArgs({ tools: "read", maxSeconds: 300 });
  expect(argv).toContain("--no-lsp");
  expect(argv).toContain("--no-pty");
});

// CLAUDE_CONFIG_DIR is not part of the argv this task touches — omp reads
// external tool configs (.claude/, .cursor/) profile-independently, so
// without an empty CLAUDE_CONFIG_DIR a dispatched agent would inherit the
// HOST's Claude MCP servers, which is the one thing --no-skills etc. were
// never actually paying for. This must survive the flag-removal refactor
// untouched. Uses the same FAKE_OMP_DUMP mechanism as runner.test.ts's own
// "launched ... with the tools, system prompt and max-time" test (extended
// here to also report CLAUDE_CONFIG_DIR — see test/fake-omp.ts and the
// task-5 report's disclosure) rather than intercepting Bun.spawn, so the
// test observes the real env the child received instead of a patched global.
test("CLAUDE_CONFIG_DIR still points at an empty directory", async () => {
  const dumpDir = mkdtempSync(join(tmpdir(), "omp-cfgdir-dump-"));
  const dump = join(dumpDir, "argv.json");
  process.env.FAKE_OMP_DUMP = dump;
  process.env.FAKE_OMP_SCRIPT = JSON.stringify({});
  try {
    const workdir = mkdtempSync(join(tmpdir(), "omp-cfgdir-"));
    const runId = newRunId();
    const runDir = createRunDir(workdir, runId);
    const opts: RunOptions = {
      prompt: "do it", model: "fake/fake-1", workdir, tools: "read",
      maxTurns: 120, maxUsd: 1.0, maxSeconds: 300,
      command: ["bun", `${import.meta.dir}/fake-omp.ts`],
    };
    const handle = await startRun(opts, runDir, runId);
    try {
      await handle.settled;
    } finally {
      await handle.dispose();
    }

    const launched = JSON.parse(readFileSync(dump, "utf8")) as { claudeConfigDir?: string };
    expect(launched.claudeConfigDir).toBeTruthy();
    expect(existsSync(launched.claudeConfigDir!)).toBe(true);
    expect(readdirSync(launched.claudeConfigDir!)).toEqual([]);
  } finally {
    delete process.env.FAKE_OMP_DUMP;
  }
}, 30_000);
