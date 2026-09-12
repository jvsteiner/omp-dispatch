# omp-dispatch v2 — a drop-in replacement for native subagents

> Status: draft for review
> Date: 2026-09-12
> Supersedes: `2026-09-12-omp-dispatch-design.md` (v1)
> Verified against: omp v18.1.17, bun 1.4.0, on this machine

## 1. What changed, and why

v1 was designed for the use case its source brief described: batching document
ingest for `~/wiki`. The mechanism it produced is general — `src/` contains no
reference to wiki, ingest, `raw/` or `schema`, and path locking defaults to off
— but its **centre of gravity was wrong**.

The actual goal is this: **replace native Claude Code subagents for development
work.** Instead of Claude spawning a Sonnet or Haiku subagent at a 53,272-token
floor, it spawns an omp subagent at 10,322 running DeepSeek or GLM.

Three consequences follow, and the first is the big one.

### 1.1 Packaging was wrong

v1 chose a skill plus shell scripts. That was the right call for occasional bulk
dispatch and the wrong one for a default subagent mechanism.

The argument against an MCP server was that tool definitions cost tokens in every
session. True — a few hundred. Each dispatch saves forty-three thousand. The
trade is not close.

**The packaging choice is also what made v1 hard.** With shell scripts every
`dispatch` call is a fresh process, so the design needed a detached broker, a
unix socket, a pidfile, liveness checks, process-group teardown and signal
handling. None of that is about talking to omp. All of it exists so separate
`bash` invocations can reach something that outlives them.

An MCP server is already long-lived. It holds the `RpcClient` in memory. The
socket, the daemon, the pidfile and the process-group work all disappear — and
that is precisely the machinery that consumed four fix rounds on v1's Task 5.

### 1.2 Isolation was the wrong primitive

v1 made `chmod -R a-w` path locking a headline feature and deferred git worktrees
to "later". For document ingest that is correct. For coding subagents it is
backwards: a coding agent's job is writing source. **Worktree isolation is the
primitive; path locking is a niche guard.**

### 1.3 Agent definitions were an afterthought

v1 filed roles as a minor convenience in its second-to-last task, and shipped one
role called `ingest`. For a subagent replacement, agent definitions are the
product.

## 2. Goal

A Claude Code session can do subagent-driven development where every subagent
runs on omp instead of on Claude, **without rewriting anything** — the same
`.claude/agents/*.md` files, the same dispatch-review-fix loop, the same mental
model. Turning it on should be a preference, not a migration.

## 3. Packaging

A Claude Code plugin that ships **one MCP server**.

```
~/Code/omp-dispatch/
  .claude-plugin/plugin.json        declares the MCP server
  .claude-plugin/marketplace.json
  src/mcp/server.ts                 the MCP server — long-lived, holds runs
  src/agentdef.ts                   reads and translates .claude/agents/*.md
  src/models.ts                     model-tier mapping and the env/key guard
  src/worktree.ts                   isolation
  src/runner.ts                     RpcClient lifecycle, events, caps  (was broker.ts)
  src/caps.ts        unchanged from v1
  src/rundir.ts      unchanged from v1
  src/preflight.ts   provider guard kept; path locking demoted to optional
  src/taskfile.ts    kept for file-driven dispatch; no longer the main path
  skills/omp-subagents/SKILL.md
  agents/                           shipped agent definitions
```

The MCP server holds `Map<name, RunHandle>`. Each handle owns one `RpcClient`
and its cap state. Run state is still mirrored to disk under
`<workdir>/.omp-dispatch/runs/<run_id>/` so a run is inspectable and resumable
after the session ends.

## 4. The tool surface

Deliberately shaped to mirror the native tools one-for-one.

| Native | omp-dispatch MCP tool | Notes |
|---|---|---|
| `Agent(description, prompt, subagent_type, model, name)` | `omp_agent(...)` same arguments | returns the agent's final report |
| `SendMessage(to, message)` | `omp_send_message(to, message)` | continues a named agent, context intact |
| `ListAgents()` | `omp_list_agents()` | |
| `TaskOutput(id)` | `omp_task_output(name)` | progress so far |
| `TaskStop(id)` | `omp_task_stop(name)` | |
| — | `omp_steer(to, message)` | **interrupts a running turn.** Native cannot. |
| — | `omp_answer(name, text)` | answers an `ask_supervisor` question. Native cannot. |
| — | `omp_models(filter?)` | lists the catalogue, so model choice is informed rather than guessed |

`omp_agent` blocks and returns the report, matching `run_in_background: false`,
which is the common case. Parallel fan-out works the way it does natively: issue
several `omp_agent` calls in one message.

## 5. Agent definitions — the drop-in core

**omp-dispatch reads the same `.claude/agents/*.md` files native subagents use.**
Project `./.claude/agents/` first, then user `~/.claude/agents/`. This is what
makes it drop-in; nothing gets ported.

The two formats are the same shape with different vocabularies. Verified:

