import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectStack, findRepos, hasUnpushed, inspectDetail, inspectRepo, parseStatus, pool, shortAge, webUrl } from "../src/git.js";

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  }).toString();

function commit(dir: string, file: string, msg: string) {
  writeFileSync(join(dir, file), msg);
  sh(dir, "add", file);
  sh(dir, "commit", "-q", "-m", msg);
}

describe("parseStatus", () => {
  it("reads branch, upstream, ahead/behind, stash, conflicts and file counts", () => {
    const s = parseStatus(
      [
        "# branch.oid abc",
        "# branch.head main",
        "# branch.upstream origin/main",
        "# branch.ab +2 -1",
        "# stash 3",
        "1 .M N... 100644 100644 100644 a b src/a.ts",
        "2 R. N... 100644 100644 100644 a b R100 new.ts\told.ts",
        "u UU N... 100644 100644 100644 100644 a b c conflict.ts",
        "? scratch.txt",
      ].join("\n"),
    );
    expect(s).toEqual({ branch: "main", upstream: "origin/main", ahead: 2, behind: 1, changed: 3, untracked: 1, conflicts: 1, stashes: 3 });
  });

  it("handles repos without an upstream", () => {
    const s = parseStatus("# branch.oid x\n# branch.head feature");
    expect(s.upstream).toBeNull();
    expect(s.ahead).toBe(0);
  });
});

describe("detectStack", () => {
  it("summarises framework versions", () => {
    const pkg = JSON.stringify({ dependencies: { expo: "~52.0.1", "react-native": "0.76.3", react: "18.3.1" } });
    expect(detectStack(pkg)).toEqual(["expo 52", "rn 0.76"]);
    expect(detectStack(JSON.stringify({ dependencies: { "@nestjs/core": "^10.2.0" } }))).toEqual(["nest 10"]);
  });
  it("keeps react for plain React apps and ignores bad json", () => {
    expect(detectStack(JSON.stringify({ dependencies: { react: "^19.0.0" } }))).toEqual(["react 19"]);
    expect(detectStack("{nope")).toEqual([]);
  });
});

describe("webUrl", () => {
  it.each([
    ["git@github.com:me/app.git", "https://github.com/me/app"],
    ["https://github.com/me/app.git", "https://github.com/me/app"],
    ["https://token@gitlab.com/g/sub/app", "https://gitlab.com/g/sub/app"],
    ["ssh://git@bitbucket.org:22/me/app.git", "https://bitbucket.org/me/app"],
  ])("%s", (remote, url) => {
    expect(webUrl(remote)).toBe(url);
  });
  it("returns null for local remotes", () => {
    expect(webUrl("/tmp/bare.git")).toBeNull();
    expect(webUrl(null)).toBeNull();
  });
});

describe("shortAge", () => {
  it("picks a compact unit", () => {
    const now = 1_000_000_000;
    expect(shortAge(now - 120, now)).toBe("2m");
    expect(shortAge(now - 3 * 3600, now)).toBe("3h");
    expect(shortAge(now - 5 * 86400, now)).toBe("5d");
    expect(shortAge(now - 21 * 86400, now)).toBe("3w");
    expect(shortAge(now - 120 * 86400, now)).toBe("4mo");
    expect(shortAge(now - 800 * 86400, now)).toBe("2y");
    expect(shortAge(0, now)).toBe("—");
  });
});

describe("pool", () => {
  it("preserves order, respects the limit and reports progress", async () => {
    let active = 0;
    let peak = 0;
    const seen: number[] = [];
    const out = await pool(
      [1, 2, 3, 4, 5, 6],
      2,
      async (n) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return n * 2;
      },
      (d) => seen.push(d),
    );
    expect(out).toEqual([2, 4, 6, 8, 10, 12]);
    expect(peak).toBeLessThanOrEqual(2);
    expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("against real git repos", () => {
  let root: string;
  let remote: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "repo-pulse-"));
    remote = join(root, "..", `${root.split("/").pop()}-remote.git`);
    sh(root, "init", "-q", "--bare", "-b", "main", remote);

    // app: cloned, 1 behind, 1 ahead, dirty, one stash
    sh(root, "clone", "-q", remote, "app");
    const app = join(root, "app");
    sh(app, "checkout", "-q", "-b", "main");
    commit(app, "a.txt", "first");
    sh(app, "push", "-q", "-u", "origin", "main");
    sh(root, "clone", "-q", remote, "other");
    commit(join(root, "other"), "b.txt", "from elsewhere");
    sh(join(root, "other"), "push", "-q");
    sh(app, "fetch", "-q");
    commit(app, "c.txt", "local only");
    writeFileSync(join(app, "a.txt"), "edited");
    writeFileSync(join(app, "new.txt"), "untracked");
    writeFileSync(join(app, "package.json"), JSON.stringify({ dependencies: { next: "15.1.0", react: "19.0.0" } }));
    sh(app, "stash", "push", "-q", "--include-untracked", "--", "package.json");
    writeFileSync(join(app, "package.json"), JSON.stringify({ dependencies: { next: "15.1.0", react: "19.0.0" } }));

    // lonely: local repo with commits but no remote
    mkdirSync(join(root, "lonely"));
    sh(join(root, "lonely"), "init", "-q", "-b", "main");
    commit(join(root, "lonely"), "x.txt", "hello");

    // empty: no commits
    mkdirSync(join(root, "empty"));
    sh(join(root, "empty"), "init", "-q");

    // nested repo two levels down, and junk to skip
    mkdirSync(join(root, "group", "deep"), { recursive: true });
    sh(join(root, "group", "deep"), "init", "-q");
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    sh(join(root, "node_modules", "pkg"), "init", "-q");
  });

  it("finds repos at the requested depth", () => {
    const names = (d: number) => findRepos(root, d).map((p) => p.slice(root.length + 1));
    expect(names(1)).toEqual(["app", "empty", "lonely", "other"]);
    expect(names(2)).toEqual(["app", "empty", "group/deep", "lonely", "other"]);
    expect(findRepos(join(root, "app"))).toEqual([join(root, "app")]);
  });

  it("inspects a busy repo", async () => {
    const r = await inspectRepo(join(root, "app"));
    expect(r).toMatchObject({ name: "app", branch: "main", upstream: "origin/main", ahead: 1, behind: 1, stashes: 1, stack: ["next 15"] });
    expect(r.changed).toBe(1);
    expect(r.untracked).toBe(2);
    expect(r.lastCommit).toContain("local only");
    expect(r.remoteUrl).toBe(remote);
    expect(hasUnpushed(r)).toBe(true);
  });

  it("treats commits without a remote as unpushed, and empty repos as neither", async () => {
    const lonely = await inspectRepo(join(root, "lonely"));
    expect(lonely.upstream).toBeNull();
    expect(hasUnpushed(lonely)).toBe(true);
    const empty = await inspectRepo(join(root, "empty"));
    expect(empty.lastCommit).toBe("no commits yet");
    expect(hasUnpushed(empty)).toBe(false);
  });

  it("loads recent commits and changed files", async () => {
    const d = await inspectDetail(join(root, "app"));
    expect(d.commits.map((c) => c.subject)).toEqual(["local only", "first"]);
    expect(d.files).toEqual(expect.arrayContaining([{ status: "M", path: "a.txt" }, { status: "??", path: "new.txt" }]));
  });

  it("reports an error for a broken repo instead of throwing", async () => {
    const broken = join(root, "broken");
    mkdirSync(join(broken, ".git"), { recursive: true });
    const r = await inspectRepo(broken);
    expect(r.error).toBeTruthy();
  });
});
