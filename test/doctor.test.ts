import { test, expect } from "bun:test";
import { runDiagnostics } from "../src/doctor.ts";

test("the doctor's summary counts every check it printed", async () => {
  const { text } = await runDiagnostics(process.cwd());
  const checks = text.split("\n").filter(l => /^  (OK|NOTE|FAIL) /.test(l)).length;
  expect(text).toMatch(new RegExp(`doctor: \\d+/${checks} checks passed`));
});

test("the doctor checks the same omp a dispatch spawns", async () => {
  // A compiled omp ahead of the JS install on PATH must not be the one the
  // doctor vouches for while the runner uses the other.
  const { locateOmp } = await import("../src/ompinstall.ts");
  const bin = locateOmp()?.bin;
  if (!bin) return;   // no omp on this machine: nothing to compare
  const { text } = await runDiagnostics(process.cwd());
  const line = text.split("\n").find(l => /^  (OK|FAIL) +omp /.test(l))!;
  expect(line).toContain(bin);
});
