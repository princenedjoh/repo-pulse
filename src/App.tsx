import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import {
  git,
  hasUnpushed,
  inspectDetail,
  inspectRepo,
  isDirty,
  launch,
  openUrl,
  pool,
  shortAge,
  webUrl,
  type RepoDetail,
  type RepoInfo,
} from "./git.js";

export type Sort = "name" | "dirty" | "recent" | "behind";
const SORTS: Sort[] = ["name", "dirty", "recent", "behind"];

export interface Api {
  findRepos(): string[];
  inspectRepo(path: string): Promise<RepoInfo>;
  inspectDetail(path: string): Promise<RepoDetail>;
  git(cwd: string, args: string[], timeout?: number): Promise<{ ok: boolean; out: string }>;
  openEditor(path: string): Promise<boolean>;
  openUrl(url: string): Promise<boolean>;
}

export function defaultApi(findRepos: () => string[], editor: string): Api {
  return {
    findRepos,
    inspectRepo,
    inspectDetail,
    git,
    openEditor: (path) => launch(editor, [path]),
    openUrl,
  };
}

export function sortRepos(repos: RepoInfo[], by: Sort): RepoInfo[] {
  const byName = (a: RepoInfo, b: RepoInfo) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  const copy = [...repos];
  if (by === "dirty") copy.sort((a, b) => b.changed + b.untracked - (a.changed + a.untracked) || byName(a, b));
  else if (by === "recent") copy.sort((a, b) => b.lastCommitTs - a.lastCommitTs || byName(a, b));
  else if (by === "behind") copy.sort((a, b) => b.behind - a.behind || b.ahead - a.ahead || byName(a, b));
  else copy.sort(byName);
  return copy;
}

export function filterRepos(repos: RepoInfo[], query: string): RepoInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return repos;
  if (q === ":dirty") return repos.filter(isDirty);
  if (q === ":unpushed") return repos.filter(hasUnpushed);
  if (q === ":behind") return repos.filter((r) => r.behind > 0);
  return repos.filter((r) => [r.name, r.branch, ...r.stack].some((s) => s.toLowerCase().includes(q)));
}

function Row({ repo, selected, nameWidth, showStack }: { repo: RepoInfo; selected: boolean; nameWidth: number; showStack: boolean }) {
  const dirty = repo.changed + repo.untracked;
  return (
    <Box>
      <Text color="cyan">{selected ? "› " : "  "}</Text>
      <Box width={nameWidth}>
        <Text bold={selected} inverse={selected} wrap="truncate-end">{repo.name}</Text>
      </Box>
      <Box width={20} marginLeft={1}>
        <Text color="magenta" wrap="truncate-end">{repo.branch}</Text>
      </Box>
      <Box width={7}>
        {repo.error ? (
          <Text color="red">error</Text>
        ) : repo.conflicts > 0 ? (
          <Text color="red">✗{repo.conflicts}</Text>
        ) : dirty > 0 ? (
          <Text color="yellow">●{dirty}</Text>
        ) : (
          <Text color="green">✓</Text>
        )}
      </Box>
      <Box width={10}>
        {repo.ahead > 0 && <Text color="cyan">↑{repo.ahead} </Text>}
        {repo.behind > 0 && <Text color="red">↓{repo.behind}</Text>}
        {repo.upstream === null && repo.lastCommitTs > 0 && <Text dimColor>no remote</Text>}
      </Box>
      <Box width={5}>
        <Text dimColor>{shortAge(repo.lastCommitTs)}</Text>
      </Box>
      {showStack && <Text dimColor wrap="truncate-end">{repo.stack.join(" · ")}</Text>}
    </Box>
  );
}

function Detail({ repo, detail }: { repo: RepoInfo; detail: RepoDetail | null }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Text>
        <Text bold>{repo.name}</Text> <Text dimColor>{repo.path}</Text>
      </Text>
      <Text dimColor>
        {repo.upstream ?? "no upstream"}
        {repo.remoteUrl ? ` · ${repo.remoteUrl}` : ""}
        {repo.stashes ? ` · ${repo.stashes} stash${repo.stashes > 1 ? "es" : ""}` : ""}
      </Text>
      {repo.error && <Text color="red">{repo.error}</Text>}
      {!detail ? (
        <Text dimColor>loading…</Text>
      ) : (
        <>
          {detail.commits.map((c) => (
            <Text key={c.hash} wrap="truncate-end">
              <Text color="yellow">{c.hash}</Text> <Text dimColor>{c.when.padEnd(14)}</Text> {c.subject}
            </Text>
          ))}
          {detail.files.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              {detail.files.slice(0, 8).map((f) => (
                <Text key={f.path} wrap="truncate-end">
                  <Text color={f.status === "??" ? "gray" : f.status.includes("U") ? "red" : "yellow"}>{f.status.padEnd(3)}</Text>
                  {f.path}
                </Text>
              ))}
              {detail.files.length > 8 && <Text dimColor>…and {detail.files.length - 8} more</Text>}
            </Box>
          )}
        </>
      )}
    </Box>
  );
}

