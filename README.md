# omp-dispatch

Spawn subagents that run on [omp](https://github.com/oh-my-pi) — DeepSeek, GLM,
whatever you point it at — instead of on Claude. Same tool shape as the native
`Agent`, same `.claude/agents/*.md` files, a fraction of the token floor.

Measured startup cost for an empty task:

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

Two things native subagents cannot do:

- **`omp_steer`** interrupts the turn an agent is in the middle of.
- **`ask_supervisor`** lets a stuck agent ask *you* a question and wait.
  `omp_answer` resumes it.

## Install

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

## Choosing models

Dispatches resolve `model` in this order: an explicit argument, then the agent
definition's `model:`, then your default tier.

The shipped tiers:

```json
{
  "tiers": {
    "haiku":  "deepseek/deepseek-flash",
    "sonnet": "deepseek/deepseek-flash",
    "opus":   "zai/glm-5.3"
  },
  "default": "sonnet"
}
```

Override them in `~/.omp-dispatch/config.json`, or per project in
`<project>/.omp-dispatch/config.json`. Project settings win key by key, so you
can change one tier without restating the rest. Invent your own tier names if
you like.

You can also skip tiers entirely and pass a model id straight to `omp_agent`.
Run `omp_models` to see what is available and authenticated.

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

Each run writes a directory — its prompt, a progress log, the raw RPC frames
and a `result.json`. **None of it goes in your repository.** It lives under
`~/.omp-dispatch/runs/<project>-<hash>/`, grouped per project, the way omp
keeps its own sessions under `~/.omp/agent/sessions/`. Nothing to gitignore.

A run costs roughly 60KB. The server still prunes on startup, so it cannot
accumulate across months of use:

- anything older than **7 days**
- anything beyond the most recent **50 runs per project**

It says so on stderr when it removes something. Deleting the whole directory by
hand is safe at any time; nothing depends on it after a run has settled.

## Verifying a run

`files_changed` is computed from git, never from the agent's account of itself.
Read the diff, not the summary.

## What it does not do

A dispatched agent has **omp's** skills, rules, extensions and MCP servers — not
Claude Code's. That absence is the saving. A task that genuinely needs a Claude
Code MCP server should use a native subagent.

## Licence

MIT
