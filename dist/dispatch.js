#!/usr/bin/env bun
// @bun

// src/cli.ts
import { writeFileSync as writeFileSync4, rmSync as rmSync5, existsSync as existsSync9, readFileSync as readFileSync7 } from "fs";
import { join as join11, resolve } from "path";

// src/models.ts
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from "fs";
import { join } from "path";
var DEFAULT_TIERS = {
  tiers: {
    haiku: "deepseek/deepseek-flash",
    sonnet: "deepseek/deepseek-flash",
    opus: "zai/glm-5.3",
    fable: "zai/glm-5.3",
    "gpt-5.6-luna": "deepseek/deepseek-flash",
    "gpt-5.6-terra": "deepseek/deepseek-flash",
    "gpt-6-astra": "zai/glm-5.3"
  },
  default: "sonnet"
};
function loadTierConfig(paths) {
  const cfg = { tiers: { ...DEFAULT_TIERS.tiers }, default: DEFAULT_TIERS.default };
  for (const p of paths) {
    if (!existsSync(p))
      continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(p, "utf8"));
    } catch (e) {
      throw new Error(`${p}: not valid JSON \u2014 ${e instanceof Error ? e.message : e}`);
    }
    Object.assign(cfg.tiers, parsed.tiers ?? {});
    if (parsed.default)
      cfg.default = parsed.default;
    if (parsed.allow !== undefined) {
      if (!Array.isArray(parsed.allow) || !parsed.allow.every((v) => typeof v === "string" && v.trim() !== "")) {
        throw new Error(`${p}: 'allow' must be an array of model ids, e.g. ["deepseek/deepseek-flash"]`);
      }
      cfg.allow = parsed.allow.map((v) => v.trim());
    }
  }
  return cfg;
}
function ensureUserConfig(home) {
  if (!home)
    return;
  const dir = join(home, ".omp-dispatch");
  const path = join(dir, "config.json");
  if (existsSync(path))
    return { path, created: false };
  try {
    mkdirSync(dir, { recursive: true });
    const content = JSON.stringify({
      tiers: Object.fromEntries(Object.entries(DEFAULT_TIERS.tiers).sort(([a], [b]) => a.localeCompare(b))),
      default: DEFAULT_TIERS.default
    }, null, 2) + `
`;
    const tmp = join(dir, `.config.json.tmp-${process.pid}`);
    writeFileSync(tmp, content);
    renameSync(tmp, path);
    return { path, created: true };
  } catch (e) {
    return { path, created: false, error: e instanceof Error ? e.message : String(e) };
  }
}
function resolveModel(requested, cfg) {
  const trimmed = requested?.trim();
  const key = trimmed ? trimmed : cfg.default;
  return cfg.tiers[key] ?? key;
}

