# omp-dispatch — design

> Status: draft for review
> Date: 2026-09-12
> Source: `~/Documents/omp-supervisor-brief.md`, plus `omp v18.1.17` docs read on disk

## 1. Summary

A Claude Code plugin that lets a Claude session dispatch bulk work to `omp`
subagents and hold a real conversation with them.

Claude plans and verifies. A shell script does every mechanical step. `omp` does
the bulk reading and writing at roughly a fifth of the token floor and a
twenty-fifth of the per-token price.

The unit of work is a **run**. A run owns a long-lived `omp --mode rpc` process
held by a small **broker**, addressed through a unix socket. Claude talks to it
with `dispatch say` and `dispatch steer`, reads progress with `dispatch tail`,
and reads a small `result.json` at the end.

## 2. Why

Measured on this machine, in the `~/wiki` project:

| | tokens |
|---|---|
| Claude Code startup floor, empty task | 53,272 |
| `omp` startup floor, stripped | 10,322 |

Cost per document ingested, deepseek-v4-flash through omp:

| | cost each |
|---|---|
| 1 document alone | $0.272 |
| 4 documents batched | $0.080 |

Batching is the dominant lever, not model choice. Setup context is paid once per
run, so a run that handles four documents amortises it four ways.

A reference run — rewrite 10 wiki pages, move facts between them — took 133
turns, 172 tool calls, 699 seconds, and cost **$0.16**.

The pattern worked. It was ad hoc. This makes it reusable.

## 3. Non-goals

- **No model router.** The caller names the model. Batching beats model choice.
- **No replacement for native subagents.** A task that needs Claude's MCP
  servers, skills, or permission mode should use a native subagent. See §13.
- **No worktree isolation in v1.** `omp worktree` exists and can be wired in
  later behind a task-file key.
- **No in-process SDK embedding.** omp's own docs say to use RPC mode when you
  want process isolation. We want process isolation.

## 4. Feature parity with native subagents

This is the bar the design is measured against.

| Native subagent | omp-dispatch | Status |
|---|---|---|
| `Agent(prompt)` → report | `dispatch run` | parity |
| `SendMessage` | `dispatch say` (RPC `follow_up`) | parity |
| `run_in_background` | `dispatch run --bg` + `Bash(run_in_background)` | parity |
| `ListAgents` | `dispatch list` | parity |
| `TaskOutput` | `dispatch tail` | parity |
| `TaskStop` | `dispatch stop` (RPC `abort`) | parity |
| `.claude/agents/*.md` roles | `roles/*.md` | parity |
| parallel dispatch | several `Bash` calls in one message | parity |
| — | `dispatch steer` — interrupt a running turn | **beyond** |
| — | `ask_supervisor` host tool — agent asks Claude mid-run | **beyond** |
| — | run survives the Claude session ending | **beyond** |
| inherits Claude's MCP + skills + permissions | never | **deliberate gap** |

The last row is the whole point. Inheriting Claude's tool surface is what costs
53k tokens. We are buying the cheap floor by giving it up.

## 5. Architecture

```
~/Code/omp-dispatch/
  .claude-plugin/
    plugin.json
    marketplace.json
  skills/dispatch-to-omp/
    SKILL.md
    references/cost-model.md
    references/gotchas.md
    references/parity.md
  bin/dispatch                 bash — the only entry point Claude calls
  broker/broker.ts             bun — owns omp stdio, serves the unix socket
  broker/fake-omp.ts           bun — test double that speaks the RPC protocol
  roles/                       named reusable roles
  README.md
```

Why a broker exists: every `Bash` call Claude makes is a new process. Something
has to hold omp's stdin and stdout between calls. `broker.ts` runs detached,
spawns `omp --mode rpc`, and listens on a socket inside the run directory.

`bin/dispatch` is a thin client. It never talks to omp directly.

```
Claude ──Bash──> bin/dispatch ──unix socket──> broker.ts ──stdio──> omp --mode rpc
                                                   │
                                                   └──> events.jsonl, progress.log, result.json
```

## 6. The task file

YAML front matter, then the prompt body.

```yaml
---
model: deepseek/deepseek-v4-flash
workdir: /Users/jamie/wiki
readonly: [raw, schema, CLAUDE.md]
tools: read,write,edit,bash
max_turns: 120
max_usd: 1.00
max_seconds: 3300
role: ingest            # optional; merges roles/ingest.md underneath
---

Ingest everything in inbox/ following CLAUDE.md exactly.
Batch all four documents in one pass.
```

Every key except the body has a default. `role:` pulls a template from `roles/`
and the task file's own keys win over it.

RPC mode rejects `@file` command-line arguments, so the body is delivered as an
RPC `prompt` command, not as argv.

