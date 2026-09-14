# omp-dispatch

Delegate work from **Claude Code or Codex** to subagents running on
[omp](https://github.com/oh-my-pi), using your configured providers and models.
Claude Code keeps the familiar `Agent` argument shape and `.claude/agents/*.md`
definitions. Codex uses the same MCP server with background dispatch and polling.

**Codex:** see [installation and workflow](docs/codex.md).

Previously measured startup cost for an empty task (Claude Code comparison;
Codex startup savings have not been measured):

| | tokens |
|---|---|
| Claude Code | 53,272 |
| omp, tool-restricted | 10,322 |

## What it gives you

```
Agent({ description, prompt, subagent_type: "reviewer", model: "sonnet" })

mcp__omp-dispatch__omp_agent({ description, prompt, subagent_type: "reviewer", model: "sonnet" })
```

Your existing agent definitions are read unmodified. `tools:`,
`disallowedTools:`, `maxTurns:` and `model:` all apply. A definition asking for
a tool omp has no equivalent for — `Skill`, an `mcp__*` tool — is **refused**,
naming the tool, rather than quietly running weakened.

Run controls:

- **`omp_steer`** interrupts the turn an agent is in the middle of.
- **`ask_supervisor`** lets a stuck agent ask *you* a question and wait.
  `omp_answer` resumes it.
- **`omp_doctor`** checks everything a dispatch depends on — including
  whether omp's own SQLite databases (models, agent state, usage stats) are
  actually writable — and names what to fix. The same checks run without the server:
  `bun <plugin>/bin/server.ts --doctor`.
- **`omp_usage`** totals the session's dispatched runs, turns and cost.
- A background start acknowledges the resolved **model and caps** — a wrong
  tier is catchable at dispatch time — and `omp_task_output` accepts
  **`include_diff`** to return a run's git diff with its report.
- Definition-less dispatches run under a **fire-and-forget reporting
  contract**: one reply, at most three bullets — changed files, verifying
  command output, failures with raw output (each omitted when empty). No
  narration, no restated diff, no causal theories.
- A dispatch that fails **explains itself**: the doctor's findings ride
  along with the error, one call instead of two.

## Install

These commands install into Claude Code. For Codex, use the
[Codex setup guide](docs/codex.md).

This repository is its own marketplace, so adding it comes first — `install`
alone will not find the plugin.

```bash
claude plugin marketplace add jvsteiner/omp-dispatch
```

```bash
claude plugin install omp-dispatch@omp-dispatch
```

The two names are the same here because the marketplace and the plugin it
carries share a name. Inside a Claude Code session the same steps are
`/plugin marketplace add jvsteiner/omp-dispatch` then
`/plugin install omp-dispatch@omp-dispatch`.

To pick up later changes:

```bash
claude plugin marketplace update omp-dispatch
```

Requires `omp` and `bun` on PATH.

## Repository layout

| Path | Purpose |
|---|---|
| `.claude-plugin/` | Claude manifest and marketplace (also readable by Codex) |
| `.codex-plugin/plugin.json`, `.mcp.json` | Codex manifest and MCP launch configuration (plugin-root-relative) |
| `src/`, `bin/` | Shared runner, lifecycle, MCP server and the `dispatch` CLI |
| `skills/omp-subagents/` | Delegation workflow for both hosts |
| `agents/` | Optional Markdown role templates for either host |
| `docs/codex.md` | Codex installation, limitations and examples |

Both hosts discover role definitions in project `.omp-dispatch/agents/`,
project `.claude/agents/`, user `~/.omp-dispatch/agents/`, then user
`~/.claude/agents/`, in that order. Copy a shipped template into one of those
directories before passing its name as `subagent_type`.

## Choosing models — the palette

The calling agent should never deliberate over models, cost or your
preferences. `omp_agent`'s `model` parameter is therefore an enum of tier
names — the palette — drawn from both hosts' native vocabularies, each
mapped to a model **you** chose:

```json
{
  "tiers": {
    "haiku":          "deepseek/deepseek-flash",
    "sonnet":         "deepseek/deepseek-flash",
    "opus":           "zai/glm-5.3",
    "fable":          "zai/glm-5.3",
    "gpt-5.6-luna":   "deepseek/deepseek-flash",
    "gpt-5.6-terra":  "deepseek/deepseek-flash",
    "gpt-6-astra":    "zai/glm-5.3"
  },
  "default": "sonnet"
}
```

Claude Code's subagent habits (`model: "haiku" | "sonnet" | "opus" |
"fable"`) and Codex's spawn_agent habits (`gpt-5.6-luna`, `gpt-5.6-terra`,
`gpt-6-astra`, or omitted) all land on your models with zero decisions:
omitting `model` uses your `default` tier. Resolution order per dispatch: an
explicit `model` argument, then the agent definition's `model:`, then your
default tier.

Override the map in `~/.omp-dispatch/config.json`, or per project in
`<project>/.omp-dispatch/config.json`. Project settings win key by key, so
you can change one tier without restating the rest. Invent your own tier
names if you like — but names that exist only in a project config cannot
appear in the MCP enum (it is built at server start, before any workdir is
known); add shared names to the user-level config. To expose a raw model id
in the palette, map it to itself:
`"deepseek/deepseek-v4-pro": "deepseek/deepseek-v4-pro"`.

### Locking it down with `allow`

The enum constrains callers, but agent definitions pinning `model:` and the
CLI (`dispatch start --model <id>`) bypass it. An optional `allow` list
closes those paths — when set, no dispatch may resolve to anything else:

```json
{
  "allow": ["deepseek/deepseek-flash", "zai/glm-5.3"]
}
```

A violation fails before the run starts, naming the model, where it came
from (argument, definition, or default tier) and the allowed set. A project
`allow` replaces (never widens) the user-level one. Raw ids remain available
to the CLI and task files when unrestricted; `omp_models` still lists the
catalogue for you.

## Turning it on by default

Paste this into your `CLAUDE.md`:

```markdown
## Subagents

Prefer `mcp__omp-dispatch__omp_agent` over the native `Agent` tool when
delegating work. Use a native subagent only when the task needs a Claude Code
MCP server or skill that omp does not have.
```

## Caps

omp has **no turn cap and no budget cap** — only a time limit. This adds all
three, enforced outside the agent:

- `max_turns` — default 120
- `max_usd` — default 1.00
- `max_seconds` — default 1200

The turn cap is the primary one. Subscription-billed providers can report a
cost of zero, so nothing relies on the budget cap alone.

A cap firing is a result, not an error: the run returns its report with
`stopped_because` saying which one.

## Isolation

`isolation: "worktree"` gives a run its own git checkout. An unchanged worktree
is cleaned up afterwards; one the agent left work in is kept and its path
reported.

## Where run state lives, and how it is cleaned

Each run writes a directory — its prompt, a progress log, a `result.json`
and, when the run changed files, a `diff.patch`. **None of it goes in your
repository.** It lives under `~/.omp-dispatch/runs/<project>-<hash>/`,
grouped per project, the way omp keeps its own sessions under
`~/.omp/agent/sessions/`. Nothing to gitignore.

A run costs roughly 60KB. The server still prunes on startup, so it cannot
accumulate across months of use:

- anything older than **7 days**
- anything beyond the most recent **50 runs per project**

It says so on stderr when it removes something. Deleting the whole directory
by hand is safe at any time; nothing depends on it after a run has settled.

## Verifying a run

`files_changed` is computed from git, never from the agent's account of itself
— including edits to files that were already dirty when the run started. The
run directory holds the diff itself in `diff.patch`, and
`omp_task_output(..., include_diff: true)` returns it with the report, so a
review is one read instead of a `git diff` and its approval. Read the diff,
not the summary.

## When the MCP server is unavailable

`bun <plugin-root>/bin/server.ts --doctor` runs all the `omp_doctor` checks
with no working server required, and `--bootstrap` installs dependencies off
the host's MCP startup budget after an install or update.

The `dispatch` CLI is the degraded path — the same run directories, caps,
reports and diffs, no server needed:

```bash
bun <plugin-root>/bin/dispatch start --prompt-file brief.md --workdir /absolute/project
bun <plugin-root>/bin/dispatch output latest --workdir /absolute/project --diff
bun <plugin-root>/bin/dispatch usage --workdir /absolute/project
```

`start` runs in the foreground; `stop` settles a CLI-started run as aborted
by signalling its monitor. Steering and supervisor questions need the live
server. Don't drop to raw `omp` — that quietly loses the caps, the usage
accounting and the change report.

## What it does not do

A dispatched agent has **omp's** skills, rules, extensions and MCP servers.
Host-only capabilities and conversation history are not forwarded. A task
that needs a Claude Code or Codex capability unavailable in OMP should use a
native subagent. OMP runs do not inherit the host's sandbox or approval policy.

## Licence

MIT