// src/env.ts
import { readFileSync as readFileSync2, existsSync as existsSync2 } from "fs";
import { join as join2 } from "path";
var KEY_EXPORT = /^\s*export\s+([A-Z0-9_]*(?:API_KEY|_TOKEN|_KEY))=(.*)$/;
function keyExportsFrom(shellRc) {
  const out = {};
  for (const line of shellRc.split(`
`)) {
    const m = KEY_EXPORT.exec(line);
    if (!m)
      continue;
    const name = m[1];
    let v = m[2].trim().replace(/\s+#.*$/, "");
    if (v.startsWith('"') && v.endsWith('"') || v.startsWith("'") && v.endsWith("'")) {
      v = v.slice(1, -1);
    }
    if (v.includes("$"))
      continue;
    out[name] = v;
  }
  return out;
}
function loadProviderKeys(home = process.env.HOME ?? "") {
  const merged = {};
  for (const rc of [".zshrc", ".bashrc", ".profile"]) {
    const p = join2(home, rc);
    if (!existsSync2(p))
      continue;
    Object.assign(merged, keyExportsFrom(readFileSync2(p, "utf8")));
  }
  for (const k of Object.keys(merged))
    if (process.env[k])
      delete merged[k];
  return merged;
}

// src/runner.ts
import { appendFileSync as appendFileSync2, mkdirSync as mkdirSync3 } from "fs";
import { join as join6 } from "path";

// src/ompinstall.ts
import { accessSync, constants, existsSync as existsSync3, readFileSync as readFileSync3, realpathSync } from "fs";
import { delimiter, dirname, join as join3 } from "path";
var OMP_RANGE = "^18.1.17";
var PACKAGE = "@oh-my-pi/pi-coding-agent";
var RPC_CLIENT = `${PACKAGE}/modes/rpc/rpc-client`;
function ompsOnPath() {
  const found = [];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir)
      continue;
    const bin = join3(dir, "omp");
    try {
      accessSync(bin, constants.X_OK);
      if (!found.includes(bin))
        found.push(bin);
    } catch {}
  }
  return found;
}
function inspect(bin) {
  let dir;
  try {
    dir = dirname(realpathSync(bin));
  } catch {
    return { bin, packageRoot: null, version: null };
  }
  for (;; ) {
    const manifest = join3(dir, "package.json");
    if (existsSync3(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync3(manifest, "utf8"));
        if (pkg.name === PACKAGE) {
          return { bin, packageRoot: dir, version: typeof pkg.version === "string" ? pkg.version : null };
        }
      } catch {}
    }
    const up = dirname(dir);
    if (up === dir)
      return { bin, packageRoot: null, version: null };
    dir = up;
  }
}
function locateOmp(candidates = ompsOnPath) {
  const installs = candidates().map(inspect);
  return installs.find((i) => i.packageRoot) ?? installs[0] ?? null;
}
function rpcClientPath(install) {
  const from = install ? install.packageRoot ? dirname(install.packageRoot) : null : import.meta.dir;
  if (from) {
    try {
      return Bun.resolveSync(RPC_CLIENT, from);
    } catch {}
  }
  throw new Error(notLoadable(install));
}
function notLoadable(install) {
  return install ? `omp at ${install.bin} is not a JS install, so its RpcClient cannot be loaded. ` + `Install omp with: bun install -g ${PACKAGE}` : `cannot find omp on PATH. Install it with: bun install -g ${PACKAGE}`;
}
function checkOmpVersion(version, range) {
  if (!version)
    return { ok: false, detail: `omp version unknown; this plugin needs omp ${range}` };
  return Bun.semver.satisfies(version, range) ? { ok: true, detail: `omp ${version} satisfies ${range}` } : { ok: false, detail: `omp ${version} is outside ${range}. Update it with: bun install -g ${PACKAGE}` };
}
function rpcCheck(install) {
  if (!install?.packageRoot)
    return { ok: false, detail: notLoadable(install) };
  const version = checkOmpVersion(install.version, OMP_RANGE);
  if (!version.ok)
    return version;
  try {
    return { ok: true, detail: `RpcClient from ${rpcClientPath(install)} (${version.detail})` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
var cache = new Map;
async function loadRpcClient(install = locateOmp()) {
  if (install?.packageRoot) {
    const v = checkOmpVersion(install.version, OMP_RANGE);
    if (!v.ok)
      throw new Error(v.detail);
  }
  const path = rpcClientPath(install);
  const hit = cache.get(path);
  if (hit)
    return hit;
  const mod = await import(path);
  cache.set(path, mod.RpcClient);
  return mod.RpcClient;
}

// src/rundir.ts
import {
  mkdirSync as mkdirSync2,
  writeFileSync as writeFileSync2,
  readFileSync as readFileSync4,
  existsSync as existsSync4,
  readdirSync,
  appendFileSync,
  renameSync as renameSync2,
  statSync,
  rmSync
} from "fs";
import { join as join4 } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
var counter = 0;
function newRunId() {
  const t = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${t}-${(counter++).toString(36).padStart(6, "0")}${Math.random().toString(36).slice(2, 6)}`;
}
function runsRoot(workdir) {
  const base = workdir.replace(/\/+$/, "").split("/").pop() || "root";
  const slug = base.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40);
  const hash = createHash("sha256").update(workdir).digest("hex").slice(0, 8);
  return join4(process.env.HOME ?? homedir(), ".omp-dispatch", "runs", `${slug}-${hash}`);
}
var runDirFor = (workdir, runId) => join4(runsRoot(workdir), runId);
function createRunDir(workdir, runId) {
  const dir = runDirFor(workdir, runId);
  mkdirSync2(dir, { recursive: true });
  return dir;
}
function emptyResult(runId) {
  return {
    run_id: runId,
    name: null,
    state: "running",
    stopped_because: null,
    turns: 0,
    tool_calls: 0,
    cost_usd: 0,
    seconds: 0,
    model: null,
    session_file: null,
    files_changed: [],
    last_reply: null,
    ask: null,
    workdir: null,
    worktree_base: null,
    max_seconds: null,
    error: null
  };
}
function writeResult(runDir, r) {
  const tmp = join4(runDir, `result.json.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  writeFileSync2(tmp, JSON.stringify(r, null, 2));
  renameSync2(tmp, join4(runDir, "result.json"));
}
function readResult(runDir) {
  return JSON.parse(readFileSync4(join4(runDir, "result.json"), "utf8"));
}
function isAlive(runDir) {
  const pidFile = join4(runDir, "broker.pid");
  if (!existsSync4(pidFile))
    return false;
  const pid = Number(readFileSync4(pidFile, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0)
    return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
function listRuns(workdir) {
  const root = runsRoot(workdir);
  if (!existsSync4(root))
    return [];
  return readdirSync(root).sort().reverse().filter((id) => existsSync4(join4(root, id, "result.json"))).map((id) => {
    const dir = join4(root, id);
    let result;
    let readable = true;
    try {
      result = readResult(dir);
    } catch {
      readable = false;
      result = { ...emptyResult(id), state: "error" };
    }
    return { runId: id, dir, result, alive: isAlive(dir), readable };
  });
}
function appendProgress(runDir, line) {
  const startedAt = statSync(runDir).birthtimeMs;
  const secs = Math.round((Date.now() - startedAt) / 1000);
  appendFileSync(join4(runDir, "progress.log"), `[${String(secs).padStart(4)}s] ${line}
`);
}
var DIFF_LIMIT = 256 * 1024;
function writeDiff(runDir, patch) {
  if (!patch)
    return;
  const bounded = patch.length > DIFF_LIMIT ? patch.slice(0, DIFF_LIMIT) + `
[diff truncated at 256KB]
` : patch;
  writeFileSync2(join4(runDir, "diff.patch"), bounded);
}
function readDiff(runDir) {
  try {
    return readFileSync4(join4(runDir, "diff.patch"), "utf8");
  } catch {
    return null;
  }
}

// src/preflight.ts
import { existsSync as existsSync5, mkdtempSync, rmSync as rmSync2 } from "fs";
import { tmpdir } from "os";
import { join as join5 } from "path";
function present(workdir, rel) {
  return rel.map((r) => join5(workdir, r)).filter((p) => existsSync5(p));
}
async function chmodPresent(workdir, rel, mode, verb) {
  for (const p of present(workdir, rel)) {
    const r = await Bun.$`chmod -R ${mode} ${p}`.nothrow().quiet();
    if (r.exitCode !== 0) {
      throw new Error(`failed to ${verb} '${p}': ${r.stderr.toString().trim()}`);
    }
  }
}
async function lockPaths(workdir, rel) {
  await chmodPresent(workdir, rel, "a-w", "lock");
}
async function unlockPaths(workdir, rel) {
  await chmodPresent(workdir, rel, "u+w", "unlock");
}
async function isRepo(workdir) {
  const r = await Bun.$`git rev-parse --is-inside-work-tree`.cwd(workdir).nothrow().quiet();
  return r.exitCode === 0;
}
async function gitSnapshot(workdir) {
  if (!await isRepo(workdir))
    return null;
  const tmpIndex = mkdtempSync(join5(tmpdir(), "omp-dispatch-index-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join5(tmpIndex, "index") };
    const add = await Bun.$`git add -A`.cwd(workdir).env(env).nothrow().quiet();
    if (add.exitCode !== 0) {
      throw new Error(`git add -A failed in ${workdir}: ${add.stderr.toString().trim()}`);
    }
    const tree = (await Bun.$`git write-tree`.cwd(workdir).env(env).quiet().text()).trim();
    if (!/^[0-9a-f]{40,64}$/.test(tree)) {
      throw new Error(`unexpected git write-tree output in ${workdir}: ${tree}`);
    }
    return { tree };
  } finally {
    rmSync2(tmpIndex, { recursive: true, force: true });
  }
}
async function gitDiffSince(workdir, before) {
  if (before === null)
    return null;
  const after = await gitSnapshot(workdir);
  if (!after || after.tree === before.tree)
    return { files: [], patch: "" };
  const files = (await Bun.$`git diff --name-only -M ${before.tree} ${after.tree}`.cwd(workdir).quiet().text()).split(`
`).filter(Boolean).sort();
  const patch = await Bun.$`git diff -M ${before.tree} ${after.tree}`.cwd(workdir).quiet().text();
  return { files, patch };
}

// src/caps.ts
var newCapState = (now = Date.now()) => ({ turns: 0, costUsd: 0, startedAt: now });
function countTurn(s, frame) {
  if (frame.isTerminal === false)
    return false;
  s.turns += 1;
  return true;
}
function breach(s, c, now = Date.now()) {
  if (s.costUsd >= c.maxUsd)
    return "max_usd";
  if (s.turns >= c.maxTurns)
    return "max_turns";
  if ((now - s.startedAt) / 1000 >= c.maxSeconds)
    return "max_seconds";
  return null;
}

// src/asktool.ts
function createAskSupervisor(onAsk) {
  const waiting = new Map;
  let seq = 0;
  const tool = {
    name: "ask_supervisor",
    label: "Ask supervisor",
    description: "Ask the supervising Claude session a question and wait for its answer. Use when " + "you are blocked, or facing a judgement call your instructions did not settle. " + "Do not use it for anything you can answer by reading the repository \u2014 you will " + "be waiting on a human's attention.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question. Be specific." },
        context: { type: "string", description: "What you have already tried or found." }
      },
      required: ["question"]
    },
    execute(params, ctx) {
      const ask = {
        ask_id: `ask_${++seq}`,
        question: params.question,
        context: params.context
      };
      return new Promise((resolve, reject) => {
        waiting.set(ask.ask_id, { resolve, reject, ask });
        ctx.signal?.addEventListener("abort", () => {
          if (waiting.delete(ask.ask_id)) {
            reject(new Error("ask_supervisor was aborted"));
          }
        }, { once: true });
        onAsk(ask);
      });
    }
  };
  return {
    tool,
    answer(askId, text) {
      const w = waiting.get(askId);
      if (!w)
        return false;
      waiting.delete(askId);
      w.resolve(text);
      return true;
    },
    pending() {
      const first = waiting.values().next();
      return first.done ? null : first.value.ask;
    },
    cancelAll(reason) {
      for (const [, w] of waiting)
        w.reject(new Error(reason));
      waiting.clear();
    }
  };
}

// src/runner.ts
function ompCommand() {
  const onPath = locateOmp()?.bin;
  if (onPath)
    return [onPath];
  try {
    return ["bun", Bun.fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent/dist/cli.js"))];
  } catch {
    throw new Error("cannot find omp: it is not on PATH and @oh-my-pi/pi-coding-agent is not " + "resolvable from this plugin. Install omp and make sure `omp --version` works.");
  }
}
function providerError(messages) {
  if (!Array.isArray(messages))
    return null;
  const last = [...messages].reverse().find((m) => m?.role === "assistant");
  if (last?.stopReason !== "error")
    return null;
  const text = typeof last.errorMessage === "string" && last.errorMessage.trim() ? last.errorMessage.trim() : "the provider returned an error";
  const status = typeof last.errorStatus === "number" ? String(last.errorStatus) : null;
  return status && !text.includes(status) ? `${status} ${text}` : text;
}
var MAX_STATS_FAILURES = 3;
var TERMINATION_GRACE_MS = 2000;
function buildOmpArgs(opts) {
  return [
    ...opts.resumeSessionFile ? [`--resume=${opts.resumeSessionFile}`] : [],
    `--tools=${opts.tools}`,
    ...opts.systemPrompt ? [`--append-system-prompt=${opts.systemPrompt}`] : [],
    "--no-lsp",
    "--no-pty",
    `--max-time=${opts.maxSeconds + 60}`
  ];
}
async function startRun(opts, runDir, runId) {
  const result = emptyResult(runId);
  result.name = opts.name ?? null;
  result.max_seconds = opts.maxSeconds;
  const readonly = opts.readonly ?? [];
  const caps = {
    maxTurns: opts.maxTurns,
    maxUsd: opts.maxUsd,
    maxSeconds: opts.maxSeconds
  };
  const state = newCapState();
  const pollIntervalMs = Number(process.env.OMP_DISPATCH_POLL_MS) || 15000;
  let RpcClientClass;
  try {
    RpcClientClass = await (opts.loadClient ?? loadRpcClient)();
  } catch (e) {
    result.stopped_because = "error";
    result.state = "error";
    result.error = e instanceof Error ? e.message : String(e);
    writeResult(runDir, result);
    appendProgress(runDir, `ERROR ${result.error}`);
    appendProgress(runDir, "END error \u2014 could not load omp's RpcClient");
    const neverStarted = async () => {
      throw new Error(`run ${runId}: never started \u2014 could not load omp's RpcClient`);
    };
    return {
      runId,
      runDir,
      result,
      settled: Promise.resolve(result),
      maxSeconds: opts.maxSeconds,
      lastFrame: null,
      say: neverStarted,
      steer: neverStarted,
      answer: () => false,
      stop: async () => {},
      dispose: async () => {}
    };
  }
  writeResult(runDir, result);
  const emptyConfig = join6(runDir, "no-claude-config");
  mkdirSync3(emptyConfig, { recursive: true });
  try {
    await unlockPaths(opts.workdir, readonly);
  } catch (e) {
    appendProgress(runDir, `ERROR failed to repair a stale lock: ${String(e)}`);
  }
  const before = await gitSnapshot(opts.workdir);
  try {
    await lockPaths(opts.workdir, readonly);
  } catch (e) {
    appendProgress(runDir, `ERROR failed to lock paths: ${String(e)}`);
    await unlockPaths(opts.workdir, readonly).catch(() => {});
    result.files_changed = (await gitDiffSince(opts.workdir, before).catch(() => null))?.files ?? [];
    result.stopped_because = "error";
    result.state = "error";
    writeResult(runDir, result);
    appendProgress(runDir, "END error \u2014 failed to lock paths before starting");
    const neverStarted = async () => {
      throw new Error(`run ${runId}: never started \u2014 failed to lock paths under ${opts.workdir}`);
    };
    return {
      runId,
      runDir,
      result,
      settled: Promise.resolve(result),
      maxSeconds: opts.maxSeconds,
      lastFrame: null,
      say: neverStarted,
      steer: neverStarted,
      answer: () => false,
      stop: async () => {},
      dispose: async () => {}
    };
  }
  const [provider, id] = opts.model.includes("/") ? opts.model.split("/") : [undefined, opts.model];
  let childExited;
  let killAgentGroup;
  const spawnAgent = async (agentArgs) => {
    const argv = [...opts.command ?? ompCommand(), ...agentArgs];
    const proc = Bun.spawn(argv, {
      cwd: opts.workdir,
      env: {
        ...process.env,
        ...opts.env ?? {},
        CLAUDE_CONFIG_DIR: emptyConfig
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true
    });
    const killGroup = (signal) => {
      try {
        process.kill(-proc.pid, signal);
      } catch {
        try {
          proc.kill(signal);
        } catch {}
      }
    };
    killAgentGroup = killGroup;
    let stderrTail = "";
    const stderrDrained = (async () => {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder;
      try {
        for (;; ) {
          const { value, done: streamDone } = await reader.read();
          if (streamDone)
            break;
          stderrTail = (stderrTail + decoder.decode(value, { stream: true })).slice(-32768);
        }
      } catch {}
    })();
    const exited = proc.exited.then(async (code) => {
      await stderrDrained.catch(() => {});
      return code;
    });
    childExited = exited;
    const probe = await Bun.$`ps -o pgid= -p ${proc.pid}`.nothrow().quiet();
    const pgid = Number(probe.stdout.toString().trim());
    if (probe.exitCode !== 0 || !Number.isFinite(pgid)) {
      appendProgress(runDir, `NOTE could not verify the agent's process group for pid ${proc.pid}`);
    } else if (pgid !== proc.pid) {
      killGroup("SIGKILL");
      throw new Error(`omp agent pid ${proc.pid} is not its own process-group leader (pgid ${pgid}) \u2014 ` + `refusing to start, because teardown would then reach only the direct child and ` + `leave omp's bash tool calls running against ${opts.workdir}`);
    }
    return {
      stdin: proc.stdin,
      stdout: proc.stdout,
      peekStderr: () => stderrTail,
      kill: (signal, graceMs) => {
        killGroup(signal ?? "SIGTERM");
        if (graceMs !== undefined && graceMs >= 0) {
          const escalate = setTimeout(() => killGroup("SIGKILL"), graceMs);
          escalate.unref?.();
        }
      },
      exited
    };
  };
  const asker = createAskSupervisor((ask) => {
    result.ask = ask;
    result.state = "asking";
    writeResult(runDir, result);
    appendProgress(runDir, `ASK ${ask.question}`);
  });
  const client = new RpcClientClass({
    spawn: spawnAgent,
    provider,
    model: id,
    terminationGraceMs: TERMINATION_GRACE_MS,
    args: buildOmpArgs(opts),
    customTools: [asker.tool]
  });
  let settled;
  let done = new Promise((res) => {
    settled = res;
  });
  let bankedSeconds = 0;
  let finishing = false;
  let disposed = false;
  let statsFailures = 0;
  let followUpsPending = 0;
  let unsubscribeEvents;
  let wallClock;
  let costPoll;
  let lastActivityAt = 0;
  let sawFirstFrame = false;
  let lastEventKind = "";
  let lastHeartbeatCost = 0;
  const armCostPoll = () => {
    const pollIntervalMs2 = Number(process.env.OMP_DISPATCH_POLL_MS) || 15000;
    costPoll = setInterval(() => {
      if (finishing)
        return;
      (async () => {
        const ok = await refreshStats();
        if (finishing || !ok)
          return;
        if (state.costUsd > lastHeartbeatCost + 0.000000001) {
          appendProgress(runDir, `heartbeat turns=${state.turns} $${state.costUsd.toFixed(4)}` + ` last_frame=${Math.max(0, Math.round((Date.now() - lastActivityAt) / 1000))}s`);
          lastHeartbeatCost = state.costUsd;
        }
        const b = breach(state, caps);
        if (b) {
          appendProgress(runDir, `POLL breach detected mid-turn: ${b} ($${state.costUsd.toFixed(4)})`);
          await finish(b);
          return;
        }
        const deadAirMs = Number(process.env.OMP_DISPATCH_DEAD_AIR_MS) || 240000;
        const quietMs = Date.now() - lastActivityAt;
        const toolInFlight = lastEventKind === "tool_execution_start" || lastEventKind === "tool_execution_update";
        if (quietMs > deadAirMs && !toolInFlight && asker.pending() === null) {
          appendProgress(runDir, sawFirstFrame ? `ERROR agent activity stopped ${Math.round(quietMs / 1000)}s ago ` + `(turns=${state.turns}, last event ${lastEventKind || "none"}) \u2014 provider stream ` + `stall suspected. Stopping instead of burning the time cap; retry or redispatch.` : `ERROR no model response within ${Math.round(deadAirMs / 1000)}s of the prompt \u2014 ` + `provider hang suspected (zero turns, zero tool calls). ` + `Stopping instead of burning the time cap; retry, or dispatch on a different tier.`);
          await finish("no_response");
        }
      })();
    }, pollIntervalMs2);
  };
  const finish = async (stopped) => {
    if (finishing)
      return;
    finishing = true;
    clearTimeout(wallClock);
    clearInterval(costPoll);
    let statsError;
    try {
      if (stopped !== "completed")
        await client.abort().catch(() => {});
      try {
        const s = await client.getSessionStats();
        result.cost_usd = s.cost;
        result.tool_calls = s.toolCalls;
        result.session_file = s.sessionFile ?? null;
        result.last_reply = await client.getLastAssistantText();
      } catch (e) {
        statsError = e;
      }
      let unlockError;
      try {
        await unlockPaths(opts.workdir, readonly);
      } catch (e) {
        unlockError = e;
      }
      let gitError;
      let diff = null;
      try {
        diff = await gitDiffSince(opts.workdir, before);
        result.files_changed = diff?.files ?? [];
      } catch (e) {
        gitError = e;
      }
      result.seconds = bankedSeconds + Math.round((Date.now() - state.startedAt) / 1000);
      result.turns = state.turns;
      const unlockFailed = unlockError !== undefined;
      result.stopped_because = unlockFailed ? "error" : stopped;
      result.state = unlockFailed ? "error" : stopped === "completed" ? "completed" : stopped === "aborted" ? "aborted" : stopped === "error" || stopped === "no_response" ? "error" : stopped === "asking" ? "asking" : "capped";
      try {
        if (statsError !== undefined) {
          appendProgress(runDir, `ERROR the final get_session_stats failed \u2014 cost and last reply may be short: ${String(statsError)}`);
        }
        if (unlockError !== undefined) {
          appendProgress(runDir, `ERROR failed to unlock paths \u2014 workspace may still be read-only: ${String(unlockError)}`);
        }
        if (gitError !== undefined) {
          appendProgress(runDir, `ERROR failed to compute files_changed: ${String(gitError)}`);
        }
      } catch {}
      if (diff?.patch) {
        try {
          writeDiff(runDir, diff.patch);
        } catch {}
      }
    } finally {
      asker.cancelAll(`run ${runId} settled (${stopped}) while a question was waiting`);
      unsubscribeEvents?.();
      try {
        writeResult(runDir, result);
      } catch {}
      try {
        appendProgress(runDir, `END ${result.stopped_because} \u2014 $${result.cost_usd.toFixed(4)}, ${result.turns} turns`);
      } catch {}
      settled(result);
    }
  };
  async function refreshStats() {
    try {
      const s = await client.getSessionStats();
      if (s.cost > state.costUsd + 0.000000001)
        lastActivityAt = Date.now();
      state.costUsd = s.cost;
      result.cost_usd = s.cost;
      result.tool_calls = s.toolCalls;
      statsFailures = 0;
      return true;
    } catch (e) {
      statsFailures++;
      appendProgress(runDir, `ERROR get_session_stats failed (${statsFailures}/${MAX_STATS_FAILURES} consecutive): ${String(e)}`);
      if (statsFailures >= MAX_STATS_FAILURES) {
        appendProgress(runDir, `ERROR giving up after ${statsFailures} consecutive stats failures`);
        await finish("error");
      }
      return false;
    }
  }
  const onSessionEvent = async (event) => {
    try {
      if (process.env.OMP_DISPATCH_TRACE) {
        appendFileSync2(join6(runDir, "events.jsonl"), `${JSON.stringify(event)}
`);
      }
      const ev = event.assistantMessageEvent;
      if (!finishing) {
        lastActivityAt = Date.now();
        lastEventKind = ev ? `ame:${ev.type}` : String(event.type);
        if (!sawFirstFrame) {
          sawFirstFrame = true;
          appendProgress(runDir, `FIRST FRAME ${ev?.type ?? event.type} \u2014 provider responding`);
        }
      }
      if (ev?.type === "tool_start") {
        appendProgress(runDir, `${ev.name} ${String(JSON.stringify(ev.input ?? "")).slice(0, 70)}`);
      }
      if (finishing)
        return;
      if (event.type !== "agent_end")
        return;
      if (!countTurn(state, event))
        return;
      const ok = await refreshStats();
      if (finishing)
        return;
      result.turns = state.turns;
      writeResult(runDir, result);
      appendProgress(runDir, `turn ${state.turns} \u2014 $${state.costUsd.toFixed(4)}`);
      const refusal = providerError(event.messages);
      if (refusal) {
        result.error = refusal;
        appendProgress(runDir, `ERROR provider: ${refusal}`);
        await finish("error");
        return;
      }
      if (!ok)
        return;
      const b = breach(state, caps);
      if (b) {
        await finish(b);
        return;
      }
      if (followUpsPending > 0) {
        followUpsPending -= 1;
        return;
      }
      await finish("completed");
    } catch (e) {
      if (!finishing) {
        appendProgress(runDir, `ERROR the session-event handler threw: ${String(e)}`);
        await finish("error").catch(() => {});
      }
    }
  };
  unsubscribeEvents = client.onSessionEvent(onSessionEvent);
  wallClock = setTimeout(() => void finish("max_seconds"), opts.maxSeconds * 1000);
  try {
    await client.start();
    if (!finishing) {
      if (childExited) {
        childExited.then((code) => {
          if (finishing)
            return;
          appendProgress(runDir, `ERROR the omp process exited unexpectedly (code ${code})`);
          finish("error");
        });
      }
      armCostPoll();
      const st = await client.getState();
      result.model = st.model ? { provider: st.model.provider, id: st.model.id } : null;
      result.session_file = st.sessionFile ?? null;
      writeResult(runDir, result);
      appendProgress(runDir, `START ${opts.model}` + (opts.resumeSessionFile ? " (resuming a saved conversation)" : ""));
      await client.prompt(opts.prompt);
      appendProgress(runDir, `PROMPT submitted (${opts.prompt.length} chars)`);
    }
  } catch (e) {
    if (!finishing) {
      appendProgress(runDir, `ERROR ${String(e)}`);
      await finish("error");
    }
  }
  const assertUsable = (what) => {
    if (disposed) {
      throw new Error(`run ${runId}: ${what}() after dispose() \u2014 the omp process is gone`);
    }
    if (finishing) {
      throw new Error(`run ${runId}: ${what}() on a run that has already settled ` + `(${result.stopped_because}) \u2014 resuming a settled run is not supported`);
    }
  };
  const rearm = () => {
    if (disposed) {
      throw new Error(`run ${runId}: say() after dispose() \u2014 the omp process is gone`);
    }
    if (result.stopped_because !== "completed") {
      throw new Error(`run ${runId}: cannot resume a run that stopped because ${result.stopped_because} \u2014 ` + `only a completed run can be continued`);
    }
    const b = breach(state, caps);
    if (b) {
      throw new Error(`run ${runId}: resuming would immediately breach ${b} ` + `($${state.costUsd.toFixed(4)}, ${state.turns} turns) \u2014 start a new run instead`);
    }
    bankedSeconds = result.seconds;
    state.startedAt = Date.now();
    finishing = false;
    result.state = "running";
    result.stopped_because = null;
    done = new Promise((res) => {
      settled = res;
    });
    writeResult(runDir, result);
    appendProgress(runDir, `RESUME turn ${state.turns + 1}`);
    unsubscribeEvents = client.onSessionEvent(onSessionEvent);
    wallClock = setTimeout(() => void finish("max_seconds"), opts.maxSeconds * 1000);
    armCostPoll();
  };
  return {
    runId,
    runDir,
    result,
    maxSeconds: opts.maxSeconds,
    get lastFrame() {
      return lastActivityAt === 0 ? null : { ageMs: Date.now() - lastActivityAt, kind: lastEventKind };
    },
    get settled() {
      return done;
    },
    say: async (text) => {
      const resumed = finishing;
      if (resumed)
        rearm();
      else
        assertUsable("say");
      if (!resumed)
        followUpsPending += 1;
      try {
        await client.followUp(text);
      } catch (e) {
        if (!resumed)
          followUpsPending -= 1;
        throw e;
      }
      return (await done).last_reply ?? "";
    },
    steer: async (text) => {
      assertUsable("steer");
      await client.steer(text);
    },
    stop: async () => {
      await finish("aborted");
    },
    answer: (askId, text) => {
      const ok = asker.answer(askId, text);
      if (ok) {
        result.ask = null;
        result.state = "running";
        writeResult(runDir, result);
        appendProgress(runDir, `ANSWERED ${askId}`);
      }
      return ok;
    },
    dispose: async () => {
      if (disposed)
        return;
      disposed = true;
      await finish("aborted");
      await done;
      await client.stop().catch(() => {});
      killAgentGroup?.("SIGKILL");
    }
  };
}

// src/worktree.ts
import { existsSync as existsSync6 } from "fs";
import { join as join7 } from "path";
import { tmpdir as tmpdir2 } from "os";
import { mkdtempSync as mkdtempSync2, rmSync as rmSync3 } from "fs";
async function isRepo2(dir) {
  const r = await Bun.$`git rev-parse --is-inside-work-tree`.cwd(dir).nothrow().quiet();
  return r.exitCode === 0;
}
async function createWorktree(repoDir, runId) {
  if (!await isRepo2(repoDir)) {
    throw new Error(`worktree isolation needs a git repository, and ${repoDir} is not one \u2014 ` + `run without isolation, or initialise a repo there first.`);
  }
  const root = mkdtempSync2(join7(tmpdir2(), "omp-dispatch-wt-"));
  const path = join7(root, runId);
  const branch = `omp-dispatch/${runId}`;
  const add = await Bun.$`git worktree add -b ${branch} ${path} HEAD`.cwd(repoDir).nothrow().quiet();
  if (add.exitCode !== 0) {
    throw new Error(`failed to create a worktree at ${path}: ${add.stderr.toString().trim()}`);
  }
  return {
    path,
    async cleanup() {
      const status = await Bun.$`git status --porcelain`.cwd(path).nothrow().quiet();
      const dirty = status.exitCode !== 0 || status.stdout.toString().trim().length > 0;
      if (dirty)
        return { removed: false, path };
      await Bun.$`git worktree remove --force ${path}`.cwd(repoDir).nothrow().quiet();
      await Bun.$`git branch -D ${branch}`.cwd(repoDir).nothrow().quiet();
      const removed = !existsSync6(path);
      if (removed)
        rmSync3(root, { recursive: true, force: true });
      return { removed, path };
    }
  };
}

// src/doctor.ts
import { existsSync as existsSync8, mkdirSync as mkdirSync4, rmSync as rmSync4, writeFileSync as writeFileSync3 } from "fs";
import { join as join10 } from "path";
import { homedir as homedir2 } from "os";
import { Database } from "bun:sqlite";

// src/agentdef.ts
import { readFileSync as readFileSync5, existsSync as existsSync7, readdirSync as readdirSync2 } from "fs";
import { join as join8 } from "path";
var TOOL_MAP = Object.freeze({
  Read: "read",
  Write: "write",
  Edit: "edit",
  Bash: "bash",
  Grep: "grep",
  Glob: "glob",
  WebSearch: "web_search",
  WebFetch: "read",
  NotebookEdit: "notebook",
  Agent: "task",
  TodoWrite: "todo"
});
function translateTools(tools, disallowed) {
  const denied = new Set(disallowed.map((t) => t.trim()).filter(Boolean));
  const ompTools = [];
  const dropped = [];
  for (const raw of tools) {
    const name = raw.trim();
    if (!name || denied.has(name))
      continue;
    const mapped = TOOL_MAP[name];
    if (mapped === undefined) {
      if (!dropped.includes(name))
        dropped.push(name);
    } else if (!ompTools.includes(mapped)) {
      ompTools.push(mapped);
    }
  }
  return { ompTools, dropped };
}
function splitFrontMatter(text, source) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m)
    throw new Error(`${source}: no front matter block (expected a --- block at the top)`);
  return { head: m[1], body: m[2].trim() };
}
function parseHead(head, source) {
  const out = {};
  for (const raw of head.split(`
`)) {
    const line = raw.trim();
    if (!line || line.startsWith("#"))
      continue;
    const i = line.indexOf(":");
    if (i < 0)
      throw new Error(`${source}: bad front-matter line: ${raw}`);
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
function toolList(value) {
  if (value === undefined)
    return;
  const v = value.trim();
  if (v === "[]")
    return [];
  const inner = v.startsWith("[") && v.endsWith("]") ? v.slice(1, -1) : v;
  return inner.split(",").map((s) => s.trim()).filter(Boolean);
}
function parseAgentDef(text, source) {
  const { head, body } = splitFrontMatter(text, source);
  const f = parseHead(head, source);
  const name = f.name;
  if (!name)
    throw new Error(`${source}: agent definition must set name`);
  const description = f.description ?? "";
  const declared = toolList(f.tools) ?? Object.keys(TOOL_MAP);
  const { ompTools, dropped } = translateTools(declared, toolList(f.disallowedTools) ?? []);
  let maxTurns;
  if (f.maxTurns !== undefined) {
    const n = Number(f.maxTurns);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`${source}: maxTurns must be a positive integer, got '${f.maxTurns}'`);
    }
    maxTurns = n;
  }
  return {
    name,
    description,
    systemPrompt: body,
    ompTools,
    droppedTools: dropped,
    maxTurns,
    model: f.model || undefined,
    source
  };
}
function loadDir(dir, into, errors) {
  if (!existsSync7(dir))
    return;
  for (const entry of readdirSync2(dir)) {
    if (!entry.endsWith(".md"))
      continue;
    const path = join8(dir, entry);
    try {
      const def = parseAgentDef(readFileSync5(path, "utf8"), path);
      if (!into.has(def.name))
        into.set(def.name, def);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : `${path}: ${String(e)}`);
    }
  }
}
function discoverAgentDefs(cwd, home) {
  const defs = new Map;
  const errors = [];
  loadDir(join8(cwd, ".omp-dispatch", "agents"), defs, errors);
  loadDir(join8(cwd, ".claude", "agents"), defs, errors);
  loadDir(join8(home, ".omp-dispatch", "agents"), defs, errors);
  loadDir(join8(home, ".claude", "agents"), defs, errors);
  return { defs, errors };
}

// src/dispatch.ts
import { readFileSync as readFileSync6, statSync as statSync2 } from "fs";
import { dirname as dirname2, join as join9 } from "path";
function pluginVersion() {
  try {
    const manifest = join9(dirname2(import.meta.path), "..", "package.json");
    return JSON.parse(readFileSync6(manifest, "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
var AGENT_DEFAULTS = {
  tools: "read,write,edit,bash",
  maxTurns: 120,
  maxUsd: 1,
  maxSeconds: 1200
};
var DEFAULT_REPORTING_PROMPT = [
  "You are dispatched fire-and-forget. This one reply is the entire deliverable:",
  "nobody will answer it, nobody will ask a follow-up, and the caller reads the diff.",
  "At most three bullets:",
  "1. what changed \u2014 file names only; never restate what the diff already shows",
  "2. what verifies it \u2014 the commands you ran and their actual output",
  "3. what failed \u2014 its raw output, and no cause you did not establish",
  "Omit any bullet you have nothing for. Do not restate the brief, narrate your",
  "process, explain false starts, or list things you did not do."
].join(`
`);
function runningStatus(name, result, runDir, opts = {}) {
  const elapsed = Math.max(0, Math.round((Date.now() - statSync2(runDir).birthtimeMs) / 1000));
  const budget = opts.maxSeconds && opts.maxSeconds > 0 ? `/${opts.maxSeconds}s` : "";
  const frame = opts.lastFrame ? ` last_frame=${Math.max(0, Math.round(opts.lastFrame.ageMs / 1000))}s` + (opts.lastFrame.kind ? `(${opts.lastFrame.kind.replace(/^ame:/, "")})` : "") : "";
  return `run '${name}': state=${result.state} turns=${result.turns} ` + `tool_calls=${result.tool_calls} cost_usd=${result.cost_usd.toFixed(4)} ` + `elapsed=${elapsed}s${budget}${frame}` + (result.ask ? ` question=${JSON.stringify(result.ask)}` : "");
}
function resolveAgentDef(subagentType, workdir, home) {
  const { defs, errors } = discoverAgentDefs(workdir, home);
  const def = defs.get(subagentType);
  if (!def) {
    const available = [...defs.keys()].sort();
    throw new Error(`omp_agent: no agent definition named '${subagentType}' under ` + `.omp-dispatch/agents or .claude/agents in ${workdir} or the home directory. ` + (available.length ? `Available: ${available.join(", ")}.` : `No definitions were found.`) + (errors.length ? ` Parse errors: ${errors.join("; ")}` : ""));
  }
  if (def.droppedTools.length > 0) {
    throw new Error(`omp_agent: agent '${subagentType}' (${def.source}) requires ` + `${def.droppedTools.length === 1 ? "a tool" : "tools"} omp has no equivalent ` + `for: ${def.droppedTools.join(", ")}. Refusing rather than running a weakened ` + `agent \u2014 use a native subagent for this one.`);
  }
  return def;
}
function resolveDispatchModel(requested, def, workdir, home) {
  const cfg = loadTierConfig([
    join9(home, ".omp-dispatch", "config.json"),
    join9(workdir, ".omp-dispatch", "config.json")
  ]);
  const raw = requested ?? def?.model;
  const trimmed = raw?.trim();
  const origin = requested !== undefined ? `the model argument '${trimmed}'` : def?.model !== undefined ? `agent definition '${def.name}' (${def.source}) setting model: '${trimmed}'` : `the configured default tier '${cfg.default}'`;
  const resolved = resolveModel(raw, cfg);
  if (cfg.allow && !cfg.allow.includes(resolved)) {
    throw new Error(`${origin} resolved to '${resolved}', which is not on this config's allow list.
` + `Allowed models: ${cfg.allow.join(", ")}
` + `Allowed tier names (each maps to a model you configured): ` + `${Object.keys(cfg.tiers).sort().join(", ")} \u2014 pass one of those instead.
` + `Adjust 'allow', 'tiers' or 'default' in ~/.omp-dispatch/config.json or ` + `${join9(workdir, ".omp-dispatch", "config.json")}.`);
  }
  return resolved;
}
function capsFor(def, overrides) {
  return {
    maxTurns: overrides?.maxTurns ?? def?.maxTurns ?? AGENT_DEFAULTS.maxTurns,
    maxUsd: overrides?.maxUsd ?? AGENT_DEFAULTS.maxUsd,
    maxSeconds: overrides?.maxSeconds ?? AGENT_DEFAULTS.maxSeconds
  };
}
function failureReason(result) {
  const reason = result.stopped_because ?? "error";
  return result.error ? `${reason} \u2014 ${result.error}` : reason;
}
function resultFooter(name, result, opts = {}) {
  const modelLabel = result.model ? `${result.model.provider}/${result.model.id}` : opts.modelLabel ?? "";
  const parts = [
    `[omp:${name}]`,
    ...modelLabel ? [`model=${modelLabel}`] : [],
    `turns=${result.turns}`,
    `tool_calls=${result.tool_calls}`,
    `cost_usd=${result.cost_usd.toFixed(4)}`,
    `seconds=${result.seconds}`,
    `stopped_because=${result.stopped_because}`,
    ...Object.entries(opts.extra ?? {}).map(([k, v]) => `${k}=${v}`)
  ];
  const changed = result.files_changed;
  if (changed && changed.length > 0) {
    const joined = changed.join(", ");
    const trimmed = joined.length > 200 ? joined.slice(0, 200) + ` \u2026 (${changed.length} files)` : joined;
    parts.push(`files_changed=${trimmed}`);
    if (opts.runDir)
      parts.push(`diff=${join9(opts.runDir, "diff.patch")}`);
  }
  return `

---
` + parts.join(" ");
}

// src/doctor.ts
function findOmp() {
  const install = locateOmp();
  if (install)
    return { path: install.bin, from: "PATH" };
  return {
    path: Bun.fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent/dist/cli.js")),
    from: "package"
  };
}
function ompDatabases(home) {
  return [
    join10(home, ".omp", "agent", "models.db"),
    join10(home, ".omp", "agent", "agent.db"),
    join10(home, ".omp", "stats.db")
  ];
}
function probeSqlite(path) {
  for (let attempt = 0;attempt < 2; attempt++) {
    let db;
    try {
      db = new Database(path);
      db.exec("PRAGMA busy_timeout = 500");
      db.exec("BEGIN IMMEDIATE");
      db.exec("CREATE TABLE _omp_dispatch_doctor_probe(x)");
      db.exec("DROP TABLE _omp_dispatch_doctor_probe");
      db.exec("ROLLBACK");
      return null;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (attempt === 1)
        return message;
      if (!/locked|busy/i.test(message))
        return message;
    } finally {
      db?.close();
    }
  }
  return null;
}
async function runDiagnostics(workdir) {
  const home = process.env.HOME ?? homedir2();
  let failures = 0;
  let notes = 0;
  const lines = [`omp-dispatch ${pluginVersion()} doctor (workdir: ${workdir})`];
  const ok = (label, detail) => lines.push(`  OK   ${label.padEnd(10)} ${detail}`);
  const note = (label, detail) => {
    notes++;
    lines.push(`  NOTE ${label.padEnd(10)} ${detail}`);
  };
  const fail = (label, detail) => {
    failures++;
    lines.push(`  FAIL ${label.padEnd(10)} ${detail}`);
  };
  ok("runtime", `bun ${Bun.version}`);
  try {
    const omp = findOmp();
    const r = await Bun.$`${omp.path} --version`.nothrow().quiet();
    if (r.exitCode !== 0) {
      const stderr = r.stderr.toString().trim().split(`
`).slice(-3).join(" | ");
      fail("omp", `${omp.path} --version exited ${r.exitCode}` + (stderr ? `: ${stderr}` : " (no stderr)"));
    } else {
      const version = r.stdout.toString().trim();
      ok("omp", `${version || "present"} (${omp.from}: ${omp.path})`);
    }
  } catch (e) {
    fail("omp", `not resolvable \u2014 ${e instanceof Error ? e.message : e}. ` + `Install omp and make sure \`omp --version\` works for the process ` + `launching this server; hosts do not run a login shell, so tools linked ` + `only in ~/.zshrc will not be found.`);
  }
  const rpc = rpcCheck(locateOmp());
  (rpc.ok ? ok : fail)("rpc", rpc.detail);
  const envKeyNames = Object.keys(process.env).filter((k) => /API_KEY$|_TOKEN$|_KEY$/.test(k) && k !== "SSH_KEY" && !k.endsWith("SSH_KEY")).sort();
  const rcKeys = loadProviderKeys(home);
  const rcNames = Object.keys(rcKeys).sort();
  if (envKeyNames.length === 0 && rcNames.length === 0) {
    note("providers", "no provider keys in env or shell rc files \u2014 subscription-billed " + "auth may still work; run `omp models` (or omp_models) to confirm the catalogue");
  } else {
    ok("providers", `${envKeyNames.length} in env${rcNames.length ? `, ${rcNames.length} sourced from shell rc (${rcNames.join(", ")})` : ""}`);
  }
  try {
    const ensured = ensureUserConfig(home);
    if (ensured?.error) {
      fail("tiers", `could not create ${ensured.path}: ${ensured.error}`);
    } else {
      const cfg = loadTierConfig([
        join10(home, ".omp-dispatch", "config.json"),
        join10(workdir, ".omp-dispatch", "config.json")
      ]);
      const def = cfg.tiers[cfg.default] ?? cfg.default;
      ok("tiers", `default ${cfg.default} -> ${def}; palette: ${Object.keys(cfg.tiers).sort().join(", ")}` + (cfg.allow ? `; allow: ${cfg.allow.join(", ")}` : "; allow: unrestricted") + (ensured?.created ? ` \u2014 created ${ensured.path} with the shipped palette, edit it to remap` : ""));
    }
  } catch (e) {
    fail("tiers", String(e instanceof Error ? e.message : e));
  }
  const { defs, errors } = discoverAgentDefs(workdir, home);
  if (errors.length > 0)
    fail("agents", `parse errors: ${errors.join("; ")}`);
  else if (defs.size === 0)
    note("agents", "none found (optional) \u2014 dispatches run on default tools");
  else
    ok("agents", `${[...defs.keys()].sort().join(", ")}`);
  const runsDir = runsRoot(workdir);
  try {
    mkdirSync4(runsDir, { recursive: true });
    const probe = join10(runsDir, ".doctor-probe");
    writeFileSync3(probe, "ok");
    rmSync4(probe);
    ok("runs dir", `writable: ${runsDir}`);
  } catch (e) {
    fail("runs dir", `not writable: ${runsDir} \u2014 ${e instanceof Error ? e.message : e}`);
  }
  const dbs = ompDatabases(home);
  const present2 = dbs.filter(existsSync8);
  if (present2.length === 0) {
    note("databases", `none of omp's exist yet (${dbs.join(", ")}) \u2014 created on first use`);
  } else {
    const broken = present2.map((p) => ({ path: p, error: probeSqlite(p) })).filter((r) => r.error !== null);
    if (broken.length > 0) {
      for (const b of broken) {
        fail("databases", `${b.path}: ${b.error}`);
      }
    } else {
      ok("databases", `${present2.length}/${dbs.length} present, all writable ` + `(models.db, agent.db, stats.db)`);
    }
  }
  const total = lines.length - 1;
  lines.push(`doctor: ${total - failures}/${total} checks passed` + (notes > 0 ? ` (${notes} note${notes === 1 ? "" : "s"})` : ""));
  return { ok: failures === 0, text: lines.join(`
`) };
}

// src/mcp/runs.ts
function uniqueName(desc, taken) {
  const slug = desc.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/^-+|-+$/g, "") || "agent";
  if (!taken(slug))
    return slug;
  let n = 2;
  while (taken(`${slug}-${n}`))
    n++;
  return `${slug}-${n}`;
}

// src/cli.ts
function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0;i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq >= 0) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const name = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = "";
    }
  }
  return { positionals, flags };
}
var SETTLED = {
  completed: true,
  capped: true,
  aborted: true,
  error: true
};
function usageText() {
  return [
    "usage: dispatch <command> [options]",
    "",
    "  start      Dispatch a run and monitor it in the foreground.",
    "             One prompt source is required:",
    "               --prompt <text>        inline",
    "               --prompt-file <path>   file contents",
    "               --prompt -             stdin, for heredocs and pipes",
    "             --description <text>  --model <tier|id>  --subagent-type <name>",
    "               (model: a palette tier like 'sonnet', or a raw omp model id \u2014",
    "                the MCP tool only offers the palette)",
    "  output     Print a run's report (or progress while it runs).",
    "             <run-id prefix | name | latest>  --workdir <abs path>",
    "             --wait <seconds>  --lines N  --diff",
    "  list       List runs on disk for a workdir.  --workdir <abs path>",
    "  stop       Signal a CLI-started run's monitor to settle it as aborted.",
    "             <run-id prefix | name | latest>  --workdir <abs path>",
    "  usage      Totals across the runs on disk for a workdir.",
    "  doctor     Same checks as the omp_doctor tool.  --workdir <abs path>",
    "",
    "Run state lives under ~/.omp-dispatch/runs/<project>-<hash>/ keyed by the",
    "run's workdir \u2014 pass the same --workdir the run used. Kept worktrees list",
    "under the worktree's own path."
  ].join(`
`);
}
function die(err, message) {
  err(`dispatch: ${message}
`);
  return 1;
}
function findRun(runs, ref) {
  if (ref === "latest")
    return runs[0];
  return runs.find((r) => r.runId === ref || r.runId.startsWith(ref) || (r.result.name ?? "") === ref);
}
async function resolvePrompt(flags, opts) {
  const inline = flags["prompt"];
  const file = flags["prompt-file"];
  if (inline !== undefined && inline !== "-" && file !== undefined) {
    throw new Error("pass only one prompt source: --prompt, --prompt-file, or stdin (--prompt -)");
  }
  const label = inline === "-" ? "stdin (--prompt -)" : file === "-" ? "stdin (--prompt-file -)" : file !== undefined ? `--prompt-file ${file}` : null;
  let text = inline !== "-" ? inline : undefined;
  if (file !== undefined && file !== "-") {
    try {
      text = await Bun.file(file).text();
    } catch (e) {
      throw new Error(`cannot read --prompt-file ${file}: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (inline === "-" || file === "-") {
    const reader = opts.stdin ?? (() => Bun.stdin.text());
    text = await reader();
  }
  if (text === undefined) {
    throw new Error("start requires a prompt: --prompt <text>, --prompt-file <path>, or --prompt - for stdin");
  }
  if (text.trim().length === 0) {
    throw new Error(`the prompt from ${label ?? "--prompt"} was empty \u2014 refusing to dispatch a run with no task`);
  }
  return text;
}
async function cmdStart(argv, opts) {
  const { flags } = parseArgs(argv);
  const out = opts.out ?? ((s) => process.stdout.write(s));
  const err = opts.err ?? ((s) => process.stderr.write(s));
  const prompt = await resolvePrompt(flags, opts);
  const baseWorkdir = resolve(flags["workdir"] ?? process.cwd());
  const home = process.env.HOME ?? "";
  const name = flags["name"] ?? uniqueName(flags["description"] ?? prompt, () => false);
  const def = flags["subagent-type"] ? resolveAgentDef(flags["subagent-type"], baseWorkdir, home) : undefined;
  const model = resolveDispatchModel(flags["model"], def, baseWorkdir, home);
  const caps = capsFor(def, {
    maxTurns: flags["max-turns"] ? Number(flags["max-turns"]) : undefined,
    maxUsd: flags["max-usd"] ? Number(flags["max-usd"]) : undefined,
    maxSeconds: flags["max-seconds"] ? Number(flags["max-seconds"]) : undefined
  });
  let targetWorkdir = baseWorkdir;
  let worktree;
  if (flags["isolation"] === "worktree") {
    worktree = await createWorktree(baseWorkdir, name);
    targetWorkdir = worktree.path;
  }
  const runId = newRunId();
  const runDir = createRunDir(targetWorkdir, runId);
  writeFileSync4(join11(runDir, "monitor.pid"), `${process.pid}
`);
  err(`START name=${name} model=${model} max_turns=${caps.maxTurns} ` + `max_usd=${caps.maxUsd.toFixed(2)} max_seconds=${caps.maxSeconds}
` + `run_id=${runId} run_dir=${runDir} workdir=${targetWorkdir}
` + `stop with: dispatch stop ${runId} --workdir ${targetWorkdir}
`);
  const handle = await startRun({
    prompt,
    name,
    model,
    workdir: targetWorkdir,
    tools: def ? def.ompTools.join(",") : AGENT_DEFAULTS.tools,
    systemPrompt: def?.systemPrompt ?? DEFAULT_REPORTING_PROMPT,
    maxTurns: caps.maxTurns,
    maxUsd: caps.maxUsd,
    maxSeconds: caps.maxSeconds,
    env: loadProviderKeys(),
    command: opts.command
  }, runDir, runId);
  handle.result.workdir = targetWorkdir;
  handle.result.worktree_base = worktree ? baseWorkdir : null;
  writeResult(runDir, handle.result);
  let signaled = false;
  const onSignal = () => {
    if (signaled)
      process.exit(130);
    signaled = true;
    err(`dispatch: signal received \u2014 settling the run as aborted...
`);
    handle.stop();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const result = await handle.settled;
    let isolationNote = "";
    if (worktree) {
      const { removed, path } = await worktree.cleanup();
      isolationNote = removed ? `
[omp:${name}] worktree was clean and has been removed` : `
[omp:${name}] worktree kept \u2014 the agent left work in ${path}`;
    }
    out((result.last_reply ?? "(no reply)") + resultFooter(name, result, {
      modelLabel: model,
      runDir,
      ...worktree ? { extra: {
        worktree_branch: `omp-dispatch/${runId}`,
        worktree_base: baseWorkdir
      } } : {}
    }) + isolationNote + `
`);
    if (result.state === "error") {
      err(`dispatch: run '${name}' did not complete: ${failureReason(result)}
`);
      try {
        err(`
${(await runDiagnostics(baseWorkdir)).text}
`);
      } catch {}
      return 1;
    }
    return 0;
  } finally {
    rmSync5(join11(runDir, "monitor.pid"), { force: true });
    await handle.dispose();
  }
}
async function cmdOutput(argv, opts) {
  const { positionals, flags } = parseArgs(argv);
  const out = opts.out ?? ((s) => process.stdout.write(s));
  const err = opts.err ?? ((s) => process.stderr.write(s));
  const workdir = resolve(flags["workdir"] ?? process.cwd());
  const ref = positionals[0] ?? "latest";
  const runs = listRuns(workdir);
  const run = findRun(runs, ref);
  if (!run) {
    return die(err, `no run '${ref}' under ${workdir}` + (runs.length ? `. Known: ${runs.slice(0, 10).map((r) => r.result.name ?? r.runId).join(", ")}` : ". No runs on disk for this workdir."));
  }
  let result = readResult(run.dir);
  const waitSeconds = Number(flags["wait"] ?? 0);
  if (!SETTLED[result.state] && waitSeconds > 0) {
    const deadline = Date.now() + waitSeconds * 1000;
    while (Date.now() < deadline) {
      await Bun.sleep(250);
      result = readResult(run.dir);
      if (SETTLED[result.state])
        break;
    }
  }
  if (SETTLED[result.state]) {
    const diff = readDiff(run.dir);
    out((result.last_reply ?? "(no reply)") + resultFooter(result.name ?? run.runId, result, { runDir: run.dir }) + (flags["diff"] !== undefined ? diff ? `

--- diff (git-derived, vs run start) ---
${diff}` : `

(no file changes \u2014 no diff was written)` : "") + `
`);
    return 0;
  }
  const log = join11(run.dir, "progress.log");
  const lines = existsSync9(log) ? readFileSync7(log, "utf8").split(`
`).filter(Boolean) : [];
  out(runningStatus(result.name ?? run.runId, result, run.dir, { maxSeconds: result.max_seconds }) + `
` + (lines.length ? lines.slice(-Number(flags["lines"] ?? 40)).join(`
`) : "No progress log yet.") + `
`);
  return 0;
}
async function cmdList(argv, opts) {
  const { flags } = parseArgs(argv);
  const out = opts.out ?? ((s) => process.stdout.write(s));
  const runs = listRuns(resolve(flags["workdir"] ?? process.cwd()));
  if (runs.length === 0) {
    out(`No runs on disk for this workdir.
`);
    return 0;
  }
  out(runs.map((r) => `${r.runId}  ${r.result.name ?? "-"}  ${r.result.state.padEnd(9)} ` + `turns=${r.result.turns} cost_usd=${r.result.cost_usd.toFixed(4)} ` + `${r.result.stopped_because ?? ""}`.trimEnd()).join(`
`) + `
`);
  return 0;
}
async function cmdStop(argv, opts) {
  const { positionals, flags } = parseArgs(argv);
  const out = opts.out ?? ((s) => process.stdout.write(s));
  const err = opts.err ?? ((s) => process.stderr.write(s));
  const workdir = resolve(flags["workdir"] ?? process.cwd());
  const ref = positionals[0];
  if (!ref)
    return die(err, "stop requires a run reference (id prefix, name, or latest)");
  const runs = listRuns(workdir);
  const run = findRun(runs, ref);
  if (!run)
    return die(err, `no run '${ref}' under ${workdir}`);
  const pidFile = join11(run.dir, "monitor.pid");
  if (!existsSync9(pidFile)) {
    return die(err, `run '${run.result.name ?? run.runId}' has no monitor on disk \u2014 only runs started ` + `by \`dispatch start\` can be stopped this way. A run owned by the MCP server ` + `is stopped with omp_task_stop.`);
  }
  const pid = Number(readFileSync7(pidFile, "utf8").trim());
  const ps = await Bun.$`ps -p ${pid} -o command=`.nothrow().quiet().text();
  if (!ps.includes("dispatch") && !ps.includes("cli.ts")) {
    return die(err, `pid ${pid} recorded in ${pidFile} is no longer a dispatch monitor \u2014 the run has already ended.`);
  }
  process.kill(pid, "SIGTERM");
  out(`signaled monitor ${pid}; the run settles as aborted and its result lands in ${run.dir}/result.json
`);
  return 0;
}
async function cmdUsage(argv, opts) {
  const { flags } = parseArgs(argv);
  const out = opts.out ?? ((s) => process.stdout.write(s));
  const workdir = resolve(flags["workdir"] ?? process.cwd());
  const runs = listRuns(workdir);
  if (runs.length === 0) {
    out(`No runs on disk for this workdir.
`);
    return 0;
  }
  const by = {};
  let turns = 0, toolCalls = 0, cost = 0, seconds = 0;
  for (const r of runs) {
    by[r.result.state] = (by[r.result.state] ?? 0) + 1;
    turns += r.result.turns;
    toolCalls += r.result.tool_calls;
    cost += r.result.cost_usd;
    seconds += r.result.seconds;
  }
  const outcomes = ["completed", "capped", "aborted", "error", "running", "asking"].map((s) => `${s}=${by[s] ?? 0}`).join(" ");
  out(`dispatched usage for ${workdir} (runs on disk: ${runs.length}): runs=${runs.length} (${outcomes})
` + `turns=${turns} tool_calls=${toolCalls} cost_usd=${cost.toFixed(4)} wall_seconds=${seconds}
`);
  return 0;
}
async function cmdDoctor(argv, opts) {
  const { flags } = parseArgs(argv);
  const out = opts.out ?? ((s) => process.stdout.write(s));
  const report = await runDiagnostics(resolve(flags["workdir"] ?? process.cwd()));
  out(report.text + `
`);
  return report.ok ? 0 : 1;
}
async function runCli(argv, opts = {}) {
  ensureUserConfig(process.env.HOME ?? "");
  const command = argv[0];
  const rest = argv.slice(1);
  const handlers = {
    start: cmdStart,
    output: cmdOutput,
    list: cmdList,
    stop: cmdStop,
    usage: cmdUsage,
    doctor: cmdDoctor
  };
  const handler = handlers[command ?? ""];
  if (handler) {
    try {
      return await handler(rest, opts);
    } catch (e) {
      (opts.err ?? ((s) => process.stderr.write(s)))(`dispatch: ${e instanceof Error ? e.message : e}
`);
      return 1;
    }
  }
  (opts.err ?? ((s) => process.stderr.write(s)))(usageText() + `
`);
  return command === "help" || command === "--help" ? 0 : 2;
}

// bin/dispatch.ts
process.exit(await runCli(process.argv.slice(2)));
