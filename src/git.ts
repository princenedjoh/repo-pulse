import { execFile, spawn } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

export interface RepoInfo {
  name: string;
  path: string;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  changed: number;
  untracked: number;
  conflicts: number;
  stashes: number;
  lastCommit: string;
  lastCommitTs: number;
  remoteUrl: string | null;
  stack: string[];
  /** Set when git couldn't read the repo at all. */
  error?: string;
}

export interface RepoDetail {
  commits: { hash: string; when: string; subject: string }[];
  files: { status: string; path: string }[];
}

export interface GitResult {
  ok: boolean;
  out: string;
}

export function git(cwd: string, args: string[], timeout = 20000): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      // never block on a credential prompt while the TUI owns the terminal
      { cwd, timeout, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (err, stdout, stderr) => {
        resolve({ ok: !err, out: (err ? stderr || err.message : stdout).toString().trimEnd() });
      },
    );
  });
}

export function parseStatus(text: string) {
  let branch = "?";
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let changed = 0;
  let untracked = 0;
  let conflicts = 0;
  let stashes = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("# branch.head ")) branch = line.slice(14).trim();
    else if (line.startsWith("# branch.upstream ")) upstream = line.slice(18).trim();
    else if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    } else if (line.startsWith("# stash ")) stashes = Number(line.slice(8)) || 0;
    else if (line.startsWith("1 ") || line.startsWith("2 ")) changed++;
    else if (line.startsWith("u ")) {
      changed++;
      conflicts++;
    } else if (line.startsWith("? ")) untracked++;
  }
  return { branch, upstream, ahead, behind, changed, untracked, conflicts, stashes };
}

const STACK_KEYS: [string, string][] = [
  ["next", "next"],
  ["expo", "expo"],
  ["react-native", "rn"],
  ["@nestjs/core", "nest"],
  ["express", "express"],
  ["fastify", "fastify"],
  ["vite", "vite"],
  ["react", "react"],
];

export function detectStack(pkgJson: string): string[] {
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(pkgJson);
  } catch {
    return [];
  }
  const deps = { ...pkg.devDependencies, ...pkg.dependencies };
  const found: string[] = [];
  for (const [dep, label] of STACK_KEYS) {
    const v = deps[dep];
    if (!v) continue;
    const m = /(\d+)(?:\.(\d+))?/.exec(v);
    found.push(m ? `${label} ${m[1]}${dep === "react-native" && m[2] ? "." + m[2] : ""}` : label);
  }
  // react is implied by next/expo/rn/vite; only show it for plain React apps
  return found.length > 1 && found[found.length - 1].startsWith("react ") ? found.slice(0, -1) : found;
}

/** Detect non-JS stacks from marker files when there's no package.json. */
function detectOtherStack(path: string): string[] {
  const markers: [string, string][] = [
    ["go.mod", "go"],
    ["Cargo.toml", "rust"],
    ["pyproject.toml", "python"],
    ["requirements.txt", "python"],
    ["Package.swift", "swift"],
    ["pubspec.yaml", "flutter"],
    ["Gemfile", "ruby"],
    ["composer.json", "php"],
  ];
  const found = markers.filter(([f]) => existsSync(join(path, f))).map(([, l]) => l);
  if (found.length === 0 && readdirSafe(path).some((f) => f.endsWith(".xcodeproj"))) found.push("swift");
  return [...new Set(found)];
}

function readdirSafe(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

export async function inspectRepo(path: string): Promise<RepoInfo> {
  const [status, log, remote] = await Promise.all([
    git(path, ["status", "--porcelain=v2", "--branch", "--show-stash"]),
    git(path, ["log", "-1", "--format=%ct%x09%cr%x09%s"]),
    git(path, ["remote", "get-url", "origin"]),
  ]);
  const s = parseStatus(status.ok ? status.out : "");
  const [ts = "0", rel = "", ...subject] = log.ok ? log.out.split("\t") : [];
  const pkgPath = join(path, "package.json");
  const stack = existsSync(pkgPath) ? detectStack(readFileSync(pkgPath, "utf8")) : detectOtherStack(path);
  return {
    name: basename(path),
    path,
    ...s,
    lastCommit: log.ok && log.out ? `${rel} · ${subject.join("\t")}` : "no commits yet",
    lastCommitTs: Number(ts) || 0,
    remoteUrl: remote.ok && remote.out ? remote.out : null,
    stack,
    ...(status.ok ? {} : { error: status.out.split("\n")[0] || "git status failed" }),
  };
}

export async function inspectDetail(path: string): Promise<RepoDetail> {
  const [log, status] = await Promise.all([
    git(path, ["log", "-n", "5", "--format=%h%x09%cr%x09%s"]),
    git(path, ["status", "--short", "--untracked-files=normal"]),
  ]);
  return {
    commits: log.ok && log.out
      ? log.out.split("\n").map((l) => {
          const [hash, when, ...subject] = l.split("\t");
          return { hash, when, subject: subject.join("\t") };
        })
      : [],
    files: status.ok && status.out
      ? status.out.split("\n").map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3) }))
      : [],
  };
}

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "Pods", "vendor", ".venv", "target"]);

/**
 * Find git repos under `root`. Depth 1 checks root's direct children; larger
 * values look further down. A repo's own subfolders aren't searched.
 */
export function findRepos(root: string, depth = 1): string[] {
  const repos: string[] = [];
  if (existsSync(join(root, ".git"))) return [root];
  const walk = (dir: string, level: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP.has(e.name) || e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (existsSync(join(p, ".git"))) repos.push(p);
      else if (level < depth) walk(p, level + 1);
    }
  };
  walk(root, 1);
  return repos.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/** Run `fn` over items with at most `limit` in flight. */
export async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  onProgress?: (done: number) => void,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let done = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
      onProgress?.(++done);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Turn a git remote into a browsable https URL. */
export function webUrl(remote: string | null): string | null {
  if (!remote) return null;
  let m = /^git@([^:]+):(.+?)(?:\.git)?\/?$/.exec(remote);
  if (m) return `https://${m[1]}/${m[2]}`;
  m = /^ssh:\/\/(?:[^@]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(remote);
  if (m) return `https://${m[1]}/${m[2]}`;
  m = /^https?:\/\/(?:[^@/]+@)?(.+?)(?:\.git)?\/?$/.exec(remote);
  if (m) return `https://${m[1]}`;
  return null;
}

/** Short age like 3d, 2w, 8mo, 1y. */
export function shortAge(ts: number, now = Date.now() / 1000): string {
  if (!ts) return "—";
  const s = Math.max(0, now - ts);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 14) return `${Math.round(s / 86400)}d`;
  if (s < 86400 * 60) return `${Math.round(s / 604800)}w`;
  if (s < 86400 * 365) return `${Math.round(s / 2592000)}mo`;
  return `${Math.round(s / 31536000)}y`;
}

export function isDirty(r: RepoInfo) {
  return r.changed + r.untracked > 0;
}

/** Commits that exist only on this machine. */
export function hasUnpushed(r: RepoInfo) {
  return r.ahead > 0 || (r.upstream === null && r.lastCommitTs > 0 && r.branch !== "(detached)");
}

/** Launch a GUI program without tying it to the terminal. */
export function launch(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", shell: process.platform === "win32" });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

export function openUrl(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  return launch(cmd, process.platform === "win32" ? ['""', url] : [url]);
}
