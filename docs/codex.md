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
launcher. `.mcp.json` uses Codex's supported `CLAUDE_PLUGIN_ROOT` compatibility
variable to locate the installed launcher.

Open a new Codex conversation after installation. Invoke `$omp-subagents` and
ask it to call `omp_ping`, then delegate a small read-only task. If the app
cannot find `bun` or `omp`, make them available on its PATH or use absolute
executable paths in the manual configuration below.

After publishing these changes, the marketplace can also be added using
`codex plugin marketplace add jvsteiner/omp-dispatch`. For updates use
`codex plugin marketplace upgrade omp-dispatch`, then start a new conversation.

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

Repeat bounded waits until the report arrives. A pending response includes
state, progress and any supervisor question. `omp_list_agents` lists active and
finished runs. `omp_answer` answers a question; `omp_steer` corrects active work;
`omp_task_stop` stops it. Follow up after completion with `omp_send_message`:

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

The existing `haiku`, `sonnet` and `opus` names are configurable OMP model tiers.
They do not choose Claude or Codex models. Both hosts use the same
`~/.omp-dispatch/config.json` and per-project overrides. Use `omp_models` to
inspect the OMP catalogue. Actual savings depend on the selected provider and
task; no Codex cost comparison has been measured here.
