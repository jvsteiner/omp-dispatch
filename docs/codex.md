# Codex integration

Codex supervises; the existing MCP server launches OMP externally. It uses the
same provider configuration, caps, role parser and run storage as Claude Code.

This is an explicit delegation workflow through `omp_agent`, not an interception
of Codex's built-in `spawn_agent`/collaboration tools. OMP runs have their own
names and reports, not native Codex agent threads. Native Codex TOML agent
definitions, conversation history, sandbox settings and host MCP tools are not
forwarded. Give each run a self-contained brief and observe the supervising
session's permissions when delegating.

Codex supports [MCP servers](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
and [plugin packages and legacy marketplaces](https://developers.openai.com/plugins/build/plugins).
The integration uses these extension points rather than a custom model provider:
OMP supplies the external harness as well as its model.

## Install from this checkout

Requires Bun, OMP and working OMP provider authentication on the machine where
Codex runs. Install dependencies before connecting, so the first MCP startup
does not spend Codex's default 10-second startup allowance downloading packages:

```bash
cd /absolute/path/to/omp-dispatch
bun install --frozen-lockfile
codex plugin marketplace add /absolute/path/to/omp-dispatch
codex plugin add omp-dispatch@omp-dispatch
```

The existing `.claude-plugin/marketplace.json` is a supported legacy marketplace
and points to the repository root. Codex selects `.codex-plugin/plugin.json`;
Claude Code selects `.claude-plugin/plugin.json`. Both load the same skill and
launcher, but they address it differently, and the difference is load-bearing:
Codex expands no variables at all (verified against its binary — there is no
`${...}` support). Its `.mcp.json` anchors the launch with `"cwd": "./"` —
resolved against the plugin root at load time — and names the launcher
relative to that cwd (`bin/server.ts`). Args alone are process-cwd-relative,
which only works by accident inside a checkout of this repo. Claude Code does expand
`${CLAUDE_PLUGIN_ROOT}`, but only inside its own plugin manifest, which is why
the Claude manifest carries the variable inline and the shared file does not.
Working in a checkout of this repo, Claude Code may offer the root `.mcp.json`
as a project server; the committed `.claude/settings.json` declines it so the
plugin's server is the only one registered.

Open a new Codex conversation after installation. Invoke `$omp-subagents` and
ask it to call `omp_ping`, then delegate a small read-only task. If the app
cannot find `bun` or `omp`, make them available on its PATH or use absolute
executable paths in the manual configuration below.

After publishing these changes, the marketplace can also be added using
`codex plugin marketplace add jvsteiner/omp-dispatch`. For updates use
`codex plugin marketplace upgrade omp-dispatch`, then start a new conversation.

After an install or an update, pre-warm the launcher once so the first MCP
start of a new conversation spends its budget on protocol, not packages:

```bash
bun /absolute/path/to/omp-dispatch/bin/server.ts --bootstrap
```

If the server ever fails to start or the `omp_*` tools are missing, run
`bun /absolute/path/to/omp-dispatch/bin/server.ts --doctor --workdir <project>`
— it works without a working server and names what to fix.

## Manual MCP setup

For clients without plugin installation, add this to `~/.codex/config.toml`
(or a trusted project's `.codex/config.toml`):

```toml
[mcp_servers.omp-dispatch]
command = "bun"
args = ["/absolute/path/to/omp-dispatch/bin/server.ts"]
startup_timeout_sec = 120
tool_timeout_sec = 60
```

Use an absolute checkout path, not a plugin-root variable, in this manual
configuration. Install the skill by copying `skills/omp-subagents/` into your
project's `.agents/skills/` or `~/.agents/skills/`. Choose either plugin or
manual MCP installation to avoid starting two independent registries.

## Prefer OMP delegation

Add to the target project's `AGENTS.md`:

```markdown
## External subagents

Delegate suitable independent work to the omp-dispatch MCP server using
omp_agent with run_in_background: true and the absolute project workdir.
Supply a self-contained brief. Collect results with omp_task_output using
wait_seconds: 25; answer supervisor questions with omp_answer. Use
omp_send_message with run_in_background: true for follow-ups on completed runs.
Use native Codex agents when the task needs host-only tools or context.
Verify returned diffs and checks before accepting the work.
```

Tool prefixes depend on how Codex exposes the server. Discover by server/tool
name rather than assuming a particular fully qualified prefix.

## Dispatch and collect

Call `omp_agent`:

```json
{
  "name": "retry-review",
  "description": "Trace retry behavior",
  "prompt": "Read src/ and explain retry behavior with path:line citations. Do not edit files.",
  "workdir": "/absolute/path/to/project",
  "run_in_background": true
}
```

Then call `omp_task_output`:

```json
{"name":"retry-review","wait_seconds":25}
```

The dispatch acknowledgement names the resolved model and the caps — check it
against what you intended; a wrong tier is free to fix now (`omp_task_stop`,
redispatch with `model`) and expensive to discover after the run.

Repeat bounded waits until the report arrives. A pending response includes
state, progress and any supervisor question. On the final collect, pass
`include_diff: true` to get the run's git-derived diff appended to the report —
the review is then one read instead of a separate `git diff` (and its
approval). `omp_list_agents` lists active and finished runs. `omp_usage`
totals the session's dispatched runs, turns and cost: quote it when reporting
whether the delegation paid off. `omp_doctor` checks omp's exit status,
its SQLite databases (models/agent/stats, write-probed — a locked or corrupt
database passes `omp --version` and breaks dispatches), provider keys, tiers,
agent definitions and the runs directory — run it first whenever the tools
misbehave. `omp_answer` answers a question;
`omp_steer` corrects active work; `omp_task_stop` stops it. Follow up after
completion with `omp_send_message`:

```json
{"to":"retry-review","message":"Also check the tests for missing cases.","run_in_background":true}
```

Codex's documented default MCP tool timeout is 60 seconds. Background dispatch
returns after OMP starts; `omp_task_output` waits at most 30 seconds. Omitting
background mode retains the existing blocking behavior and may require a
larger client timeout. Background jobs live only as long as this MCP server;
they are not durable jobs across Codex restarts. Artifacts remain on disk.

`isolation: "worktree"` starts from committed HEAD. Dirty worktrees are kept
and their paths reported; nothing is automatically merged. Clean worktrees
are removed after the initial run: start a new run if more isolated work is
needed. Shared-directory runs can be continued in the same server session.

## Roles and models

Roles can live in `<project>/.omp-dispatch/agents/` without any Claude setup:

```markdown
---
name: explorer
description: Read a codebase and answer a question with citations.
tools: Read, Grep, Glob
model: haiku
maxTurns: 30
---
Read and search only. Answer the supplied question with path:line citations.
```

Save as `explorer.md` and pass `subagent_type: "explorer"`. Lookup order is
project `.omp-dispatch`, project `.claude`, home `.omp-dispatch`, home `.claude`
(each under `agents/`). The shipped `agents/` templates are optional examples,
not automatically registered Codex agents.

`model` is a palette of tier names, not vendor models — and it already speaks
Codex: the `gpt-5.6-luna` (fast/mechanical), `gpt-5.6-terra` (everyday) and
`gpt-6-astra` (hard/high-stakes) ids you would pass natively to spawn_agent
are tier names here, alongside Claude-style `haiku`/`sonnet`/`opus`/`fable`.
Pick by job as usual; each name maps to a model the user configured, and
omitting `model` uses their default tier. Configure in
`~/.omp-dispatch/config.json` with per-project overrides (`tiers`, `default`,
and an optional `allow` allow-list). `omp_models` inspects the OMP catalogue;
actual savings depend on the selected provider and task.

## When the server will not start

`bun <plugin-root>/bin/server.ts --doctor --workdir <project>` runs the same
checks as `omp_doctor` with no working server required — use it first; it
names what to fix. After an install or update, `--bootstrap` installs
dependencies off the MCP startup path.

If the server is unavailable for the rest of the session, the `dispatch` CLI
in the plugin root reads and writes the same run directories:

```bash
bun <plugin-root>/bin/dispatch start --prompt-file brief.md --workdir /absolute/path/to/project
# or pipe it: dispatch start --prompt - --workdir ... < brief.md
bun <plugin-root>/bin/dispatch output latest --workdir /absolute/path/to/project --diff
bun <plugin-root>/bin/dispatch usage --workdir /absolute/path/to/project
```

`start` runs in the foreground (monitor it, or background the shell task);
`stop` signals a CLI-started run's monitor to settle it as aborted. Steering
and supervisor questions need the live server; dispatch, collection, diffs and
usage do not. Do not fall back to invoking `omp` directly — that loses caps,
usage accounting, ask/answer and git-derived change reports.
