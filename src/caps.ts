import type { StoppedBecause } from "./rundir.ts";

export interface CapState { turns: number; costUsd: number; startedAt: number; }
export interface Caps { maxTurns: number; maxUsd: number; maxSeconds: number; }

export const newCapState = (now = Date.now()): CapState =>
  ({ turns: 0, costUsd: 0, startedAt: now });

/**
 * omp emits agent_end with isTerminal:false when maintenance or async delivery
 * has scheduled more work — the session will resume. That is not a completed
 * turn. The field is optional, so an absent one is terminal.
 */
export function countTurn(s: CapState, frame: { isTerminal?: boolean }): boolean {
  if (frame.isTerminal === false) return false;
  s.turns += 1;
  return true;
}

export function breach(s: CapState, c: Caps, now = Date.now()): StoppedBecause | null {
  if (s.costUsd >= c.maxUsd) return "max_usd";
  if (s.turns >= c.maxTurns) return "max_turns";
  if ((now - s.startedAt) / 1000 >= c.maxSeconds) return "max_seconds";
  return null;
}
