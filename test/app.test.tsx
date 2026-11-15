import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { App, filterRepos, sortRepos, type Api } from "../src/App.js";
import type { RepoInfo } from "../src/git.js";

const repo = (name: string, extra: Partial<RepoInfo> = {}): RepoInfo => ({
  name,
  path: `/r/${name}`,
  branch: "main",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  changed: 0,
  untracked: 0,
  conflicts: 0,
  stashes: 0,
  lastCommit: "1 day ago · init",
  lastCommitTs: 1000,
  remoteUrl: `git@github.com:me/${name}.git`,
  stack: [],
  ...extra,
});

const REPOS = [
  repo("alpha", { changed: 3, stack: ["next 15"] }),
  repo("beta", { behind: 2, lastCommitTs: 3000 }),
  repo("gamma", { ahead: 1, lastCommitTs: 2000 }),
  repo("delta", { upstream: null }),
];

function fakeApi(over: Partial<Api> = {}): Api {
  let state = REPOS.map((r) => ({ ...r }));
  return {
    findRepos: () => state.map((r) => r.path),
    inspectRepo: async (p) => state.find((r) => r.path === p)!,
    inspectDetail: async () => ({ commits: [{ hash: "abc123", when: "2 days ago", subject: "fix login" }], files: [{ status: "M", path: "src/x.ts" }] }),
    git: vi.fn(async (cwd: string, args: string[]) => {
      if (args[0] === "pull") state = state.map((r) => (r.path === cwd ? { ...r, behind: 0 } : r));
      return { ok: true, out: "" };
    }),
    openEditor: vi.fn(async () => true),
    openUrl: vi.fn(async () => true),
    ...over,
  };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function mount(api = fakeApi()) {
  const ui = render(<App root="/r" api={api} />);
  await tick();
  return { ...ui, api, type: async (s: string) => { ui.stdin.write(s); await tick(); } };
}

describe("sortRepos / filterRepos", () => {
  it("sorts", () => {
    expect(sortRepos(REPOS, "recent").map((r) => r.name)).toEqual(["beta", "gamma", "alpha", "delta"]);
    expect(sortRepos(REPOS, "dirty")[0].name).toBe("alpha");
    expect(sortRepos(REPOS, "behind")[0].name).toBe("beta");
  });
  it("filters by text and shortcuts", () => {
    expect(filterRepos(REPOS, "next").map((r) => r.name)).toEqual(["alpha"]);
    expect(filterRepos(REPOS, ":dirty").map((r) => r.name)).toEqual(["alpha"]);
    expect(filterRepos(REPOS, ":behind").map((r) => r.name)).toEqual(["beta"]);
    expect(filterRepos(REPOS, ":unpushed").map((r) => r.name)).toEqual(["gamma", "delta"]);
  });
});

describe("App", () => {
  it("renders repos and a summary", async () => {
    const { lastFrame } = await mount();
    const f = lastFrame()!;
    for (const n of ["alpha", "beta", "gamma", "delta"]) expect(f).toContain(n);
    expect(f).toContain("●3");
    expect(f).toContain("↓2");
    expect(f).toContain("↑1");
    expect(f).toContain("no remote");
    expect(f).toContain("4 repos · 1 dirty · 2 unpushed · 1 behind");
  });

  it("filters as you type and clears on escape", async () => {
    const { lastFrame, type } = await mount();
    await type("/");
    await type("gam");
    expect(lastFrame()).toContain("gamma");
    expect(lastFrame()).not.toContain("alpha");
    await type("\r");
    expect(lastFrame()).toContain("1 match");
    await type("\x1b");
    expect(lastFrame()).toContain("alpha");
  });

  it("opens the detail panel with commits and files", async () => {
    const { lastFrame, type } = await mount();
    await type("\r");
    expect(lastFrame()).toContain("fix login");
    expect(lastFrame()).toContain("src/x.ts");
  });

  it("pulls the selected repo only when it's safe", async () => {
    const { lastFrame, type, api } = await mount();
    await type("p"); // alpha is dirty
    expect(lastFrame()).toContain("commit or stash changes first");
    expect(api.git).not.toHaveBeenCalled();
    await type("j"); // beta is behind and clean
    await type("p");
    await tick(60);
    expect(api.git).toHaveBeenCalledWith("/r/beta", ["pull", "--ff-only"], 120000);
    expect(lastFrame()).toContain("pulled beta");
    expect(lastFrame()).toContain("0 behind");
  });

  it("pull all skips dirty and up-to-date repos", async () => {
    const { type, api } = await mount();
    await type("P");
    await tick(60);
    expect((api.git as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual(["/r/beta"]);
  });

  it("opens the editor and the remote in a browser", async () => {
    const { type, api } = await mount();
    await type("o");
    expect(api.openEditor).toHaveBeenCalledWith("/r/alpha");
    await type("b");
    expect(api.openUrl).toHaveBeenCalledWith("https://github.com/me/alpha");
  });

  it("cycles sort order", async () => {
    const { lastFrame, type } = await mount();
    await type("s");
    expect(lastFrame()).toContain("sort (dirty)");
    await type("s");
    const f = lastFrame()!;
    expect(f.indexOf("beta")).toBeLessThan(f.indexOf("gamma"));
  });

  it("shows a hint when there are no repos", async () => {
    const { lastFrame } = await mount(fakeApi({ findRepos: () => [] }));
    expect(lastFrame()).toContain("try --depth 2");
  });
});
