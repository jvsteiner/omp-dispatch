---
name: omp-subagents
description: Delegate work to external omp agents from Codex or Claude Code using configurable models. Use for OMP delegation, or continuing, steering, inspecting and answering dispatched agents.
---

# Dispatching subagents to omp

Use `omp_agent` from the omp-dispatch MCP server to delegate a bounded task.
Discover the server's tools if they are deferred; host prefixes can vary.
In Claude Code its full name is typically `mcp__omp-dispatch__omp_agent`.
In Codex, this is an external MCP workflow: native subagent tools and thread
IDs do not operate on OMP runs.

**Use a native subagent when** the task needs host-only tools, skills or
conversation context that you cannot include in an OMP brief. OMP uses its own
rules, tools, skills, credentials and permissions. It does not inherit the
host's sandbox or approval settings. Do not use it to bypass a denied action.

When delegation is appropriate and authorized, prefer OMP for independent
exploration, review and implementation tasks. Keep responsibility for checking
the result in the supervising host.

## Start and collect

In Codex, use background mode for both dispatches and follow-ups. Calls return
after startup instead of waiting through the whole task. Always pass the
absolute project `workdir`; an MCP server's own working directory may differ.

```json
{
  "description": "Trace retry handling",
  "prompt": "Read the retry implementation in src/. Explain retry conditions with path:line citations. Do not edit files.",
  "workdir": "/absolute/path/to/project",
  "name": "retry-review",
  "run_in_background": true
}
```

The returned name identifies the run for all subsequent calls. Supply a
self-contained brief: goal, relevant paths, constraints, permitted changes,
acceptance checks and expected output. Conversation history is not forwarded.
For concurrent writers, assign disjoint files or use `isolation: "worktree"`.
Worktrees start from committed HEAD; account for required local changes
before relying on them in an isolated run.

Collect with `omp_task_output({"name":"retry-review","wait_seconds":25})`.
It returns status and progress while active, a question when asking, and the
final report when finished; pass `include_diff: true` to get the run's
git-derived diff appended to a settled report, so reviewing it needs no
separate git call. Waits are capped at 30 seconds to fit Codex's MCP
timeout. Do useful independent work between polls; otherwise use a bounded
wait. Continue collecting until the requested work has settled.

The start acknowledgement names the resolved model and caps. Read it: a
wrong tier is free to fix at dispatch time (`omp_task_stop`, then dispatch
again with another `model:` tier) and expensive to discover after the run.

`omp_agent` and `omp_send_message` remain blocking when `run_in_background`
is omitted, for existing Claude Code workflows.

## Tools

| Tool | Purpose |
|---|---|
| `omp_agent` | Start work; use `run_in_background: true` in Codex |
| `omp_send_message` | Continue a completed run using `to`, `message`, and background mode |
| `omp_list_agents` | List this server session's runs, states, turns and costs |
| `omp_task_output` | Collect report, progress or pending question; `wait_seconds`, `include_diff` |
| `omp_task_stop` | Stop a run by `name` |
| `omp_steer` | Correct an active run using `to` and `message` |
| `omp_answer` | Answer a supervisor question using `name` and `text` |
| `omp_usage` | Session totals — runs, turns, cost — the evidence delegation paid off |
| `omp_doctor` | Check omp, its SQLite databases, providers, tiers, definitions and the runs dir; run first when tools misbehave |
| `omp_models` | Inspect the configured OMP model catalogue |
| `omp_ping` | Check the OMP executable/version |

When a run is `asking`, read the question and answer within your authority, or
ask the user for missing information. An unanswered question consumes the time
cap. Stop the run if it is no longer needed.

## Models and definitions

`model` is a small palette of tier names the user configured — the same
choices you make natively (`haiku`/`sonnet`/`opus`/`fable` for Claude-style
work, `gpt-5.6-luna`/`gpt-5.6-terra`/`gpt-6-astra` for Codex-style, plus any
custom tiers). Each maps to a model the user chose. Pick by job exactly as
your habits say and never weigh cost, vendor or preference — every choice is
pre-approved, and these names are aliases, not requests for a vendor model.
Omit `model` to run on the definition's model or the user's default tier.
Raw model ids are not accepted here; the user exposes them by adding them
as tiers.

Optional `subagent_type` names a Markdown definition found in this order:

1. `<workdir>/.omp-dispatch/agents/`
2. `<workdir>/.claude/agents/`
3. `~/.omp-dispatch/agents/`
4. `~/.claude/agents/`

Definitions use the existing Claude-compatible front matter (`tools`,
`disallowedTools`, `maxTurns`, `model`) and Markdown prompt body. Templates
ship under `agents/` in this plugin; they must be copied to a discovery
directory before being named. Native Codex `.codex/agents/*.toml` files are
not imported. Unsupported required tools are refused explicitly.

## Check results

Read `stopped_because`: `completed` is completion; caps, aborts and errors mean
the work may be partial. `no_response` means the provider never answered the
first prompt (an intermittent hang, seen with `deepseek/deepseek-flash`): the
run spent nothing and changed nothing — redispatch as-is, or on a different
tier if it repeats. Read the diff — `include_diff: true` on
`omp_task_output`, or `diff.patch` in the run directory — and run relevant
checks before accepting an agent's claims. Git-derived `files_changed` is in
the run's `result.json` and the report footer.

Write briefs that make verification cheap: require the agent to return
evidence (path:line citations, links, command output) so reviewing its report
replaces re-running its work. Dispatches are fire-and-forget: the agent's
single reply is the deliverable, so the brief must carry everything — context,
constraints, definition of done — because no follow-up conversation is
planned. Definition-less dispatches run under a terse one-reply contract — at most
three bullets (changed files, verifying command output, failures with raw
output, each omitted when empty); more than three bullets or a restated diff
is a finding, not thoroughness. Do one focused review of
the collected result rather than duplicating the agent's investigation in the
supervising session — every host-side check you run is an approval prompt the
delegation was supposed to remove.

A dirty worktree is kept and its path reported. A clean worktree is removed
after the initial run, so start a new isolated run instead of resuming one
whose worktree was removed. Work is not merged automatically.

## When the omp_* tools are missing

If the server's tools are not available, do not fall back to running `omp`
directly — that loses the caps, the usage accounting, `ask_supervisor`,
git-derived `files_changed` and the diff, which is most of the reason to
delegate through this plugin at all.

1. Find the plugin root (the checkout the marketplace cloned).
2. Run `bun <plugin-root>/bin/server.ts --doctor --workdir <project>` — it
   works even when the server cannot start, and names what to fix.
3. After an install or an update, pre-warm once with
   `bun <plugin-root>/bin/server.ts --bootstrap` so dependency installation
   never eats the host's MCP startup budget.
4. Use the `dispatch` CLI in the plugin root for the degraded path:
   `bun <plugin-root>/bin/dispatch start --prompt-file <brief.md> --workdir <project>`
   (or `--prompt -` to pipe the brief; foreground; monitor it), then `... dispatch output latest --workdir
   <project> --diff`, `list`, `usage`, `stop`, `doctor` — the same run
   directories on disk, the same reports and footers. Steering and answering
   questions need the live MCP server; everything else survives without it.

Runs and continuation handles belong to the current MCP server process.
Disconnecting stops its child processes; saved artifacts remain under
`~/.omp-dispatch/runs/` and stay readable through `dispatch output`, but a run
cannot be resumed by name after a restart.