## 7. The run directory

Created under the workdir, gitignored.

```
<workdir>/.omp-dispatch/runs/<run_id>/
  task.md          verbatim copy of the input
  meta.json        model, caps, session file path, broker pid, socket path
  sock             unix domain socket
  broker.pid
  events.jsonl     every RPC frame, raw
  progress.log     one human line per action
  result.json      the small file Claude reads
  ask.json         present only while parked on a question
```

`run_id` is `<utc-timestamp>-<6 random chars>`.

### result.json

```json
{
  "run_id": "20260912T141005Z-a3f9c1",
  "state": "completed",
  "stopped_because": "completed",
  "turns": 133,
  "tool_calls": 172,
  "cost_usd": 0.16,
  "seconds": 699,
  "model": { "provider": "deepseek", "id": "deepseek-v4-flash" },
  "session_file": "/Users/jamie/.omp/agent/sessions/-Users-jamie-wiki/2026-...jsonl",
  "files_changed": ["wiki/a.md", "wiki/b.md"],
  "last_reply": "Rewrote 10 pages; moved 6 facts.",
  "ask": null
}
```

`state` is one of `running`, `asking`, `completed`, `capped`, `aborted`, `error`.

**`files_changed` comes from git, never from the agent.** Snapshot `git
status --porcelain` before the run, diff it after. An agent that forgets to
write a manifest looks identical to one that did nothing, and a wrong manifest
is worse than none. Git already knows. When the workdir is not a git repo, fall
back to an mtime snapshot of the writable paths.

## 8. Commands

```
dispatch run    <task.md> [--bg]   start a run; prints run_id
dispatch say    <id> "message"     RPC follow_up; waits; prints the reply
dispatch steer  <id> "message"     RPC steer; interrupts the current turn
dispatch answer <id> "text"        answer a parked ask_supervisor question
dispatch list                      all runs, with alive/dead
dispatch tail   <id> [-n N]        progress.log
dispatch stop   <id>               RPC abort, shut down, unlock paths
dispatch result <id>               print result.json
```

Without `--bg`, `run` blocks until the run settles and prints the result path.
With `--bg` it prints the `run_id` immediately; Claude pairs it with
`Bash(run_in_background: true)` so the harness re-invokes on exit.

### Socket protocol

Newline-delimited JSON, one request and one response per line. This is our own
protocol, not omp's.

```json
{"op":"say","text":"..."}      → {"ok":true,"reply":"...","turns":9,"cost_usd":0.04}
{"op":"steer","text":"..."}    → {"ok":true}
{"op":"answer","ask_id":"...","text":"..."} → {"ok":true}
{"op":"state"}                 → the current result.json body
{"op":"stop"}                  → {"ok":true}
```

## 9. Caps

**omp has no turn cap and no budget cap.** It has only `--max-time`. The
reference run of 133 unattended turns had nothing stopping it but the clock.
Enforcing these is the main thing this tool adds over calling omp directly.

The broker counts and kills:

- **`max_turns`** — increment on each `agent_end` frame where
  `isTerminal !== false`. A frame with `isTerminal: false` means maintenance
  scheduled more work; it is not a completed turn.
- **`max_usd`** — `getSessionStats().cost` after each completed turn. omp
  maintains this; we never parse usage ourselves.
- **`max_seconds`** — wall clock in the broker, plus `--max-time` on omp as a
  second line of defence, plus `timeout` around the broker as a third.

On breach the broker sends RPC `abort`, waits a grace period, then hard kills.
It writes `result.json` with the matching `stopped_because`, restores the
locked paths, and exits. Abort first, kill second — a hard kill leaves the
`chmod` stale.

### Stop and ask

An agent that is stuck should stop, not thrash. Two routes:

1. It calls the `ask_supervisor` host tool (§12). Preferred.
2. It writes `STOP-AND-ASK.md` in the workdir. The broker notices and aborts.

Either way `state` becomes `asking` and Claude is the one who decides.

## 10. Preflight and path locking

`bin/dispatch run` does all of this before any model exists.

1. **Provider guard.** If the model names a provider, assert `omp models` lists
   that model under that provider. Abort otherwise. omp matches model ids
   fuzzily and will silently route through OpenRouter's copy when the named
   provider has no key — a real incident in the reference project. Check the
   catalogue; never probe by sending a prompt.
2. **Shrink the tool surface.** Pass `--tools=<allowlist> --no-skills
   --no-rules --no-extensions --no-lsp --no-pty`, and export
   `CLAUDE_CONFIG_DIR=<empty dir>`. Measured: this takes the agent from 13 tools
   to 6. `--tools=` does the work; the empty config dir is free insurance. See
   the correction in §15 — the brief's claim about MCP inheritance did not
   reproduce in RPC mode at v18.1.17.
