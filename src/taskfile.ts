import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface TaskSpec {
  model: string;
  workdir: string;
  readonly: string[];
  tools: string;
  maxTurns: number;
  maxUsd: number;
  maxSeconds: number;
  role?: string;
  body: string;
}

export const TASK_DEFAULTS = {
  readonly: [] as string[],
  tools: "read,write,edit,bash",
  maxTurns: 120,
  maxUsd: 1.0,
  maxSeconds: 3300,
};

const KEY_MAP: Record<string, string> = {
  model: "model",
  workdir: "workdir",
  readonly: "readonly",
  tools: "tools",
  max_turns: "maxTurns",
  max_usd: "maxUsd",
  max_seconds: "maxSeconds",
  role: "role",
};

function splitFrontMatter(text: string, source: string): { head: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${source}: no front matter block (expected a --- block at the top)`);
  return { head: m[1]!, body: m[2]!.trim() };
}

function parseHead(head: string, source: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const raw of head.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line) continue;
    const i = line.indexOf(":");
    if (i < 0) throw new Error(`${source}: bad front-matter line: ${raw}`);
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (!(key in KEY_MAP)) throw new Error(`${source}: unknown front-matter key: ${key}`);
    out[KEY_MAP[key]!] =
      value.startsWith("[") && value.endsWith("]")
        ? value.slice(1, -1).split(",").map(s => s.trim()).filter(Boolean)
        : value;
  }
  return out;
}

export function parseTaskFile(
  text: string,
  opts: { taskPath: string; rolesDir: string },
): TaskSpec {
  const { head, body } = splitFrontMatter(text, opts.taskPath);
  let fields = parseHead(head, opts.taskPath);

  // A role supplies defaults underneath; the task file's own keys win.
  const roleName = fields.role;
  if (roleName !== undefined && typeof roleName !== "string") {
    throw new Error(`${opts.taskPath}: role must be a string`);
  }
  if (typeof roleName === "string") {
    const rolePath = join(opts.rolesDir, `${roleName}.md`);
    if (!existsSync(rolePath)) throw new Error(`${opts.taskPath}: unknown role: ${roleName} (${rolePath})`);
    const roleSource = `${opts.taskPath} (role '${roleName}' at ${rolePath})`;
    const roleHead = splitFrontMatter(readFileSync(rolePath, "utf8"), roleSource).head;
    fields = { ...parseHead(roleHead, roleSource), ...fields };
  }

  const str = (k: string) => (typeof fields[k] === "string" ? (fields[k] as string) : undefined);
  const num = (k: string, d: number) => {
    const v = str(k);
    if (v === undefined) return d;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${opts.taskPath}: ${k} must be a positive number`);
    return n;
  };

  const model = str("model");
  if (!model) throw new Error(`${opts.taskPath}: task file must set model`);
  const workdir = str("workdir");
  if (!workdir) throw new Error(`${opts.taskPath}: task file must set workdir`);
  if (!workdir.startsWith("/")) throw new Error(`${opts.taskPath}: workdir must be an absolute path`);
  if (!body) throw new Error(`${opts.taskPath}: task file must have a body (the prompt)`);

  return {
    model,
    workdir,
    readonly: Array.isArray(fields.readonly) ? [...fields.readonly] : [...TASK_DEFAULTS.readonly],
    tools: str("tools") ?? TASK_DEFAULTS.tools,
    maxTurns: num("maxTurns", TASK_DEFAULTS.maxTurns),
    maxUsd: num("maxUsd", TASK_DEFAULTS.maxUsd),
    maxSeconds: num("maxSeconds", TASK_DEFAULTS.maxSeconds),
    role: roleName,
    body,
  };
}
