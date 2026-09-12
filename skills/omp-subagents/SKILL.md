---
name: omp-subagents
description: Use when delegating work to a subagent - dispatches it to omp running DeepSeek or GLM instead of a native Claude subagent, at roughly a fifth of the token floor, reading the same .claude/agents definitions. Also covers continuing, steering, or answering a question from a dispatched agent.
---

# Dispatching subagents to omp

`omp_agent` is a drop-in replacement for the native `Agent` tool. Same
arguments, same `.claude/agents/*.md` files, a fraction of the cost.

```
Agent({ description, prompt, subagent_type: "reviewer", model: "sonnet" })
mcp__omp-dispatch__omp_agent({ description, prompt, subagent_type: "reviewer", model: "sonnet" })
```

`model: "sonnet"` resolves through a tier map to an omp model. You can also
pass any omp model id directly — `deepseek/deepseek-v4-pro`, `zai/glm-5.3` —
and `omp_models` lists what is actually available.

## Decide first: omp or native?

**Use a native subagent when** the task needs a Claude Code MCP server or skill
that you have not also given omp. That is the only real dividing line, and it
is a narrow one — a dispatched agent has omp's own skills, rules, extensions
and MCP servers, just not the host's.

**Use omp for everything else.** It is not only for bulk work. Implementers,
reviewers, explorers, one-off questions — all of it.

If you are unsure, dispatch to omp. A refusal is cheap and explicit: an agent
definition asking for a tool omp cannot provide fails immediately, naming the
tool, rather than running weakened.

## The tools

| | |
|---|---|
| `omp_agent` | dispatch a subagent, get its report — like `Agent` |
| `omp_send_message` | continue a run, keeping its context — like `SendMessage` |
| `omp_list_agents` | what has run, and what is running now |
| `omp_task_output` | what a run is doing, without interrupting it |
| `omp_task_stop` | stop a run |
| `omp_steer` | **interrupt the turn in flight** — native cannot do this |
| `omp_answer` | answer a question a run asked you — native cannot do this |
| `omp_models` | what models are available |

## Two things native subagents cannot do

**Steering.** If an agent is visibly going the wrong way, `omp_steer` interrupts
the turn it is in the middle of. You do not have to wait for it to finish being
wrong.

**Being asked.** A dispatched agent that is stuck calls `ask_supervisor` and
parks. `omp_list_agents` shows it as `asking`, `omp_task_output` shows the
question, and `omp_answer` resumes it. Use this instead of letting an agent
guess — a guess costs a whole run.

An unanswered question still burns the run's clock. Answer it or stop it.

## Isolation

`isolation: "worktree"` gives the run its own git checkout, so it can write
freely without touching your working tree. An unchanged worktree is cleaned up;
one the agent left work in is kept and its path reported.

Default is `none`, matching native.

## Reading the result

Every dispatch returns the agent's report plus a footer:

```
[omp:reviewer-1] model=deepseek/deepseek-flash turns=14 tool_calls=31
cost_usd=0.0412 seconds=88 stopped_because=completed
```

`stopped_because` is the field that matters. `completed` means it finished.
`max_turns`, `max_usd` or `max_seconds` mean a cap fired — the work is partial
and the footer is telling you so, not erroring.

Caps exist because omp has none of its own. A confused agent will otherwise run
until the clock stops it.

## Verifying the work

Read the diff, not the agent's summary of the diff. `files_changed` in the run
directory comes from git, never from the agent's own account of itself.

A cheap model will tell you confidently that it did something. Check.
