import { test, expect } from "bun:test";
import { newCapState, countTurn, breach } from "../src/caps.ts";

const CAPS = { maxTurns: 3, maxUsd: 1.0, maxSeconds: 100 };

test("a terminal agent_end counts as a turn", () => {
  const s = newCapState(0);
  expect(countTurn(s, { isTerminal: true })).toBe(true);
  expect(s.turns).toBe(1);
});

test("an agent_end with isTerminal absent counts (older runtimes)", () => {
  const s = newCapState(0);
  expect(countTurn(s, {})).toBe(true);
  expect(s.turns).toBe(1);
});

test("isTerminal:false does NOT count - maintenance scheduled more work", () => {
  const s = newCapState(0);
  expect(countTurn(s, { isTerminal: false })).toBe(false);
  expect(s.turns).toBe(0);
});

test("no breach inside every cap", () => {
  const s = newCapState(0); s.turns = 2; s.costUsd = 0.5;
  expect(breach(s, CAPS, 50_000)).toBeNull();
});

test("turn cap breaches at the limit", () => {
  const s = newCapState(0); s.turns = 3;
  expect(breach(s, CAPS, 0)).toBe("max_turns");
});

test("budget cap breaches at the limit", () => {
  const s = newCapState(0); s.costUsd = 1.0;
  expect(breach(s, CAPS, 0)).toBe("max_usd");
});

test("time cap breaches after the limit", () => {
  const s = newCapState(0);
  expect(breach(s, CAPS, 100_001)).toBe("max_seconds");
});

test("budget is reported before turns when both breach", () => {
  const s = newCapState(0); s.turns = 9; s.costUsd = 9;
  expect(breach(s, CAPS, 0)).toBe("max_usd");   // money is the one that hurts
});