```yaml
# Claude Code — ~/.claude/agents/a2a-answer-t4.md
name: a2a-answer-t4
description: ...
tools: Read, Grep, Glob                    # comma list, capitalised
disallowedTools: Bash, Edit, Write, ...
maxTurns: 12
```

```yaml
# omp — ./.omp/agents/reviewer.md
name: reviewer
tools:                                     # YAML list, lowercase
  - read
  - grep
```

So the translation is mechanical:

| Claude field | Becomes |
|---|---|
| `tools:` | omp `--tools=` after name translation |
| `disallowedTools:` | subtracted from the allowlist |
| `maxTurns:` | the turn cap — **omp has no turn cap, we enforce it** |
| `model:` | resolved through the tier map (§6) |
| body | `--append-system-prompt` |

### Tool name translation

| Claude | omp |
|---|---|
| `Read` | `read` |
| `Write` | `write` |
| `Edit` | `edit` |
| `Bash` | `bash` |
| `Grep` | `grep` |
| `Glob` | `glob` |
| `WebSearch` | `web_search` |
| `WebFetch` | `read` — omp's `read` takes URLs |
| `NotebookEdit` | `notebook` |
| `Agent` | `task` — omp's own subagents |
| `TodoWrite` | `todo` |

Unmappable — `Skill`, `ToolSearch`, `SendMessage`, and every MCP tool — are
dropped, and **the dispatch result says which were dropped**. Silently losing a
tool an agent definition asked for is the failure mode that would make this
untrustworthy.

omp-only tools an agent definition may opt into by name: `lsp`, `python`,
`browser`, `ast_grep`, `hub`.

## 6. Models, and the environment trap

### Model choice is the user's, at every level

**This is a first-class requirement, not a config afterthought.** The point of
the tool is that the model is a dial you turn based on what actually works. Any
omp model must be reachable, and every default must be changeable without
touching code.

Resolution order, highest precedence first:

1. **An explicit `model` argument to `omp_agent`.** Used verbatim. Any model in
   omp's catalogue — `deepseek/deepseek-v4-pro`, `zai/glm-4.7`, an ollama model,
   anything.

   **The tool's own description must say this.** If the schema only mentions
   tiers, the caller never learns it may pass a real model id, and the most
   direct form of control in the design becomes invisible. The `model` parameter
   is documented as: *a tier name from your config, or any omp model id —
   run `omp_models` to see what is available.*
2. **`model:` in the agent definition.** If it names a tier (`haiku`, `sonnet`,
   `opus`) it resolves through the map below. If it names anything else it is
   treated as an omp model id and used verbatim. So an agent definition can pin
   a specific model, and a definition written for native Claude still works.
3. **The configured default tier.**

Whatever is resolved goes through the provider guard (§6.2) before a run starts.

### The tier map — defaults, not rules

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

`deepseek-flash` is deliberate: per DeepSeek's current API documentation it is an
**alias that tracks their latest flash model**, so this default improves on its
own rather than pinning to a version that ages. Pin a versioned id
(`deepseek-v4-flash`) instead when reproducibility matters more than currency.

Read from `~/.omp-dispatch/config.json`, overridden per project by
`./.omp-dispatch/config.json`. Missing file means the defaults above. Tier names
beyond the three are allowed — add `cheap`, `thinking`, whatever suits — and an
agent definition may name any of them.

An `omp_models()` MCP tool lists the catalogue so Claude (and the user) can see
what is actually available and authenticated, rather than guessing. It is also
the fastest way to notice the key trap below.

Verified present on this machine: `deepseek` has `deepseek-flash`,
`deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`, `deepseek-v4-pro`; `zai` has
sixteen GLM models including `glm-5.3` and `glm-5.3-flash`.

### The environment trap — this is load-bearing

**API keys live in `~/.zshrc`, which only sources for interactive shells.**

Run `omp models` from a non-interactive shell and it lists **7** providers.
Source the key exports first and it lists **13**, including `deepseek`. The
provider you asked for simply is not there without its key.

This is not hypothetical. It happened twice:

- `~/wiki/scripts/ingest.sh` carries a comment about it and works around it,
  because a launchd job gets no interactive shell.
- **This design session hit it.** I ran `omp models` from a key-less shell,
  saw no `deepseek` provider, and concluded it did not exist. It does.

The MCP server is launched by Claude Code, not by a login shell. So it **must**
pull the key exports the way `ingest.sh` does — grep `~/.zshrc` for
`export *_API_KEY` / `*_TOKEN` lines and eval only those, never the whole
profile.

The provider guard from v1 stays and becomes more valuable, not less: in a
key-less environment it throws rather than letting omp fuzzy-match the model to
another provider's copy. That is the correct failure, and it is exactly the
incident the source brief describes.

### Caps and subscription providers

`zai` is authenticated by OAuth on a `pro` plan with a **credit** quota, not
per-token billing. `getSessionStats().cost` may therefore read zero, in which
case `max_usd` can never fire.

So: **the turn cap is the primary cap.** The budget cap is a second line of
defence that works for per-token providers and is documented as inert for
subscription ones. A run must never depend on `max_usd` alone.