3. **Repair stale locks.** `chmod -R u+w` the readonly paths first, every time.
   A previous run killed with `-9` never ran its exit trap and left them
   unwritable. Clear that before it compounds.
4. **Lock the paths.** `chmod -R a-w <readonly paths>`. At the OS level, before
   the model starts. Harness-agnostic and stronger than any allow or deny list.
5. **Snapshot git.**
6. **Spawn the broker.**

An exit trap in the broker restores permissions. `dispatch list` also repairs
stale locks it finds, so a `kill -9` cannot wedge the workdir.

### Why OS-level and not a permission file

Claude Code's permission system cost the reference project real time:

- `acceptEdits` mode does not cover Bash.
- An untrusted workspace silently discards `permissions.allow` entirely.
- `*` mid-pattern is not a wildcard. `Bash(python3 scripts/*.py:*)` matches
  nothing; each script must be enumerated.
- `Write(...)` deny rules are inert. Only `Edit(...)` is checked.

`chmod` has none of these problems.

## 11. Progress parsing

`events.jsonl` holds every raw frame. `progress.log` holds one readable line per
action. Eleven minutes of silence is indistinguishable from a hang.

**Counts come from `getSessionStats()`, never from counting frames.** The
reference project hand-parsed a stream and had to dedupe tool calls by id,
because content blocks repeat across `message_start`, `message_end` and
turn-end. RPC mode makes that unnecessary: omp keeps the totals and hands them
over on request.

`progress.log` still reads frames, but only to say what is happening, never to
produce a number. The one counting rule that survives is **count a turn only on
an `agent_end` where `isTerminal !== false`** (§9), which the broker needs for
`max_turns` before a turn's stats exist.

## 12. `ask_supervisor` — the agent asks Claude

RPC mode lets the host expose its own tools to the agent via `set_host_tools`.
omp then emits `host_tool_call` frames, and the host replies with
`host_tool_result`. The bundled `RpcClient.setCustomTools()` wraps this.

v1 exposes exactly one host tool:

```
ask_supervisor(question: string, context?: string)
```

Flow:

1. The agent calls it when it is blocked or facing a judgement call.
2. The broker receives `host_tool_call`, writes `ask.json`, sets `state` to
   `asking`, and does **not** reply yet. The agent's turn parks.
3. Claude reads `dispatch result <id>`, sees the question, and answers with
   `dispatch answer <id> "..."`.
4. The broker sends `host_tool_result`. The agent continues with the answer as
   the tool's return value.

An unanswered ask counts against `max_seconds`, so a parked run cannot hang
forever.

This closes the last parity row and goes past it. A native Claude subagent
cannot stop and ask its parent anything.

## 13. When not to use this

The skill must say this plainly, or it will be used wrongly.

**Use a native Claude subagent when:**

- the task needs Claude's MCP servers, skills, or permission setup
- the task is short — the setup floor dominates, and file plumbing costs more
  than it saves
- the result needs Claude's judgement all the way through

**Use omp-dispatch when:**

- the task is bulk reading or writing across many files
- several similar items can be batched into one run
- the work is mechanical once the plan exists
- the run should outlive the Claude session

## 14. Resilience

The broker is a daemon, and daemons die. Three mitigations:

1. **The omp session file is the durable record.** Every run also writes an
   ordinary session JSONL. If the broker is gone, `dispatch say` falls back to
   `omp -r <session> -p "<message>"` automatically. Live path is RPC, durable
   path is resume. The conversation is never lost.
2. **Pidfile plus idle timeout.** `dispatch list` reaps dead brokers, repairs
   stale `chmod`, and marks their runs `error`.
3. **Everything is on disk.** `events.jsonl` is appended as frames arrive, so a
   crash loses nothing already received.

## 15. Facts verified, and assumptions still to confirm

Verified by reading `omp v18.1.17` on disk:

- `--mode rpc` is a documented newline-JSON protocol over stdio.
- Commands exist for `prompt`, `follow_up`, `steer`, `abort`, `get_state`,
  `get_session_stats`, `switch_session`, `get_last_assistant_text`, `compact`.
- `set_host_tools` / `host_tool_call` / `host_tool_result` exist as described.
- `agent_end` carries the optional `isTerminal` flag.
- `RpcClient` ships in the package at `src/modes/rpc/rpc-client.ts`, with
  `setCustomTools()`.
- `bun 1.4.0` is installed.
- omp has `-r/--resume`, `--session-dir`, `--max-time`, and **no** turn or
  budget cap.

All four of the original open questions are now closed.

