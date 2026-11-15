import React from "react";
import { render } from "ink";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { App, defaultApi, filterRepos, sortRepos, type Sort } from "./App.js";
import { findRepos, git, hasUnpushed, inspectRepo, isDirty, pool, shortAge, type RepoInfo } from "./git.js";

declare const __VERSION__: string;
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "dev";

const HELP = `repo-pulse - a dashboard for a folder of git repos

Usage
  repo-pulse [dir] [options]

Options
  -d, --depth <n>      how many folder levels to search (default 1)
      --editor <cmd>   command for "open" (default $REPO_PULSE_EDITOR, $VISUAL, or code)
      --sort <by>      name | dirty | recent | behind
      --json           print status as JSON and exit
      --plain          print a table and exit (default when not a TTY)
      --dirty          only repos with uncommitted changes
      --unpushed       only repos with commits that aren't on a remote
      --behind         only repos behind their upstream
      --check          exit 1 if any repo is dirty or unpushed (for scripts)
      --fetch          git fetch every repo before reporting
  -v, --version
  -h, --help

Keys
  ↑↓ jk move   PgUp/PgDn page   g/G top/bottom   ⏎ details   / filter
  s sort   f fetch all   p pull   P pull all   o open in editor
  b open remote in browser   r refresh   q quit

Filter shortcuts: /:dirty  /:unpushed  /:behind`;

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      depth: { type: "string", short: "d", default: "1" },
      editor: { type: "string" },
      sort: { type: "string", default: "name" },
      json: { type: "boolean" },
      plain: { type: "boolean" },
      dirty: { type: "boolean" },
      unpushed: { type: "boolean" },
      behind: { type: "boolean" },
      check: { type: "boolean" },
      fetch: { type: "boolean" },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  });
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}
const { values, positionals } = parsed;

if (values.version) {
  console.log(VERSION);
  process.exit(0);
}
if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const depth = Number(values.depth);
if (!Number.isInteger(depth) || depth < 1) {
  console.error("--depth must be a positive integer");
  process.exit(2);
}
const sort = values.sort as Sort;
if (!["name", "dirty", "recent", "behind"].includes(sort)) {
  console.error("--sort must be one of: name, dirty, recent, behind");
  process.exit(2);
}

const root = resolve(positionals[0] ?? ".");
const editor = values.editor ?? process.env.REPO_PULSE_EDITOR ?? process.env.VISUAL ?? "code";
const scripted = values.json || values.plain || values.check || values.dirty || values.unpushed || values.behind || values.fetch;

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const [red, green, yellow, cyan, dim] = [31, 32, 33, 36, 2].map(paint);

function applyFilters(repos: RepoInfo[]) {
  let out = repos;
  if (values.dirty) out = filterRepos(out, ":dirty");
  if (values.unpushed) out = filterRepos(out, ":unpushed");
  if (values.behind) out = filterRepos(out, ":behind");
  return sortRepos(out, sort);
}

if (scripted || !process.stdout.isTTY || !process.stdin.isTTY) {
  const paths = findRepos(root, depth);
  if (values.fetch) {
    await pool(paths, 6, (p) => git(p, ["fetch", "--prune", "--quiet"], 60000));
  }
  const all = await pool(paths, 8, inspectRepo);
  const repos = applyFilters(all);
  if (values.json) {
    console.log(JSON.stringify(repos, null, 2));
  } else {
    const w = Math.min(32, Math.max(10, ...repos.map((r) => r.name.length + 2)));
    for (const r of repos) {
      const dirty = r.changed + r.untracked;
      const state = r.error ? red("error") : dirty ? yellow(`●${dirty}`.padEnd(6)) : green("✓".padEnd(6));
      const sync = [r.ahead ? cyan(`↑${r.ahead}`) : "", r.behind ? red(`↓${r.behind}`) : "", hasUnpushed(r) && !r.upstream ? dim("no remote") : ""]
        .filter(Boolean)
        .join(" ");
      console.log(`${r.name.padEnd(w)} ${r.branch.slice(0, 20).padEnd(21)} ${state} ${shortAge(r.lastCommitTs).padEnd(4)} ${sync}`);
    }
    if (repos.length === 0) console.log(dim("no matching repos"));
  }
  if (values.check) {
    const problems = all.filter((r) => isDirty(r) || hasUnpushed(r));
    if (problems.length) {
      if (!values.json) console.error(red(`\n${problems.length} repo(s) have uncommitted or unpushed work`));
      process.exit(1);
    }
  }
} else {
  render(<App root={root} api={defaultApi(() => findRepos(root, depth), editor)} initialSort={sort} />);
}