## 7. Isolation

`isolation` mirrors the native option.

| Value | Behaviour |
|---|---|
| `none` (default) | runs in the current working tree, like a native subagent |
| `worktree` | `omp worktree add` a fresh checkout, run there, remove it after if unchanged |

Worktree isolation is nearly free — the runner already starts omp in whatever
directory it is given, so this is a create, a path swap and a cleanup.

Path locking survives as an optional `readonly` list for the ingest-shaped case
that motivated v1. It is no longer the headline.

## 8. What survives from v1

Tasks 1 through 5 are built, reviewed and committed on
`build/omp-dispatch-m1-m4`. 66 tests pass.

| v1 component | Fate |
|---|---|
| `caps.ts` — turn and budget caps | **kept whole.** More important here: a runaway coding agent is exactly what it is for. |
| `rundir.ts` — run state, `result.json` | **kept whole** |
| `preflight.ts` — provider guard | **kept whole.** Path locking demoted to optional. |
| `taskfile.ts` — parsing, role merge | **kept.** Becomes the file-driven path, not the main one. |
| `broker.ts` — RpcClient lifecycle, event streaming, cap enforcement, teardown | **~80% kept** as `runner.ts` |
| the unix socket layer (v1 Task 6) | **dropped, never built** |
| detached process, pidfile, process groups, signal handling | **mostly dropped** — the MCP server is the long-lived process |

The four fix rounds spent on v1's Task 5 were not wasted: the caps, the
teardown discipline, the double-counted-turn guard and the stats-failure
escalation all carry over. What drops away is the detached-process machinery,
which was an artefact of the packaging choice.

**One live finding carries forward:** v1's round 4 was fixing a case where
Ctrl-C left the agent and its descendants running with paths still locked.
Under an MCP server the supervising process is long-lived and owns its children
directly, which removes the delivery problem — but the runner must still kill
omp's whole process tree on teardown, because omp's `bash` tool calls are
descendants. Do not lose that requirement in the move.

## 9. Turning it on

Two mechanisms, both shipped:

1. **`skills/omp-subagents/SKILL.md`** — tells Claude when to prefer
   `omp_agent` over `Agent`, how tiers map, and what is lost.
2. **A CLAUDE.md snippet in the README** the user can paste to make it the
   default: prefer `omp_agent` for delegated work unless the subagent needs
   Claude's MCP servers or skills.

## 10. Honest gaps

Three things this cannot do, stated plainly so the skill can route around them.

1. **No MCP servers, no skills, no Claude-native tools inside a dispatched
   agent.** That absence *is* the 43,000-token saving. A task that needs them
   must use a native subagent. This is the one real dividing line.
2. **No background dispatch with automatic notification.** An MCP server cannot
   push a wake-up to Claude. `omp_agent` blocks; a long run is polled with
   `omp_task_output`. Native `run_in_background` remains better for hours-long
   work.
3. **Model behaviour differs.** A DeepSeek or GLM subagent is not a Sonnet
   subagent. Agent definitions written against Claude's instruction-following
   may need their prompts tightened. The `maxTurns` cap matters more, not less.

## 11. Milestones

| | Ships | Done when |
|---|---|---|
| N1 | MCP server, `omp_agent`, `runner.ts` from `broker.ts`, caps, key sourcing, provider guard | one blocking dispatch returns a real report |
| N2 | `.claude/agents/*.md` reading, tool translation, dropped-tool reporting, tier map | an existing agent definition runs unmodified on omp |
| N3 | `omp_send_message`, `omp_steer`, `omp_list_agents`, `omp_task_output`, `omp_task_stop` | a two-turn conversation and an interrupt both work |
| N4 | `ask_supervisor` + `omp_answer`, worktree isolation | an agent parks a question and Claude answers it |
| N5 | skill, shipped agent definitions, README, CLAUDE.md snippet, paid smoke test | Claude picks omp over a native subagent unprompted |

## 12. Decisions taken

All three open questions are settled.

1. **Tier map.** `opus` → `zai/glm-5.3`; `sonnet` and `haiku` both →
   `deepseek/deepseek-flash`. The two cheap tiers collapsing onto one model is
   intentional — `deepseek-flash` is an alias tracking DeepSeek's latest flash
   model, so it stays current on its own. **Every one of these is a default the
   user changes in config, and any omp model can be named directly at dispatch
   time or pinned in an agent definition** (§6). Flexibility here is the point
   of the tool, not a nicety.

2. **An untranslatable tool is a refusal, not a silent downgrade.** If an agent
   definition asks for a `Skill`, an MCP tool, or anything else omp cannot
   provide, `omp_agent` **refuses and names what was missing**. It does not run
   a weakened agent and it does not silently fall back to a native subagent. An
   agent quietly missing the tool it was written around produces confident
   wrong work, which is worse than an error the caller can act on.

3. **`taskfile.ts` stays.** It is built and tested, and the file-driven path is
   genuinely better for long unattended batches — the wiki ingest that started
   all this is exactly that shape. It is not the main path any more, and it
   costs nothing to keep.