1. **`getSessionStats()` returns cumulative cost.** `SessionStats` carries
   `cost: number`, `toolCalls`, `totalMessages`, a full `tokens` breakdown, and
   `sessionFile`. **No session-JSONL parsing is needed anywhere.** omp already
   counts correctly, so the dedupe-by-tool-call-id rule from the reference
   project does not apply to this design — it only applies to hand-parsed
   streams.
2. **`interruptMode` already defaults to `"immediate"`.** `steer` works with no
   extra setup: steering is checked between tool calls and can abort the
   remaining tool calls in a turn. `steeringMode` and `followUpMode` both
   default to `"one-at-a-time"`, which is what we want.
3. **`setCustomTools()` schema confirmed.** Each tool is
   `{ name, label, description, parameters, hidden?, loadMode?, execute(params, ctx) }`.
   `execute` returns a promise. **The broker implements `ask_supervisor` by
   simply not resolving that promise** until `dispatch answer` arrives. No
   manual frame handling at all.
4. **`RpcClient` has everything the broker needs:** `start`, `stop`, `prompt`,
   `steer`, `followUp`, `abort`, `getState`, `getSessionStats`,
   `getLastAssistantText`, `waitForIdle(timeout)`, `promptAndWait`,
   `switchSession`, `compact`, `setCustomTools`.

### Correction to the source brief

The brief names `CLAUDE_CONFIG_DIR=<empty dir>` as "the single most important
flag for cost control", because `--tools=` and `--no-extensions` reportedly
failed to stop omp exposing 29 chrome-devtools MCP tools.

**That did not reproduce.** Measured on omp v18.1.17 in RPC mode, via
`getState().dumpTools`, inside a real project that has MCP servers configured:

| Configuration | Tools exposed |
|---|---|
| real `CLAUDE_CONFIG_DIR`, no `--tools`, no `--no-extensions` | 13 — all omp built-ins, **zero MCP** |
| real `CLAUDE_CONFIG_DIR`, with `--tools` and `--no-extensions` | 6 |
| empty `CLAUDE_CONFIG_DIR`, with `--tools` and `--no-extensions` | 6 |

Conclusions:

- **`--tools=` is the load-bearing lever in RPC mode.** It cut 13 to 6.
- **`CLAUDE_CONFIG_DIR` made no measurable difference here.** The brief's
  finding was in print mode and may be mode-specific or since fixed. Keep the
  empty config dir — it is free insurance and harmless — but do not describe it
  as the critical lever.
- **`--tools=read,write,edit,bash` does not fully bind.** `manage_skill` and
  `learn` survive it, and survive `--no-skills` too. Two unrequested tools reach
  the agent. Not dangerous, but the allowlist is not airtight, so path locking
  by `chmod` stays the real boundary.
- omp's own `task` and `hub` tools exist. Allowlisting them would let a
  dispatched agent fan out further. Out of scope for v1, deliberately.

## 16. Testing

Money must not be required to test the machinery.

- **`broker/fake-omp.ts`** — a test double that speaks the RPC protocol and
  replays canned frame sequences. Every cap, the ask flow, broker death,
  stale-lock repair, and the resume fallback are tested against it, offline and
  free.
- **`dispatch run --dry-run`** — runs preflight, prints the resolved omp argv
  and the lock plan, spawns nothing.
- **One paid smoke test** at the end, against a flash model, on a throwaway
  directory. Asserts a real turn completes and `result.json` is well formed.

Each milestone ships with its tests passing before the next begins.

## 17. Milestones

| | Ships | Done when |
|---|---|---|
| M1 | preflight, provider guard, path locking, one-shot run, caps, `result.json` | replaces the reference `ingest.sh` omp branch |
| M2 | broker, socket, `say` / `steer` / `tail` / `stop` / `list`, resume fallback | a two-turn conversation works |
| M3 | `ask_supervisor` host tool | the agent parks a question and Claude answers it |
| M4 | roles, `SKILL.md`, references, README | Claude picks the right harness unprompted |

## 18. Open for review

Three decisions, each with the pick this spec assumes. Override any of them.

1. **Where run state lives.** Assumed: `.omp-dispatch/` inside the workdir,
   gitignored. Easier to find when a run goes wrong, and it dies with the
   project. The alternative, `~/.omp-dispatch/` keyed by workdir, keeps the
   project clean but hides the evidence.
2. **`max_usd` default.** Assumed: `1.00`. The reference run cost $0.16, so this
   is six times a known-good run — generous enough not to trip on normal work,
   small enough that a runaway is caught before it matters.
3. **Dirty git tree.** Assumed: commit first, do not refuse. The reference
   script commits pre-existing changes as `wip:` so the run's own diff is clean
   and `git revert` undoes exactly the run. Refusing would just make Claude do
   the same commit by hand.
