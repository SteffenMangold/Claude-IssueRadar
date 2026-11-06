<div align="center">

# Issue Radar

**The open GitHub issues of your repository beside the conversation, and one click that starts a Claude session which understands an issue before it codes.**

A sidebar mod for [Claude Code](https://claude.com/claude-code) in the Claude desktop app.

[![Claude Code mod](https://img.shields.io/badge/Claude_Code-mod-d97757?style=flat-square)](https://code.claude.com/docs)
[![Version](https://img.shields.io/badge/version-0.1.1-30a46c?style=flat-square)](.claude-plugin/plugin.json)
[![License](https://img.shields.io/badge/license-Apache_2.0-4c8ed9?style=flat-square)](LICENSE)
[![Runs locally](https://img.shields.io/badge/GitHub-via_gh-8b8d98?style=flat-square)](#-privacy)

</div>

---

## Why

Choosing the next issue means leaving the app, reading it in the browser and explaining it to
Claude again. Issue Radar keeps the open issues of the repository you work in beside the
conversation, each with a short AI recap, and turns any of them into a dedicated session with
one click. That session does not start coding: it reads the issue, writes a summary, interviews
you one question at a time (the `grill-me` contract), delivers a proposal, and implements only
when you say "go".

The product context, the decisions and the enrichment roadmap live in
[`docs/CONTEXT.md`](docs/CONTEXT.md); the verified platform facts in
[`docs/PLATFORM.md`](docs/PLATFORM.md).

## 🚀 Install

At the prompt of a Claude Code terminal session:

```
/plugin install issue-radar --marketplace SteffenMangold/Claude-IssueRadar
```

From a shell:

```bash
claude plugin install issue-radar --marketplace SteffenMangold/Claude-IssueRadar
```

Answer `y` to add the marketplace, then pick a scope (the user scope is first). In the **desktop
app**, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**,
**Add marketplace** with `SteffenMangold/Claude-IssueRadar`, then **Add plugin**.

You need the GitHub CLI `gh`, signed in (`gh auth login`). The pane opens with the next session
in a folder that resolves to a GitHub repository; `/issue-radar` or `/issues` opens it any time.

> Built against the Claude Code function-hook declarations of 2.1.317 (the engine the desktop
> app hosts), and validated (`--strict`) and tested with that engine's own CLI. An older CLI is
> not enough: 2.1.207 validates the manifest but not the module the way the engine loads it, and
> has no `claude plugin test`; check with a CLI at least as new as the engine. The
> interface is German by default (`language` setting); where this README names something on
> screen, the German label follows in parentheses.

## 🧭 What you see

| Part | What it does |
|---|---|
| **Title bar** | ↻ refresh · ⚙ settings · ✕ close |
| **Sections** | One per repository: the folder's own first, then the repositories you watch. The header folds a section. |
| **Row** | `#n title` (click to open it), label chips, age, comment count, assignee · the recap, or an excerpt of the body before you switch recaps on · **GitHub ↗** · **Work on it** (Bearbeiten) · *Take it here* (Hier übernehmen) |
| **Opened row** | Body excerpt, the last comments, the pull requests that will close the issue |
| **Consent row** | Appears once per repository: switch the AI recaps on, or not for this repository |
| **Settings** (⚙) | Further repositories to watch (`owner/repo`), and the recap consent per repository |
| **Footer** | Time of the last fetch, open count, recap model, recap tokens spent this session, version |
| **States** | A named state with the next command instead of an empty list: no git repository, no remote, a non-GitHub remote, `gh` missing or signed out (with `gh auth login`), token rejected, no access, issues disabled, archived, offline, rate-limited, no open issues |

## 🤝 The issue session

**Work on it** re-reads the issue, then starts a new desktop session named `#n <title>` with
its own worktree and a brief that enforces five phases:

1. **Read** the whole thread with `gh`, and the code it touches; if a pull request already
   references the issue, say so first.
2. **Summary**: problem, expected outcome, acceptance criteria found or missing, affected
   areas, related issues and pull requests, unknowns.
3. **Interview**: the `grill-me` skill where installed, otherwise its contract: one question at
   a time, each with a recommended answer, until the decision tree is resolved.
4. **Proposal**: approach, files, steps, tests, risks, Definition of Done, size, and the single
   question "Go?".
5. **Stop** before any file changes. After "go": implement, reference `#n` in every commit, open
   a pull request whose description closes the issue.

The pane remembers the session: a second click opens it instead of starting another, and the
session is detached from the pane's session so it outlives it. Where no session can be started
(a terminal session, or the app refuses), the same brief lands in the prompt box; *Take it here*
does that on purpose, for small issues you want in the running session.

The brief is English and tells the session to answer in the language you write in. Its full text
is [Appendix A of `docs/CONTEXT.md`](docs/CONTEXT.md#appendix-a-the-brief-v1-template).

## 📏 How it works

- **Repository**: `gh repo view` in the project root is the authority (host, owner, name,
  default branch, whether issues are enabled). A fork shows the upstream repository's issues, as
  `gh` resolves it; `gh repo set-default` changes that.
- **Fetching**: `gh issue list` (open issues, most recently updated first, capped) on a timer
  while the pane is shown, after a `gh issue …` or `git push` command in the session, and on ↻;
  `gh issue view` only for an issue whose update time changed. Several panes of the same project
  share one fetch per interval through the store.
- **Recaps**: one small model call per *changed* issue (`haiku` by default), through your
  session's own Claude credentials, only after the consent click per repository; cached by the
  issue's update time; the footer counts the tokens. Switching a repository's recaps off
  removes its stored recaps.
- **Store**: metadata, a 160-character excerpt, comment counts, linked pull requests, recaps,
  the issue → session mapping and the per-repository settings; never bodies or comments.
  `/issue-radar reset` clears it.

## ⚙️ Settings

In the app's config menu (installation-wide):

| Setting | Default | Effect |
|---|---|---|
| Open at start | on | Open the pane when a session starts in a GitHub repository |
| Refresh interval (minutes) | 3 | Timer for the list while the pane is shown; 0 turns it off |
| Issue cap | 30 | Open issues listed per repository |
| AI recaps | on | Master switch; each repository still needs its consent |
| Recap model | `haiku` | `haiku` or `sonnet` |
| Language | `de` | `de` or `en` for labels and recaps |

In the pane (per repository, in the store): the repositories to watch and the recap consents.

## 🔒 Privacy

- **GitHub** is reached only through your signed-in `gh`; the mod never sees a token and writes
  nothing to GitHub.
- **Anthropic** receives, through your session's credentials: the recaps' input (title, author,
  labels, up to 4,000 characters of the body and the latest three comments of each changed
  issue) once you consented for the repository, and the brief (up to about 6,000 characters of
  the issue plus its latest comments) whenever you start a session or take an issue into the
  prompt box.
- **On disk**: the store under `~/.claude/plugins/store/` holds issue metadata, short excerpts,
  recaps, mappings and settings. Nothing is sent anywhere else; no telemetry.

## ⚠️ Limits

- V1 lists issues and starts sessions; it does not show session state on the row, filters,
  hover cards or `#123` typeahead. Those are the ranked enrichments in `docs/CONTEXT.md`.
- Whether a mod may start a desktop session, and by which route, was the project's first spike;
  `/issue-radar spike` starts one throw-away session and reports the route, the id the app
  answered and whether detaching worked. The outcome on the development machine is recorded in
  `docs/CONTEXT.md` once measured.
- The desktop side panel is 280 to 640 px wide; the layout is drawn for about 46 cells.
- GitHub Enterprise hosts are handled through `gh` but untested.

## 🛠 Development

```
.claude-plugin/plugin.json        manifest and userConfig
.claude-plugin/marketplace.json   makes this repository a marketplace
hooks/register.tsx                hooks: pane, commands, refresh pipeline, hand-off
hooks/github.ts                   gh: repository, list, details, failure states
hooks/recap.ts                    the model call
hooks/brief.ts                    the brief, the background, the names
hooks/session.ts                  starting, detaching, opening desktop sessions
hooks/view.tsx                    the pane's drawing
hooks/i18n.ts                     the labels in German and English
types/index.d.ts                  data types and the state contract
tests/issue-radar.test.tsx        tests for claude plugin test
docs/                             CONTEXT.md and PLATFORM.md
```

Run a working copy with `claude --plugin-dir <this folder>`, and check it with:

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

## 📄 License

[Apache License 2.0](LICENSE)
