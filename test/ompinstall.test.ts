import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { locateOmp, rpcClientPath, checkOmpVersion, rpcCheck, loadRpcClient, OMP_RANGE } from "../src/ompinstall.ts";

// A bun-global-shaped omp install: bin/omp is a symlink into the package's
// dist/cli.js, the way `bun install -g` lays it out.
let fx: string;
let pkg: string;
beforeAll(() => {
  fx = mkdtempSync(join(tmpdir(), "omp-install-"));
  pkg = join(fx, "node_modules", "@oh-my-pi", "pi-coding-agent");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  mkdirSync(join(pkg, "src", "modes", "rpc"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({
    name: "@oh-my-pi/pi-coding-agent",
    version: "18.3.1",
    exports: { "./modes/rpc/*": { import: "./src/modes/rpc/*.ts" } },
  }));
  writeFileSync(join(pkg, "src", "modes", "rpc", "rpc-client.ts"), "export class RpcClient {}\n");
  writeFileSync(join(pkg, "dist", "cli.js"), "#!/usr/bin/env bun\n");
  mkdirSync(join(fx, "bin"));
  symlinkSync(join(pkg, "dist", "cli.js"), join(fx, "bin", "omp"));
  // A compiled single-file omp: nothing JS behind it.
  mkdirSync(join(fx, "standalone"));
  writeFileSync(join(fx, "standalone", "omp"), "\x7fELF");
});

test("locateOmp follows a symlinked bin to the package", () => {
  const i = locateOmp(() => [join(fx, "bin", "omp")])!;
  expect(i.bin).toBe(join(fx, "bin", "omp"));
  expect(i.packageRoot).toBe(realpathSync(pkg));
  expect(i.version).toBe("18.3.1");
});

test("locateOmp returns null package for a binary with no package above it", () => {
  const i = locateOmp(() => [join(fx, "standalone", "omp")])!;
  expect(i.packageRoot).toBeNull();
  expect(i.version).toBeNull();
});

test("locateOmp returns null when omp is not on PATH", () => {
  expect(locateOmp(() => [])).toBeNull();
});

test("rpcClientPath resolves inside the located installation", () => {
  const p = rpcClientPath(locateOmp(() => [join(fx, "bin", "omp")]));
  expect(p).toBe(join(realpathSync(pkg), "src", "modes", "rpc", "rpc-client.ts"));
});

test("checkOmpVersion fails below the supported range", () => {
  expect(checkOmpVersion("18.3.1", OMP_RANGE).ok).toBe(true);
  const low = checkOmpVersion("17.9.0", OMP_RANGE);
  expect(low.ok).toBe(false);
  expect(low.detail).toContain("17.9.0");
  expect(low.detail).toContain("^18.1.17");
  expect(checkOmpVersion(null, OMP_RANGE).ok).toBe(false);
});

test("rpcCheck passes for a JS install in range and names the RpcClient path", () => {
  const r = rpcCheck(locateOmp(() => [join(fx, "bin", "omp")]));
  expect(r.ok).toBe(true);
  expect(r.detail).toContain(join(realpathSync(pkg), "src", "modes", "rpc", "rpc-client.ts"));
});

test("rpcCheck fails a compiled omp with the reinstall command", () => {
  const r = rpcCheck({ bin: "/nowhere/omp", packageRoot: null, version: null });
  expect(r.ok).toBe(false);
  expect(r.detail).toContain("bun install -g @oh-my-pi/pi-coding-agent");
});

test("locateOmp prefers a JS install shadowed by a compiled omp earlier on PATH", () => {
  // Homebrew's compiled omp commonly sits ahead of ~/.bun/bin. The runner
  // spawns the returned bin and loads the RpcClient beside it, so both must
  // come from the JS install.
  const i = locateOmp(() => [join(fx, "standalone", "omp"), join(fx, "bin", "omp")])!;
  expect(i.bin).toBe(join(fx, "bin", "omp"));
  expect(i.packageRoot).toBe(realpathSync(pkg));
});

test("rpcClientPath does not fall back to a local package when omp is compiled", () => {
  // A leftover node_modules beside the plugin (0.4.x --bootstrap) would
  // otherwise hand a compiled omp an RpcClient of some other version.
  expect(() => rpcClientPath({ bin: join(fx, "standalone", "omp"), packageRoot: null, version: null }))
    .toThrow("not a JS install");
});

test("loadRpcClient refuses an omp outside the supported range", async () => {
  const old = join(fx, "old");
  const oldPkg = join(old, "node_modules", "@oh-my-pi", "pi-coding-agent");
  mkdirSync(join(oldPkg, "src", "modes", "rpc"), { recursive: true });
  mkdirSync(join(oldPkg, "dist"), { recursive: true });
  writeFileSync(join(oldPkg, "package.json"), JSON.stringify({
    name: "@oh-my-pi/pi-coding-agent", version: "17.0.0",
    exports: { "./modes/rpc/*": { import: "./src/modes/rpc/*.ts" } },
  }));
  writeFileSync(join(oldPkg, "src", "modes", "rpc", "rpc-client.ts"), "export class RpcClient {}\n");
  writeFileSync(join(oldPkg, "dist", "cli.js"), "");
  mkdirSync(join(old, "bin"));
  symlinkSync(join(oldPkg, "dist", "cli.js"), join(old, "bin", "omp"));
  await expect(loadRpcClient(locateOmp(() => [join(old, "bin", "omp")])))
    .rejects.toThrow("17.0.0 is outside ^18.1.17");
});