export function App({ root, api, initialSort = "name" }: { root: string; api: Api; initialSort?: Sort }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState({ rows: stdout.rows || 30, cols: stdout.columns || 100 });
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [sort, setSort] = useState<Sort>(initialSort);
  const [query, setQuery] = useState("");
  const [filtering, setFiltering] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const [detail, setDetail] = useState<RepoDetail | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: "ok" | "warn" | "err" } | null>(null);

  useEffect(() => {
    const onResize = () => setSize({ rows: stdout.rows || 30, cols: stdout.columns || 100 });
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  const load = useCallback(async () => {
    setLoading(true);
    const paths = api.findRepos();
    setRepos(await pool(paths, 8, (p) => api.inspectRepo(p)));
    setLoading(false);
  }, [api]);

  const reloadOne = useCallback(
    async (path: string) => {
      const fresh = await api.inspectRepo(path);
      setRepos((rs) => rs.map((r) => (r.path === path ? fresh : r)));
    },
    [api],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => sortRepos(filterRepos(repos, query), sort), [repos, query, sort]);
  const index = Math.min(cursor, Math.max(0, visible.length - 1));
  const selected = visible[index];

  useEffect(() => {
    setDetail(null);
    if (!showDetail || !selected) return;
    let live = true;
    void api.inspectDetail(selected.path).then((d) => live && setDetail(d));
    return () => {
      live = false;
    };
  }, [showDetail, selected?.path, selected?.lastCommitTs, selected?.changed, api]);

  const nameWidth = Math.min(28, Math.max(10, ...repos.map((r) => r.name.length + 1)));
  const showStack = size.cols >= nameWidth + 60;
  const detailHeight = showDetail ? 13 : 0;
  const listHeight = Math.max(3, size.rows - 7 - detailHeight);
  const start = Math.min(Math.max(0, index - Math.floor(listHeight / 2)), Math.max(0, visible.length - listHeight));
  const windowed = visible.slice(start, start + listHeight);

  const say = (text: string, tone: "ok" | "warn" | "err" = "ok") => setMessage({ text, tone });

  const pull = async (targets: RepoInfo[]) => {
    const safe = targets.filter((r) => r.behind > 0 && r.changed === 0 && r.upstream);
    if (safe.length === 0) {
      say(targets.length === 1 ? `${targets[0].name}: ${targets[0].changed ? "commit or stash changes first" : "already up to date"}` : "nothing to pull", "warn");
      return;
    }
    setProgress(`pulling 0/${safe.length}`);
    const results = await pool(
      safe,
      4,
      (r) => api.git(r.path, ["pull", "--ff-only"], 120000),
      (n) => setProgress(`pulling ${n}/${safe.length}`),
    );
    setProgress(null);
    await Promise.all(safe.map((r) => reloadOne(r.path)));
    const failed = safe.filter((_, i) => !results[i].ok);
    if (failed.length === 0) say(`pulled ${safe.map((r) => r.name).join(", ")}`);
    else say(`${failed.map((r) => r.name).join(", ")}: ${results.find((r) => !r.ok)!.out.split("\n")[0]}`, "err");
  };

  const fetchAll = async () => {
    setProgress(`fetching 0/${repos.length}`);
    const withRemote = repos.filter((r) => r.remoteUrl);
    const results = await pool(
      withRemote,
      6,
      (r) => api.git(r.path, ["fetch", "--prune", "--quiet"], 60000),
      (n) => setProgress(`fetching ${n}/${withRemote.length}`),
    );
    setProgress(null);
    await load();
    const failed = withRemote.filter((_, i) => !results[i].ok).map((r) => r.name);
    say(failed.length ? `fetch failed for ${failed.join(", ")}` : `fetched ${withRemote.length} repos`, failed.length ? "warn" : "ok");
  };

  useInput((input, key) => {
    if (filtering) {
      if (key.return) setFiltering(false);
      else if (key.escape) {
        setQuery("");
        setFiltering(false);
      } else if (key.backspace || key.delete) setQuery((q) => q.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) {
        setQuery((q) => q + input);
        setCursor(0);
      }
      return;
    }
    const page = Math.max(1, listHeight - 1);
    if (input === "q" || (key.ctrl && input === "c")) exit();
    else if (key.escape) {
      if (showDetail) setShowDetail(false);
      else if (query) setQuery("");
      else exit();
    } else if (key.downArrow || input === "j") setCursor(Math.min(index + 1, visible.length - 1));
    else if (key.upArrow || input === "k") setCursor(Math.max(index - 1, 0));
    else if (key.pageDown) setCursor(Math.min(index + page, visible.length - 1));
    else if (key.pageUp) setCursor(Math.max(index - page, 0));
    else if (input === "g") setCursor(0);
    else if (input === "G") setCursor(visible.length - 1);
    else if (key.return) setShowDetail((d) => !d);
    else if (input === "/") {
      setFiltering(true);
      setMessage(null);
    } else if (input === "s") setSort((s) => SORTS[(SORTS.indexOf(s) + 1) % SORTS.length]);
    else if (input === "r") {
      setMessage(null);
      void load();
    } else if (progress) say("busy, wait for the current action to finish", "warn");
    else if (input === "f") void fetchAll();
    else if (input === "p" && selected) void pull([selected]);
    else if (input === "P") void pull(visible);
    else if (input === "o" && selected) {
      void api.openEditor(selected.path).then((ok) => say(ok ? `opened ${selected.name}` : "couldn't start the editor; set --editor or $REPO_PULSE_EDITOR", ok ? "ok" : "err"));
    } else if (input === "b" && selected) {
      const url = webUrl(selected.remoteUrl);
      if (!url) say(`${selected.name} has no browsable remote`, "warn");
      else void api.openUrl(url).then((ok) => say(ok ? `opened ${url}` : `couldn't open ${url}`, ok ? "ok" : "err"));
    }
  });


  const dirtyCount = repos.filter(isDirty).length;
  const unpushed = repos.filter(hasUnpushed).length;
  const behind = repos.filter((r) => r.behind > 0).length;
  const tone = { ok: "green", warn: "yellow", err: "red" } as const;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text bold>repo-pulse </Text>
        <Text dimColor wrap="truncate-start">{root}</Text>
      </Box>
      <Box>
        {filtering || query ? (
          <Text>
            <Text color="cyan">/</Text>
            {query}
            {filtering ? <Text inverse> </Text> : <Text dimColor>  ({visible.length} match{visible.length === 1 ? "" : "es"}, esc to clear)</Text>}
          </Text>
        ) : (
          <Text dimColor>
            {visible.length > listHeight ? `${start + 1}–${start + windowed.length} of ${visible.length}` : " "}
          </Text>
        )}
      </Box>
      {loading && repos.length === 0 ? (
        <Text dimColor>scanning…</Text>
      ) : repos.length === 0 ? (
        <Text color="yellow">no git repositories found here (try --depth 2)</Text>
      ) : visible.length === 0 ? (
        <Text color="yellow">nothing matches "{query}"</Text>
      ) : (
        windowed.map((r) => <Row key={r.path} repo={r} selected={r === selected} nameWidth={nameWidth} showStack={showStack} />)
      )}
      {showDetail && selected && <Detail repo={selected} detail={detail} />}
      {!showDetail && selected && (
        <Text dimColor wrap="truncate-end">
          {selected.upstream ?? "no upstream"} · {selected.lastCommit}
        </Text>
      )}
      <Text wrap="truncate-end">
        {repos.length} repos · <Text color="yellow">{dirtyCount} dirty</Text> · <Text color="cyan">{unpushed} unpushed</Text> ·{" "}
        <Text color="red">{behind} behind</Text>
        {progress ? <Text color="cyan"> · {progress}</Text> : loading ? <Text dimColor> · refreshing…</Text> : null}
      </Text>
      <Text dimColor wrap="truncate-end">
        ↑↓ move · ⏎ details · / filter · s sort ({sort}) · f fetch · p/P pull · o open · b browse · r refresh · q quit
      </Text>
      {message && <Text color={tone[message.tone]} wrap="truncate-end">{message.text}</Text>}
    </Box>
  );
}
