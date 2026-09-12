import { test, expect } from "bun:test";
import { keyExportsFrom } from "../src/env.ts";

// Ruling: the original fixture used `export NOT_A_KEY=nope` and asserted it
// was ignored — but NOT_A_KEY ends in `_KEY`, so it matches KEY_EXPORT by
// design (the `_KEY` suffix is deliberately broad, to catch credential vars
// nobody anticipated). EDITOR is genuinely unrelated and must stay ignored.
const RC = [
  `# a comment`,
  `export DEEPSEEK_API_KEY="sk-abc123"`,
  `  export ZAI_API_KEY='zk-def'`,
  `export PATH="/usr/bin:$PATH"`,
  `export SOME_TOKEN=tok-1`,
  `alias ll='ls -la'`,
  `export EDITOR=vim`,
].join("\n");

test("extracts only API key and token exports", () => {
  const k = keyExportsFrom(RC);
  expect(k.DEEPSEEK_API_KEY).toBe("sk-abc123");
  expect(k.ZAI_API_KEY).toBe("zk-def");
  expect(k.SOME_TOKEN).toBe("tok-1");
});

test("never picks up PATH or unrelated exports", () => {
  const k = keyExportsFrom(RC);
  expect(k.PATH).toBeUndefined();
  expect(k.EDITOR).toBeUndefined();
});

test("returns an empty object for an rc with no keys", () => {
  expect(keyExportsFrom("echo hello\n")).toEqual({});
});

test("strips both quote styles and leaves bare values alone", () => {
  const k = keyExportsFrom(`export A_API_KEY="q"\nexport B_API_KEY='s'\nexport C_TOKEN=bare`);
  expect([k.A_API_KEY, k.B_API_KEY, k.C_TOKEN]).toEqual(["q", "s", "bare"]);
});
