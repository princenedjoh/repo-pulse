# repo-pulse

[![npm](https://img.shields.io/npm/v/@princenedjoh/repo-pulse)](https://www.npmjs.com/package/@princenedjoh/repo-pulse)
[![CI](https://github.com/princenedjoh/repo-pulse/actions/workflows/ci.yml/badge.svg)](https://github.com/princenedjoh/repo-pulse/actions/workflows/ci.yml)

A terminal dashboard for a folder full of git repos. See at a glance which projects have uncommitted changes, unpushed commits or are behind their remote, and what stack each one runs. Then fetch, pull, open or browse them without leaving the keyboard.

```sh
npm i -g @princenedjoh/repo-pulse   # installs the `repo-pulse` command
```

```sh
npx @princenedjoh/repo-pulse ~/projects
```

```
 repo-pulse /Users/me/projects
 /helix  (3 matches, esc to clear)
   helix-backend               develop             ●4     ↓73       4w   go
 › helix-contact-us-page       main                ✓                7mo
   helix-mobile                staging             ●13              1d   expo 56 · rn 0.85
 ╭──────────────────────────────────────────────────────────────────────────────╮
 │ helix-contact-us-page /Users/me/projects/helix-contact-us-page               │
 │ origin/main · https://github.com/me/helix-contact-us.git                     │
 │ 2c264a1 7 months ago   initial commit                                        │
 ╰──────────────────────────────────────────────────────────────────────────────╯
 24 repos · 11 dirty · 3 unpushed · 1 behind
```

## Columns

| | |
| --- | --- |
| `✓` / `●4` / `✗2` | clean, 4 changed or untracked files, 2 merge conflicts |
| `↑2 ↓5` | commits ahead of and behind upstream |
| `no remote` | has commits but no upstream branch, so the work exists only on this machine |
| `3d` | age of the last commit |
| `next 16 · rn 0.85` | framework versions from `package.json`; Go, Rust, Python, Swift, Flutter, Ruby and PHP are detected from their marker files |

## Keys

| Key | Action |
| --- | --- |
| `↑` `↓` `j` `k`, `PgUp` `PgDn`, `g` `G` | move |
| `⏎` | toggle details: remote, stashes, last 5 commits, changed files |
| `/` | filter by name, branch or stack; `:dirty`, `:unpushed`, `:behind` are shortcuts |
| `s` | sort by name, dirty, recent or behind |
| `f` | fetch every repo that has a remote |
| `p` | pull the selected repo |
| `P` | pull every visible repo that is behind and clean |
| `o` | open in your editor (`--editor`, `$REPO_PULSE_EDITOR`, `$VISUAL`, or `code`) |
| `b` | open the remote on GitHub, GitLab or Bitbucket |
| `r` | refresh |
| `q` / `esc` | quit |

Pulls are always `--ff-only` and skip repos with local changes, so repo-pulse never creates merge commits or touches a dirty tree. Git is run with `GIT_TERMINAL_PROMPT=0`, so a repo needing credentials fails fast instead of freezing the UI.

## Scripting

```sh
repo-pulse ~/projects --plain              # one line per repo
repo-pulse ~/projects --json               # full status as JSON
repo-pulse ~/projects --unpushed           # only repos with work that isn't on a remote
repo-pulse ~/projects --dirty --sort recent
repo-pulse ~/projects --fetch --behind     # fetch first, then list repos you need to pull
repo-pulse ~/projects --check              # exit 1 if anything is uncommitted or unpushed
```

`--check` is handy before wiping a laptop or at the end of the day. The output is plain automatically when stdout isn't a terminal.

Use `--depth 2` (or more) when your repos are grouped in folders like `~/code/work/*` and `~/code/personal/*`. A repo's own subfolders are never searched, and neither are `node_modules` or build output.

## License

MIT
