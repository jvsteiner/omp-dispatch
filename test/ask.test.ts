import { test, expect } from "bun:test";
import { createAskSupervisor } from "../src/asktool.ts";

const ctx = () => ({ signal: new AbortController().signal });

test("the tool exposes the expected name and schema", () => {
  const t = createAskSupervisor(() => {}).tool as any;
  expect(t.name).toBe("ask_supervisor");
  expect(t.parameters.properties.question).toBeDefined();
  expect(t.parameters.required).toContain("question");
});

test("execute parks until answered, then returns the answer verbatim", async () => {
  let seen: any = null;
  const h = createAskSupervisor(a => { seen = a; });
  const t = h.tool as any;

  let settledWith: string | undefined;
  const pending = t.execute({ question: "which page wins?" }, ctx())
    .then((s: string) => { settledWith = s; });

  await Bun.sleep(10);
  // Parked: the promise must NOT have settled just because it was called.
  expect(settledWith).toBeUndefined();
  expect(seen.question).toBe("which page wins?");
  expect(h.pending()!.ask_id).toBe(seen.ask_id);

  expect(h.answer(seen.ask_id, "the older one")).toBe(true);
  await pending;
  expect(settledWith).toBe("the older one");
  expect(h.pending()).toBeNull();
});

test("context is carried through when given", async () => {
  let seen: any = null;
  const h = createAskSupervisor(a => { seen = a; });
  void (h.tool as any).execute({ question: "q", context: "tried X" }, ctx());
  await Bun.sleep(10);
  expect(seen.context).toBe("tried X");
});

test("answering an unknown ask id returns false and changes nothing", () => {
  const h = createAskSupervisor(() => {});
  expect(h.answer("nope", "x")).toBe(false);
  expect(h.pending()).toBeNull();
});

test("an aborted tool call rejects rather than hanging", async () => {
  const h = createAskSupervisor(() => {});
  const ac = new AbortController();
  const pending = (h.tool as any).execute({ question: "q" }, { signal: ac.signal });
  await Bun.sleep(10);
  ac.abort();
  await expect(pending).rejects.toThrow(/aborted/);
  expect(h.pending()).toBeNull();
});

test("cancelAll rejects everything parked, naming the reason", async () => {
  const h = createAskSupervisor(() => {});
  const pending = (h.tool as any).execute({ question: "q" }, ctx());
  await Bun.sleep(10);
  h.cancelAll("the run was torn down");
  await expect(pending).rejects.toThrow(/torn down/);
  expect(h.pending()).toBeNull();
});

test("two asks are tracked independently", async () => {
  const ids: string[] = [];
  const h = createAskSupervisor(a => ids.push(a.ask_id));
  const first = (h.tool as any).execute({ question: "one" }, ctx());
  const second = (h.tool as any).execute({ question: "two" }, ctx());
  await Bun.sleep(10);
  expect(new Set(ids).size).toBe(2);
  h.answer(ids[1]!, "B");
  expect(await second).toBe("B");
  h.answer(ids[0]!, "A");
  expect(await first).toBe("A");
});
