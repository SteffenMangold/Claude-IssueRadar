# Platform facts

> **TL;DR for AI agents:** the verified facts about the Claude Code function-hook API, the
> desktop app's tools and `gh` that the design in [`CONTEXT.md`](CONTEXT.md) relies on. Load
> it when a task touches one of these mechanisms; re-verify it when the Claude Code build
> changes. What is still unproven is listed in the
> [spike table](CONTEXT.md#assumptions-to-prove-the-spike), not here.

Verified on 2026-11-06 against the Claude Code **2.1.317** function-hook declarations
(`claude-code.d.ts`, as the plugin-authoring skill lays them out) and its reference, the
desktop app's MCP tool index as a loaded mod sees it (`.claude-plugin/types/claude-code-mcp/`),
the `claude` CLI **2.1.207** on the owner's PATH, and live read-only calls with `gh` **2.96.0**.
The function-hook API is **early access and moves between releases**.

## The mod API

| Capability | How a mod reaches it |
|---|---|
| A sidebar pane | `$.ui.open({ id, title, columns })`, drawn by a `ui.render` hook for the `Pane` component. A pane opened on request (a command, a click) is placed at any width; one opened on the mod's initiative (session start, a timer) waits undrawn on a terminal narrower than 144 columns (110 once the person has opened that id and not closed it by hand) and, on any surface, until a client that places panes is attached; the declarations document no width floor for the desktop. The desktop client attaches after `session.start`, so an open made there answers `isPlaced: false` and is placed when the client attaches: the pane is opened once and re-checked on `session.attach` (a second open of the same id only retitles) |
| Desktop elements | `Box`, `Text`, `Button`, `Input`, `Select`, `Svg`, `Link`, `Code`, `Markdown`; a list row is one `Button` with text children; on the desktop a `Link` is an anchor, and where the app sends it (external browser or an in-app pane) is spike item S6 |
| The session's repository | `gh repo view --json nameWithOwner,isPrivate,hasIssuesEnabled,isArchived,isFork,url,defaultBranchRef` in the project root is the authority. Exit 4 means *signed out* (of that host); *no remote*, *not a GitHub host* and *not a repository* all exit 1 and are told apart only by their messages (`no git remotes found`, `none of the git remotes … point to a known GitHub host`, `not a git repository`). A clone with `origin` and `upstream` resolves to the upstream repository without a prompt; `gh repo set-default` changes that. `$.session.repo()` answers null outside a git repository (that case skips `gh`); its `remote` names `origin` only, so a null `remote` still runs `gh repo view` once |
| GitHub without a token in the mod | `$.process.run(["gh", …])` with argv, no shell; `gh` keeps the token in its keyring. `gh issue list --state open --limit N --search "sort:updated-desc" --json …` takes one to two seconds per hundred issues without bodies; its field list has no comment count (`comments` carries full bodies), so counts and comments come from `gh issue view N --json …` per changed issue. For later: one GraphQL query returns a hundred open issues with latest comments and linked pull requests for four rate-limit points, a probe of numbers, update times and comment totals for one; a conditional REST request answered `304` is free; search has its own budget of thirty requests a minute |
| Host commands on the desktop | `$.process` is annotated "CLI only. Local execution, not a network path": read as *local sessions, not cloud or remote ones*. The desktop app hosts local sessions, and Doc Radar runs `git` through it there; `gh` on the desktop host's PATH on Windows is spike item S5 |
| Recaps | `$.model.complete({ model: "haiku", system, prompt, maxTokens, effort: "low" })`, billed to the session's credentials, with the four token counts in every result; `maxTokens` defaults to 1024; prompt caching does not engage at this prompt size and is not counted on; `$.model.classify(text, labels)` for triage labels |
| Memory | `$.state` for what the pane draws (survives a hot reload, the engine reloading the mod's code while the session runs); `$.store` for what outlives the session: one JSON file per plugin under `~/.claude/plugins/store/`, shared by every session, capped at 4 MiB in all, no version check (Doc Radar's store file holds about 750 KB today) |
| Timers and hot reload | `$.clock.every` timers are dropped on a hot reload, and both `register` and `session.start` run again for the reloaded plugin, so the timer is armed from `session.start` and guarded by a module-scoped handle, never by a `$.state` flag (which would survive the reload the timer did not); the live handle is re-checked on `session.attach` and `ui.render`. In a desktop-hosted session a kept folder named in `CLAUDE_CODE_PLUGIN_DIRS` is watched only with `CLAUDE_CODE_PLUGIN_DIR_WATCH=1` (a terminal session watches it anyway); the session's own mods folder is watched by default |
| Starting a desktop session | `$.mcp.call("ccd_session", "start_session", …)` without a permission prompt, or the typed `$.tool.call({ tool: "mcp__ccd_session__start_session", … })`, which runs through the permission check and its approval card (the desktop app's permission dialog for a tool call); **which of the two works from a mod is spike item S1**. `detach_session` (no approval card; only for sessions this session started that the user has not moved; refused for a side session that shares the starting session's worktree; unavailable in unattended sessions); `open_session_in` (only for sessions this session started, only while this session is on screen, not while the cursor is in a text field or terminal); `list_sessions` with `linked: true`; `get_session` for `self` or an id; `move_sessions` on another session asks the user in default mode, while a session can file, title and mark itself as `self` without a card |
| Reacting to the session | `tool.call` (a Bash command that ran `gh issue …` or `git push` triggers a refresh), `turn.complete`, `command.run` for the mod's commands, `config.set` for settings changed in the menu, `session.receive` for a message another session sent |
| Talking to the owner | `$.ui.toast` (a few seconds, dismissable), `$.ui.status` (the status line), the pane's own title, `$.prompt.fill` (write into the prompt box), `$.prompt.submit` (queue a prompt in this session). `$.ui.notify` reaches terminal notification channels only and answers *no surface* on the desktop. `$.ui.ask` raises the AskUserQuestion dialog, which the desktop draws as a card; whether a mod's own call reaches that card is spike item S7, so V1 confirms nothing through it |
| Settings | `userConfig` fields in `plugin.json` are installation-wide rows of the app's config menu and reach the module as `options`; a change reloads the mod. On 2.1.317 a `string` field with `options` is a picker over exactly those values; the 2.1.207 validator rejects the `options` key and knows only string, number, boolean, directory and file, and requires a title and a description per field. List-valued fields are unverified on both builds. Per-project values belong in the store |
| Quality gates | `claude plugin validate --strict` (present in 2.1.207) is the hard gate; `claude plugin test` ships with the engine build the desktop hosts but not with the 2.1.207 CLI, so tests run once the CLI is at least as new as the engine; a test answers `process.run`, `mcp.call` and `model.complete` with its own hooks beneath the plugin, mocks clock and store, and mounts the pane per surface; `tsc -p` against the engine-laid types |

## GitHub through `gh`

- `gh issue list --json` fields: assignees, author, blockedBy, blocking, body, closed,
  closedAt, closedByPullRequestsReferences, comments (full bodies), createdAt, id, isPinned,
  issueType, labels, milestone, number, parent, projectCards, projectItems, reactionGroups,
  state, stateReason, subIssues, subIssuesSummary, title, updatedAt, url. Filters:
  `--assignee`, `--author`, `--label`, `--milestone`, `--mention`, `--search`, `--type`.
- `gh issue view N --json …` offers the same fields per issue; `--comments` prints the thread
  for a reader.
- `gh search issues --assignee @me --state open --json repository,number,title,updatedAt,commentsCount`
  answers in about two seconds and uses the search budget (thirty requests a minute).
- `gh issue develop N` creates a branch linked to the issue (`--checkout`, `--name`,
  `--base`, `--list`); `gh issue comment`, `gh issue edit`, `gh issue close`,
  `gh issue create` are the write commands of later phases.
- GitHub Projects (v2) fields need the `read:project` scope; without it GraphQL answers an
  `INSUFFICIENT_SCOPES` error and `gh project` says `gh auth refresh -s read:project`.
- `gh auth status --json hosts` exits 0, names login, host, token source and scopes per host,
  and never prints the token; `gh help exit-codes`: 0 ok, 1 failure, 2 cancelled, 4 requires
  authentication.
- Rate limits are separate buckets: REST 5,000 an hour, GraphQL 5,000 points an hour,
  search 30 a minute.

## Maintenance

- Re-verify this file when the Claude Code build changes, and note the tested builds here
  and in the README.
- A fact that turns out wrong is corrected here and, where the design depended on it, in
  [`CONTEXT.md`](CONTEXT.md) in the same change.
