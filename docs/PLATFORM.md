# Platform facts

> **TL;DR for AI agents:** the verified facts about the Claude Code **2.1.317** function-hook
> API and its test kit, the desktop app's session tools, `gh` **2.96.0** and GitHub's GraphQL
> API that Issue Radar 0.2.0 relies on, each with how it was verified. Load it when a task
> touches one of these mechanisms; re-verify it when a build changes. What is still unproven
> is listed under [Not verified yet](#not-verified-yet) with its spike id, and in the
> [spike table](CONTEXT.md#assumptions-to-prove-the-spike). Product behaviour lives in
> [`CONTEXT.md`](CONTEXT.md), not here.

## Builds and sources

Verified between 2026-11-06 and 2026-11-07 against:

- **Engine 2.1.317**: its function-hook declarations (`claude-code.d.ts`) and `reference.md`,
  as the plugin-authoring skill lays them out; its own CLI, `claude.exe` 2.1.317, which the
  desktop app keeps under `%APPDATA%\Claude\claude-code\2.1.317\<hash>\`, for
  `plugin validate --strict` and `plugin test`; and the engine binary where the declarations
  are silent.
- **The desktop app's tools**, as their descriptions read through ToolSearch and in the tool
  index a loaded mod sees (`.claude-plugin/types/claude-code-mcp/`, inputs only), and the
  installed **desktop app 4.23118** (its `app.asar` and `ion-dist.asar` bundles).
- **gh 2.96.0** against github.com: live read-only calls on public repositories (mostly
  `cli/cli`), `GH_DEBUG=api` captures where gh's own request mattered, GraphQL introspection,
  gh's help texts, and gh's source for write paths. No write was ever run to verify a fact.
- The `claude` on the owner's PATH is **2.1.207**: it has no `plugin test`, and its validator
  knows an older manifest schema (it rejects a `userConfig` field's `options` key). It is used
  for nothing.

Each fact ends with how it was verified:

| Tag | Means |
|---|---|
| [d.ts] | stated by the 2.1.317 declarations or `reference.md` |
| [kit] | exercised in the 2.1.317 test kit; a test of this repository pins it |
| [validate] | printed by `claude plugin validate --strict` (2.1.317) |
| [binary] | read in the 2.1.317 engine binary, or grepped in the desktop app's bundles |
| [schema] | the desktop tool's own description |
| [live] | a live read-only call with gh 2.96.0 (sizes, costs and times are single runs) |
| [GH_DEBUG] | gh's own request, seen with `GH_DEBUG=api` (token lines filtered) |
| [introspection] | GraphQL schema introspection, read-only |
| [help], [source] | gh's help text; gh's source code |
| [rule] | a load rule every module of 0.2.0 is written to keep; neither the 2.1.317 declarations nor `reference.md` state it, so only the modules' loading bears it out |
| [measured] | timed on the owner's machine (Windows, a 4-core laptop) |
| [V1] | verified for 0.1 and not contradicted since |

Rows and bullets without a tag carry over from 0.1's verification.

The function-hook API is **early access and moves between releases**.

## The mod API

| Capability | What holds on 2.1.317 |
|---|---|
| Loading a module | `$` reaches code outside a hook only as an argument of a top-level `function` declaration (a closure may capture `$` and pass it into one), every call on `$` is spelled at its call site (never a method or noun bound to a variable), no dynamic `import()`, no DOM, no Node, JSX against the global `h`; a module that breaks one does not load [rule]; `reference.md` states the last four [d.ts]. `validate` traces `$` through such functions (`$.clock.every (via armPhaseSync, armTimer)`) [validate]. `$.state.get` names `plugin` and `key` as literals [d.ts] |
| A sidebar pane | `$.ui.open({ id, title, columns })`, drawn by a `ui.render` hook for the `Pane` component. An open asked for by the person (a command, a prompt, a press) is placed at any width; one made unasked (session start, a timer) waits undrawn on a terminal narrower than 144 columns (110 once the person opened that id and has not closed it by hand) and, on any surface, until a client that places panes is attached [d.ts]. The desktop client attaches after `session.start`, so an open made there answers `isPlaced: false` and is placed when the client attaches; `$.session.surfaces()` is empty until then [V1]. Opening an open id delivers the new title and never a second instance; only `focus` raises it [d.ts]. The title is drawn only as the tab label while more than one pane is open; a control character in it is refused [d.ts]; whether the desktop shows it is S34. `$.ui.panes()` lists the plugin's own open panes: `isShown` for the one pane the surface shows, `isPlaced` false while it waits; with no surface attached every row is unshown and unplaced [d.ts] |
| Drawn trees | A text child, Link label, Button label, Code source, language or path, or Svg alt holding a C0 control other than tab, LF and CR, DEL, a C1 control, a lone surrogate, the kitty image placeholder U+10EEEE, or U+2800 followed by a kitty diacritic (297 combining marks, U+0305 among them) gets the whole tree refused; so does a text child or Link label (not a Button label) that opens with such a diacritic [binary, kit]. A Select's option values and current value are checked the same way [kit]. A refused pane tree is not drawn and the pane is closed (`… refused: <reason>; … the pane was closed`) [d.ts, kit]. A lone surrogate that the plugin's own `.slice()` leaves behind never reaches that check: it arrives in the drawing as U+FFFD and draws [d.ts, kit]. No tree is refused for the length of its texts: a site draws the first 100,000 characters in the order written, hidden text included, and a Button or Select whose label would not be drawn whole gives way. What names a thing is held to a length that refuses the tree past it: 2,048 characters for a Link's address, 10,000 for a Select value [d.ts] |
| Desktop elements | `Box`, `Text`, `Button`, `Input`, `Select`, `Svg`, `Link`, `Code`, `Markdown`; a list row is one `Button` with text children. The mobile table has no `Input` or `Select` [d.ts, kit]. `Select` draws on desktop and terminal in the kit [kit]; how it draws in the desktop app is S31. `Input`: `value` is what the field holds when drawn, and the person's typing replaces it until the hook draws another; Enter submits; `rows` of 2 or more make it multi-line, a newline typed as in the prompt box [d.ts]; a redraw with the same `value` and the desktop's newline key are S26. `Link` has no `key` prop; a blank `href` is drawn plain and the tree stands; on the desktop it is an anchor [d.ts, kit]. Hover: a keyed Box is a hover scope; a child drawn `display: none` with `hover: { display: flex }` shows while the pointer rests on the scope; a `position: absolute` Box paints over the elements before it, is clipped by its site, and the pointer on it counts as on its parent. No hook runs on hover, and there is no tooltip prop (only an interactive `Svg`'s `<title>`) [d.ts] |
| The session's repository | `gh repo view --json nameWithOwner,isPrivate,hasIssuesEnabled,isArchived,isFork,url,defaultBranchRef,viewerPermission` in the project root is the authority. Exit 4 means *signed out* (of that host); *no remote*, *not a GitHub host* and *not a repository* all exit 1 and are told apart only by their messages (`no git remotes found`, `none of the git remotes … point to a known GitHub host`, `not a git repository`). A clone with `origin` and `upstream` resolves to the upstream repository without a prompt; `gh repo set-default` changes that [live]. `$.session.repo()` answers null outside a git repository; its `remote` names `origin` only, so for a fork clone it names the fork while gh answers the upstream [V1] |
| Running gh and git | `$.process.run(argv, { cwd, env, stdin, timeoutMs })`: argv, no shell; `env` is set over the host process's own environment; `stdin` is written, then closed; 30 s by default, ten minutes at most, then the child is killed and the call rejects; stdout and stderr are each cut at 4 MiB [d.ts]. The test kit hands the test exactly that `init` [kit]. gh keeps the token in its keyring; the mod never handles one. `gh issue list --state open --limit N --search "sort:updated-desc" --json …` takes one to two seconds per hundred issues without bodies [live] |
| Host commands on the desktop | `$.process` is annotated "CLI only. Local execution, not a network path": read as *local sessions, not cloud or remote ones*. The desktop app hosts local sessions, and Doc Radar runs `git` through it there; `gh` on the desktop host's PATH on Windows is spike item S5 |
| Model calls | `$.model.complete({ model, system, prompt, maxTokens, effort, timeoutMs })`, billed to the session's credentials, with the four token counts in every result. `maxTokens` defaults to 1024 and is held to 64,000 (a provider ends such a request at ten minutes); the request has no JSON mode or response schema, so a structured answer is parsed from text; a `$` call's time never counts against the calling hook's budget, and `timeoutMs` (default none) bounds it [d.ts]. Prompt caching does not engage at a recap's prompt size [V1]. `$.model.fork({ prompt })` runs one tool-less completion over the session's own transcript as the main thread last sent it: every tool denied, the prefix served from the API's cache and billed afresh once the entry lapsed or after `/model`; it answers `nothing-to-fork` before the first request and after `/clear` [d.ts]; its answer on the desktop host is S27. `$.model.classify(text, labels)` picks a label |
| A tool for the model | `$.tool.register({ name, description, inputSchema, isDeferred })` declares `mcp__<plugin>__<name>` from the next prompt on; it rejects until the session binds at `session.start`; a name registered again is replaced; `isDeferred: true` puts it behind ToolSearch [d.ts]. A registration in the first, awaited `session.start` is listed by turn one [d.ts]; the engine resolves a registration that is not yet among the session's tools after a wait (about 8 s), and one a deny rule withholds, all the same [binary], so `$.tool.list()` is the authority on whether the model can call it [d.ts]. A `tool.call` hook on that name serves it by answering without `next`. The permission prompt and the `tool.check` chain run beneath the `tool.call` hooks (`next(e)` runs the hooks beneath, then core), so a serving hook skips them; managed-settings hooks' deny comes before every hook [d.ts]. A `$.tool.check` query runs the `tool.check` hooks but no PreToolUse hook and no classifier, carries no `tool_use_id`, and its verdict names no `hook` [d.ts, kit]. So a serving hook that asks `$.tool.check` itself is governed by `permissions.deny` (the tool is withheld), a `permissions.ask` rule, another plugin's `tool.check` and an organization ceiling, never by a user's or project's PreToolUse hook on the tool or by auto mode's classifier [d.ts]. A desktop-hosted session lists the bundled plugin-authoring mod's `mcp__plugin-authoring__scan_secrets` among its tools, so that host adds a plugin's tool at run time (seen through ToolSearch); for this mod's own tool see S18 |
| Prompts | `prompt.submit` sees each prompt with `origin.kind`, a closed set [d.ts]. The engine stamps a host's human message `composer` (`bridge` under Remote Control), an unstamped `sdk` source `sdk`, and typed, queued, suggestion-accepted and system prompts `unclassified` [binary]; only `composer` (the user's own gesture, as the engine stamped it) and `bridge` (the user's message through Remote Control) attest a person; `peer` is another session's message delivered as a turn of its own, and an origin's `plugin` is the sender's claim, never a guard [d.ts]. Which kind the desktop's typed prompt carries is S16. Context blocks a hook adds after the prompt stay in the conversation [d.ts]. `prompt.autocomplete` runs only while a plugin hooks it; the engine parses the `ui_prompt_autocomplete` ask (surface default `desktop`) [binary], but the desktop app 4.23118 never sends it: 0 hits in `app.asar` and `ion-dist.asar`, which carry `ui_prompt_edit`, `ui_prompt_fill`, `ui_prompt_read`, `ui_prompt_suggest` and `ui_prompt_paint`, each through a handler of its own [binary]. So a mod's typeahead rows show in the terminal only (S12). `$.prompt.fill` writes into the prompt box, `$.prompt.read` reads it, `$.prompt.submit` queues a prompt in this session |
| Commands | `command.run` carries where the run came from in `prompt.submit`'s words (`origin.kind`), `{ kind: 'plugin', name }` for another plugin's `$.command.run`, which is queued and runs once the session is idle [d.ts] |
| The session | `$.session.id()` is the transcript file's name [d.ts]. `/clear` ends the conversation and the process goes on under a new id with no `session.start`; `session.end` fires on exit, `/clear`, resume and logout, its reason naming which [d.ts]. `$.session.turns()` counts the prompts the user sent this session; `$.session.messages()` reads the transcript; `$.session.usage()`'s context figure is absent until the first response of the live window; `$.session.model()` names the model [d.ts]. `session.compact` carries `trigger` (`manual`, `auto`, `plugin`) and the transcript being compacted; a precompute is a dispatch of its own; a subagent's compaction carries its `agentId` [d.ts] |
| Turns, dialogs, classic events | `turn.start` fires before a turn's first model call, `turn.complete` when it ended; `agentId` is set for a subagent or a teammate and absent on the main loop; a hook that heard a turn's start hears its end after it [d.ts]. A question dialog is the `AskUserQuestion` tool call (one to four questions), plan approval `ExitPlanMode` [d.ts]. `classic.<Event>` fires wherever the engine runs that classic hook, configured or not, among them `classic.PermissionRequest` (`tool_name`, `tool_input`, no `tool_use_id`) [d.ts]; whether it fires in desktop-hosted sessions is S30. A hook that fails is skipped and the chain goes on, so a guard fails open unless its registration's `.catch` answers; a `.catch` handler's `next` is replay-safe (when the hook had called it, `next(e)` resolves to that call's result and nothing beneath runs again) [d.ts] |
| Memory | `$.state` holds what the pane draws and survives a hot reload; a `get` while drawing subscribes the pane, a `set` redraws every reader; a reload that names another shape tag finds the value absent [d.ts]. Every `get` of one dispatch reads one moment, whatever is written meanwhile, also across tasks: an attach that awaited an identification another dispatch began still read the older value [d.ts, kit]. `$.store` holds what outlives the session: one JSON file per plugin identity under `~/.claude/plugins/store/`, shared by every session of that identity (a development copy and the installed plugin keep separate files, seen in that folder), with no version check; `set` rejects a function, a cycle, or a store over 4 MiB of JSON text in all [d.ts]. Nothing is said about concurrent writers (S36). Doc Radar's store file holds about 750 KB |
| Timers and hot reload | `$.clock.every` timers are dropped on a hot reload, and both `register` and `session.start` run again for the reloaded plugin, so a timer is armed from `session.start` and guarded by a module-scoped handle, never by a `$.state` flag (which would survive the reload the timer did not); the live handle is re-checked on `session.attach` and `ui.render`. A hot reload cancels the plugin's pending waits with the old environment [d.ts]. In a desktop-hosted session a kept folder named in `CLAUDE_CODE_PLUGIN_DIRS` is watched only with `CLAUDE_CODE_PLUGIN_DIR_WATCH=1` (a terminal session watches it anyway); the session's own mods folder is watched by default |
| The desktop's tools, two routes | `$.mcp.call(server, tool, args)`: positional; no permission prompt (the plugin's call is the grant); answers `content` blocks and `isError`, plus `structuredContent` only where the tool declares an output schema; it states no timeout, so only the caller's own race on `$.clock` bounds it [d.ts]. `$.tool.call({ tool: 'mcp__<server>__<tool>', ...args })`: the call the engine makes for the model, under a `tool_use_id` of its own, through every hook but the calling one, the permission check and its dialog, then the tool; it rejects for an unknown tool [d.ts]. Its reserved `consent` key reaches the hooks unchanged [kit]. A typed answer whose record holds only `content` blocks carries no structured data [d.ts]. `$.tool.check` asks the verdict and runs nothing [d.ts]. Which route reaches the app's tools from a mod is spike item S1; the wording of a transport failure on the mcp route is S35. The tools themselves: [The desktop app's tools](#the-desktop-apps-tools) |
| Reacting to the session | `tool.call` sees this session's own tool calls (a Bash command's text among them), the main loop's and its subagents' (`agentId`); `turn.complete`; `command.run` for the mod's commands; `config.set` for settings changed in the menu; `session.receive` for a message another session sent [d.ts] |
| Messages between sessions | Only a hook in the receiving engine consumes a delivery [d.ts]; a session in a different permission mode holds cross-session messages for its user's approval, and for a desktop session nothing reports back [schema]. Issue Radar sends none |
| Talking to the owner | `$.ui.toast` (a few seconds, dismissable). `$.ui.status(text)`: one line per plugin under the prompt, its first 2,000 characters drawn (10,000 remotely), `undefined` clears it [d.ts]; whether the desktop draws it is S19. The pane's own title (tab label only, above). `$.ui.log` writes a dim transcript line that is not sent to the model, or with `{ to: 'debug' }` the debug log alone [d.ts]. `$.ui.notify` reaches terminal notification channels only and answers *no surface* on the desktop. `$.ui.ask` raises the AskUserQuestion dialog; whether a mod's own call reaches the desktop's card is S7, and Issue Radar confirms nothing through it |
| Pane scroll, focus, selection | `$.ui.scroll({ in, to: { key }, block })` scrolls a site of the plugin, raised as `ui.scroll` with origin `plugin`; `$.ui.focus({ requestId, key })` moves the focus ring while the site holds the keys, awaiting an element not yet drawn, bounded [d.ts]. The person's own scroll or focus move raises `ui.scroll` or `ui.focus` with origin `person`; the engine reports a pane's window only as `props.scroll` (`offset`, `bodyRows`), never which rows are on screen [d.ts]. On the desktop, the person's events are S17 and the mod's own scroll S32. `$.ui.selection()` answers the person's last mouse selection, `undefined` where none is seen [d.ts]. A `ui.press` carries the surface it came from [d.ts, kit] |
| Settings | `userConfig` fields in `plugin.json` are installation-wide rows of the app's config menu and reach the module as `options`; a change reloads the mod. On 2.1.317 a `string` field with `options` is a picker over exactly those values; the 2.1.207 validator rejects the `options` key. List-valued fields are unverified (S8). A test passes values with `test(name, { options }, body)`, read as stored settings: a value outside a field's options unset, defaults filled in, then validated [d.ts]. Per-project values belong in the store |

## The desktop app's tools

What the tools' descriptions say, as far as Issue Radar relies on it [schema]. The laid index
holds inputs only, so the shape of an answer is unverified unless the spike measured it. Where
a description says the app asks the user first, the asking follows the permission mode (auto
mode may decide, bypass never asks): it is the typed route's card, and `$.mcp.call` raises no
permission prompt [d.ts], so nothing promises a question on that route (S2 observes it).

| Tool | What its description says |
|---|---|
| `ccd_session.start_session` | `initiation: 'user_asked'` starts at once and returns the id; `prompt` (the brief) is required. `context: 'fresh'` (default) also needs `background`, at least 80 characters; `context: 'fork'` carries this whole conversation and ignores `background`, and from a worktree session gets a fresh worktree cut from this session's branch tip (from a plain checkout it shares the folder). `use_worktree` (fresh only): `false` shares this checkout, in a worktree session its worktree, branch and pull request. `branch_name`: a slug the app gives the user's branch prefix and a suffix. `model` (fresh only): same family or cheaper, a higher one ignored; `effort` at or below the caller's. The app continues the caller when the session ends its turn, whether or not `wake_when_done` is set |
| `ccd_session_mgmt.detach_session` | No approval card. Only for a session this session started that the user has not moved; a session the user placed (a fork, a task chip) is refused, as is a side session that shares another session's worktree; unavailable in unattended sessions |
| `ccd_session_mgmt.get_session` | `self` or an id: the fields of a listing entry plus model, effort, worktree and branch, `group`, `pinned`, and for a session started from another `parentSessionId` with `detached` |
| `ccd_session_mgmt.list_sessions` | Leaves out the current session; `limit` (default 20, most recent first); `include_archived` (default false); `linked: true` lists the session's own family. `name` and `startedBy` only on linked sessions; `group` is null when ungrouped and the key is missing while no window has reported groups (unknown, not ungrouped); a missing `pinned` means not pinned. No state field is documented (S13, S20) |
| `ccd_session_mgmt.unarchive_session` | Usually no prompt for a session this session started; for any other the app asks first (auto mode may decide). A local session re-acquires a removed worktree on its next turn |
| `ccd_session_mgmt.set_session_title` | A title the user set asks before it is replaced; a title the app generated is replaced without asking |
| `ccd_window.open_session_in` | Targets `split`, `window`, `focus`; only for `self` or a session this session started; acts only while this session is on screen, and otherwise changes nothing and says so ("don't retry"); an already visible target is a no-op. `focus` is refused while the cursor is in a text field or a terminal (the refusal belongs to that target) |
| `ccd_window.get_window_layout`, `close_split` | The layout, read-only: split-view panes with their session ids, pop-out windows, where this session shows. `close_split` closes a split this session opened |
| `ccd_view.get_layout` | An empty `views` list means the session is open nowhere |
| `ccd_sidebar.list_sections` | Per section `{id, kind, name, order, session_count, group_by, sort_by, ascending, collapsed, shown}`; `shown` false for a section the user switched off; fails while no app window is open |
| `ccd_sidebar.list_groups`, `create_group` | Groups in sidebar order; fails while no window has reported groups (unknown, not empty). `create_group` makes an empty group |
| `ccd_sidebar.move_sessions`, `set_unread` | Moving any session but this one asks first in default mode. Moving a pinned session into a group unpins it; when the sidebar is not grouped to show custom groups, it switches to a grouping that does. `set_unread` sets or clears the blue dot |
| `ccd_pr.get_status` | `{ session_id }`: the pull request bound to a session and its checks, from the app's cache; nothing is documented for a session without one (S14) |

## GitHub through `gh`

- `gh issue list --json` fields: assignees, author, blockedBy, blocking, body, closed,
  closedAt, closedByPullRequestsReferences, comments (full bodies), createdAt, id, isPinned,
  issueType, labels, milestone, number, parent, projectCards, projectItems, reactionGroups,
  state, stateReason, subIssues, subIssuesSummary, title, updatedAt, url; no comment count.
  Filters: `--assignee`, `--author`, `--label`, `--milestone`, `--mention`, `--search`,
  `--type` [help].
- Open issues answer `stateReason` `""` (99 of 100 on `cli/cli`) or `"REOPENED"`;
  `reactionGroups` lists only the reactions someone used [live].
- `closedByPullRequestsReferences` in gh's JSON carries `id`, `number`, `repository` and `url`,
  no state, and gh leaves closed, unmerged pull requests out (`cli/cli#9789`: one of five);
  on a closed issue it lists the merged pull request that closed it [live].
- Relations: `--json parent,subIssuesSummary,blockedBy` (list) and
  `parent,subIssues,subIssuesSummary,blockedBy,blocking` (view) answer `parent` null or
  `{id, number, state, title, url}`, `subIssuesSummary {completed, percentCompleted, total}`,
  `blockedBy {nodes, totalCount}`; gh pages `blockedBy` by 50 [live, GH_DEBUG]. The three list
  fields add about 3.6 KB per 30 rows in the same time; `blocking` can name another
  repository's issue [live].
- `--search`: gh sends one GraphQL `search(type: ISSUE_ADVANCED)` request with the query
  `( <text> ) repo:<repo> state:<state> type:issue`, so it costs GraphQL points, not the REST
  search budget [GH_DEBUG]. On `cli/cli` [live]: a `repo:` in the text cannot widen the scope;
  `is:closed` in the text overrides `--state open` (closed rows come back); `is:pr` exits 1
  ("cannot use pull request search qualifiers"); `is:draft` and `is:merged` leak pull requests
  as number-0 nodes; a dangling `label:bug OR` answers nothing; `--search=-label:x` as one
  argument works (a leading `-` is no flag). Accepted: `assignee:@me`, `no:assignee`,
  `updated:>=<date>`, `is:blocked`, `has:sub-issue` (singular; the plural is silently
  ignored), `parent-issue:owner/name#n`, `label:"…"`, `milestone:"…"`, `type:Bug`,
  `linked:pr`, `closed:>=<date>`, `sort:updated-desc`, `sort:comments-desc`,
  `sort:created-asc`, `sort:reactions-+1-desc`. Search cannot sort by closing time.
- `gh issue list --state closed --limit 10 --search "closed:>=<date> sort:updated-desc"`
  answers in about one second with about 2 KB; a closed issue's `stateReason` is `COMPLETED`,
  `NOT_PLANNED` or `DUPLICATE` (`""` on old issues) [live].
- `gh issue view N --json …` offers the same fields per issue; `--comments` prints the thread
  for a reader. A number that does not exist exits 1 with "GraphQL: Could not resolve to an
  issue or pull request with the number of N."; a pull request's number answers that pull
  request, its `url` holding `/pull/` [live].
- `gh search issues` uses the REST search budget, one request a call:
  `--assignee @me --state open --archived=false --sort updated --order desc --limit N --json
  repository,number,title,url,updatedAt,createdAt,commentsCount,labels,isPullRequest` [help];
  pull requests come only with `--include-prs` [help]. `--assignee @me --state open --json
  repository,number,title,updatedAt,commentsCount` answers in about two seconds [live].
- `gh pr list --head <branch> --state all` takes the bare branch name: `--head
  remotes/origin/<branch>` answers `[]` [live].
- `gh repo view <repo> --json viewerPermission` names the viewer's role (`READ` on `cli/cli`)
  in the same call [live].
- `gh api repos/<owner>/<name>/git/ref/heads/<branch>` answers the branch's sha, or HTTP 404
  and exit 1 when GitHub has no such branch [live]. `gh label list -R … --json name,color
  --limit 100`; `gh api user --jq .login` (`--hostname` off github.com) [help].
- The write commands (flags from gh 2.96.0's help; none was run to verify): `gh issue comment
  N -R … --body-file -` (the text on stdin); `gh issue edit N -R … --add-label/--remove-label
  <name>` (each takes a comma-separated list) and `--add-assignee/--remove-assignee @me`;
  `gh issue close N -R … --reason completed|"not planned"|duplicate`, `--duplicate-of <n>`,
  `-c/--comment <text>` (close has no body file, so a closing comment travels in argv);
  `gh issue create -R … --title … --label … --assignee @me --body-file -`;
  `gh issue develop N -R … --name <branch> [--branch-repo <repo>]` (also `--base`,
  `--checkout`, `--list`) [help].
- `gh issue close` with `--comment` posts the comment before the close mutation; on an issue
  already closed it prints "is already closed", exits 0 and posts no comment [source:
  `pkg/cmd/issue/close/close.go`].
- `gh issue develop` creates a new branch linked to the issue from a remote branch [help];
  GitHub has no mutation that links an existing branch: `createLinkedBranch` needs the base
  commit's `oid`, and the only other one is `deleteLinkedBranch` [introspection].
- GitHub closes an issue by itself when a pull request with a closing reference merges into the
  default branch (`cli/cli#14814`, closed as `COMPLETED` by #14815) [live]; until the list
  catches up, the issue still reads open.
- GitHub Projects (v2) fields need the `read:project` scope [live]: `gh issue list --json
  projectItems` exits 1 with "GraphQL: Your token has not been granted the required scopes to
  execute this query. The 'id' field requires one of the following scopes: ['read:project']";
  `gh api graphql` exits 1 with errors of type `INSUFFICIENT_SCOPES` on stdout and
  `gh: Your token has not been granted …` on stderr; `gh project list` answers "your
  authentication token is missing required scopes [read:project]" and "To request it, run:
  gh auth refresh -s read:project". `rateLimit(dryRun: true)` does not get past the check;
  `projectItems { totalCount }` is readable without the scope; `projectCards` (classic
  projects) fails with a deprecation notice.
- `gh auth status --json hosts` exits 0, names login, host, token source and scopes per host,
  and prints no token unless `--show-token`; `gh help exit-codes`: 0 ok, 1 failure, 2
  cancelled, 4 requires authentication [live].
- Environment [help]: `GH_TOKEN`/`GITHUB_TOKEN` serve github.com and `*.ghe.com`,
  `GH_ENTERPRISE_TOKEN`/`GITHUB_ENTERPRISE_TOKEN` an Enterprise Server host; `GH_HOST` names
  the host for a command that names none and cannot infer one from the checkout.
- Rate limits are separate buckets: REST 5,000 an hour, GraphQL 5,000 points an hour,
  search 30 a minute; a conditional REST request answered `304` is free.

## GitHub's GraphQL API through `gh api graphql`

- Arguments [help]: strings go with `-f` (raw); `-F` types integers and booleans, but reads a
  file for a value starting with `@` and fills `{owner}`, `{repo}` and `{branch}` from the
  current checkout. `--hostname` defaults to github.com. Every field but `query` and
  `operationName` is a variable. `--input -` fails on Windows (cli/cli#14959), so the query
  travels in argv, which a Windows command line holds to 32,767 characters.
- Answers [live]: an alias that misses (a number that does not exist, or a pull request's
  number asked as an issue) exits 1 with `data` (that alias null) and an error of type
  `NOT_FOUND` whose `path` is `['repository', '<alias>']`, stderr `gh: Could not resolve to an
  Issue with the number of …`: partial data, usable. A field that does not exist exits 1 with
  `errors` only, no `data`: `extensions.code` `undefinedField`, a path into the query, and
  "Field '…' doesn't exist on type 'Issue'". A missing scope answers `INSUFFICIENT_SCOPES`
  (above); exit 4 is signed out.
- `rateLimit { cost remaining resetAt }` rides in any query; `remaining` is eventually
  consistent (three reads in a row: 4933, 4971, 4932) [live].
- Measured on `cli/cli` [live]:

  | Query | Points | Size | Time |
  |---|---|---|---|
  | Probe: open count, top 30 by update (number, updatedAt, comment total) | 1 | 2.8 KB | 0.8 s |
  | The same with each issue's pull requests (state, draft, review, checks) | 1 | 4.9 KB | 1.5 s |
  | Probe, top 100 | 1 | 8.1 KB | 1.3 s |
  | Probe, top 100, with pull requests | 4 | 15.4 KB | 2.6 s |
  | Rows, details, pull requests and relations of 3 issues by alias | 1 | 23.9 KB | 1.4 s |
  | Top 30 rows with relations | 1 | 15.4 KB | |
  | Top 100 rows with relations | 3 | 54.7 KB | |
  | Pull requests of 100 issues by alias | 4 | 5.3 KB of argv | 2.1 s |
  | `viewer { login }` beside `repository` and `rateLimit`, a 40-issue window | 1 in all | | |

- `closedByPullRequestsReferences` without `includeClosedPrs` lists open and merged pull
  requests only, as gh does (`cli/cli#9789`: #14679 open, a draft, review required, checks
  passing; with `includeClosedPrs: true` five) [live]. It lists the references oldest first
  (`microsoft/TypeScript#64438`, `home-assistant/core#50340`), so `last: n` reads the newest;
  `orderByState: true` puts `MERGED` before `OPEN` before `CLOSED`; `totalCount` counts them
  all [live]. A pull request's `statusCheckRollup` can be null (no checks) [live]. The same
  fragment asks `mergedAt` and `baseRefName` (when and into which branch it merged); their
  share of the cost was not measured.
- `stateReason` is null on an open, never-closed issue (gh's list says `""`); its values are
  `REOPENED`, `NOT_PLANNED`, `COMPLETED`, `DUPLICATE` [live, introspection].
  `reactionGroups { content users { totalCount } }` is accepted (not refused as deprecated)
  and lists all eight reactions, zeros included; `reactors { totalCount }` gives the same
  counts [live].
- `linkedBranches` takes `first`/`last`/`after`/`before`; a deleted branch's node answers
  `ref: null`; one issue can carry dozens (93 seen) [live, introspection].
- The board query (`projectItems(first, includeArchived)` with
  `fieldValueByName(name: "Status")`) drew only `INSUFFICIENT_SCOPES` on its fields from a
  token without `read:project`, no parse or unknown-field error, when it was designed [live];
  the answer with the scope is unmeasured (S33).

## git through `$.process.run`

From git's documentation, used as stated; the kit pins the argv only:
`git --no-optional-locks status` never takes the index lock a git command of the session may
need; in a linked worktree `git rev-parse --git-dir` differs from `--git-common-dir`
(`--path-format=absolute` makes both comparable); `GIT_TERMINAL_PROMPT=0` and
`GCM_INTERACTIVE=never` keep git and its credential manager from prompting.

## The test kit (`claude plugin test`, 2.1.317)

- It runs the plugin's `*.test.ts(x)` files against the engine itself. A test holds the
  engine's `$` and an `on` whose hooks sit beneath the plugin and stand for the engine: nothing
  sits beneath them but the kit's own bottom for `$.state`, `ui.invalidate` and
  `session.append`, so every call the plugin makes must be answered by a test hook, else it
  throws naming its event [d.ts]. A UI test mounts the pane on a surface it names (`terminal`,
  `desktop`, `mobile`) and acts by key [d.ts].
- **Time**: a test fails once it outlasts 5,000 ms, wall clock, unless `test(name,
  { timeoutMs }, body)` gives it more [d.ts]. Issue Radar's harness exports a `test` that
  gives each test 20 s (a test's own options still win), and every test file uses it. The kit compiles
  the plugin's hooks graph again for every test (0.3–0.6 s alone, up to 1.4 s for a file's
  first tests) and runs several files at once (eight on the owner's machine), so that load
  counts against each test's limit. The full suite, 402 tests in 11 files, took 104.5 s on
  2026-11-07 and 99 to 144 s in the three runs before; under load, or with two runs at once,
  tests of any file timed out at random under the default [measured]. With 20 s per test,
  three full runs in a row on 2026-11-07 passed 402/402 each, the slowest test at 4.3, 5.2
  and 6.1 s. Still run the gates one at a time.
- What a test can raise and answer [kit]: every op the plugin calls is a test event (`ui.log`,
  `ui.status`, `session.messages`, `session.model`, `session.usage`, `session.turns`,
  `tool.register`, `model.fork`, `ui.selection`, `process.run` with its `init`); the plugin's
  `turn.start`/`turn.complete` hooks need a bottom answering `{ turnId }`/`{ text }`; a test's
  `$.tool.call` reaches the plugin's `tool.call` hooks (with `agentId` when given; a dialog
  tool's matcher hook too); a typed `$.tool.call` raises the test's `tool.check` with a
  `tool_use_id`, a `$.tool.check` query without one, its `input` the call's arguments; the
  test's `$` raises `prompt.autocomplete` at run time though its types (`EventCalls`) do not
  list it; a test's `$.ui.scroll`/`$.ui.focus` (origin `person`) raises the plugin's hooks;
  `ui.input` with `kind: 'change'` reaches `onInput`, the default `submit` reaches `onSubmit`,
  `ui.select` reaches `onSelect`; `$.session.compact` refuses `messages: []`; a test hook that
  throws on `tool.register` makes `$.tool.register` reject.
- How acts settle [kit]: a `ui.press` resolves while its handler sleeps on the mocked clock (a
  loading line is observable); an event the test raises (`$.session.attach`) waits for hooks
  that await such a sleep until the test advances the clock. A press on a Button no longer
  drawn throws ("no Button … is drawn"). `$.ui.mount` rejects when the plugin's tree is refused
  ("drew nothing … a tree Pane refuses: <reason>"). A mounted drawing keeps the `now` of its
  last draw: what depends on time alone changes at the next redraw.
- How elements are found [kit]: `find` matches a text string by inclusion (`geändert` finds
  `geänderten`), so tests find marks, pills and badges by key; a Box's found `text` is the
  concatenated text beneath it; the kit never paints, so a Text inside a `display: none` card
  is found too, and `children` carries the hidden card's description; a Select's
  `props.options` lists its values as drawn.
- What the kit cannot exercise [kit]:
  - a plugin's own `$.ui.scroll` (S32): nothing implements it beneath, the call rejects with "no
    implementation for ui.scroll", and no test hook is raised for it;
  - a `mcp.call` hook that throws reaches the plugin as "no implementation for mcp.call", not
    the thrown text, so a transport failure's wording (S35) can be pinned only as an `isError`
    answer;
  - a test registers each event once (`on("model.complete") registered twice` keeps the module
    from loading);
  - a test's `$` has no `state` noun: an atom is read only through what the plugin draws or
    sends;
  - the kit keeps the module across a re-run `session.start`, so a hot reload (module memory
    lost, a changed option) cannot be set up;
  - no painting and no text frame: widths, clipping, paint order, opacity and hover are
    counted from the drawn tree or not at all;
  - the desktop app's tools, gh, git and the model answer only what the test makes them answer.

## `claude plugin validate --strict` (2.1.317)

- It ends with `✔ Validation passed`. For each hooks module it prints the hooks with their
  matchers, the gating hooks with and without `.catch`, the `$` calls with the top-level
  functions they go through, and the state each module reads and writes [validate].
- A matcher's value is printed only when it is a literal: an imported constant prints
  `tool.call{tool=?}` [validate].
- Each list line is cut after about 1,000 characters (`… [+1016 chars]`), the `--json` report
  too, so calls late in the list (`$.ui.status` among them) are not printed [validate].
- Its plugin-directory checks warn `ICON_MISSING` (accepted) and say that they apply none of
  the directory's rules for a hooks module [validate].

## Type check

A strict TypeScript check against the 2.1.317 declarations: `tsc -p` where the engine laid
`.claude-plugin/types/`; on this branch, a script that compiles `hooks/`, `types/` and `tests/`
against `claude-code.d.ts` (strict, `noUncheckedIndexedAccess`, ES2023, JSX factory `h`).
A tool answer's type has an answered arm (`isError` absent) and an error arm (`isError: true`,
required); a value typed `isError?: true` matches neither [d.ts].

## Not verified yet

Each open question carries its spike id from the
[spike table](CONTEXT.md#assumptions-to-prove-the-spike); most are measured by
`/issue-radar spike` (its line named), the rest by hand. Run the spike and the live checks
with the same installed build in both sessions: the store is kept per plugin identity, so a
development copy and the installed plugin never see each other's records.

| Id | Open question | How it is measured |
|---|---|---|
| S1 | Whether a mod's `$.mcp.call` reaches the app's `ccd_*` tools (the start, and quiet reads such as `get_session` for `self`) or only the typed `$.tool.call` does, and whether the result names the new session's id | Spike: the start lines, `get_session self (quiet, via mcp\|tool)` |
| S2 | Whether an approval card shows for the mod's calls in default mode, on either route | By hand, default and auto mode |
| S3 | Whether the app continues the pane's session after each turn of a session it started, and whether the mod's `detach_session` prevents that | Spike: `detach_session: …`, then by hand |
| S4 | Whether the start's id, the child's `$.session.id()`, the listing's id and `get_session` for `self` agree; whether the brief is the child's first message | Spike: `session ids: engine …, desktop …` |
| S5 | `gh` on the desktop host's PATH on Windows; its latency | The pane lists, or names `gh` missing |
| S6 | Where the desktop sends a click on a `Link` | By hand |
| S7 | Whether a mod's own `$.ui.ask` reaches the desktop's question card | By hand (unused) |
| S8 | List-valued `userConfig` fields | A trial manifest |
| S11 | Whether `claude plugin uninstall` removes the store file, and what `--keep-data` means for it | A trial uninstall |
| S12 | Answered for the desktop app 4.23118, which never sends `ui_prompt_autocomplete`; re-check after each desktop update | Grep both bundles; type `#` in the desktop composer |
| S13 | The vocabulary of a session's `state` in the listing | S20's line |
| S14 | Whether `ccd_pr.get_status` answers a mod's `$.mcp.call` without a card, whether the mapped ids are the app's, and the answer's field names | Spike: `get_status <id> (quiet, via mcp)` |
| S15 | The hover card's paint order, opacity (`inverseText` ground) and clipping in light and dark themes, above and right of the number, at 46 columns | By hand |
| S16 | Which `origin.kind` the desktop stamps on a typed prompt | Spike: `last prompt origin:` |
| S17 | Whether the desktop raises `ui.scroll` and `ui.focus` with origin `person` for a pane body, and how well a layout estimate matches its row heights | By hand |
| S18 | Whether the desktop host lists this mod's `issue` tool; that the model's call shows no card in default mode, `permissions.ask` makes it refuse, `permissions.deny` withholds it, and a user's or project's PreToolUse hook on it never fires (a managed-settings hook still runs first) | Spike: `issue tool:`; the permission cases by hand |
| S19 | Whether the desktop draws a plugin's `$.ui.status` line | The spike session shows `Issue-Radar-Spike` (German) or `Issue Radar spike` (English) |
| S20 | What `list_sessions` entries hold (keys, state words, a pull-request field); whether an archived session is absent without `include_archived` and found by `get_session`; whether `name` and `startedBy` survive a detach; what `open_session_in` and `unarchive_session` answer | Spike: `list_sessions (quiet, via mcp)` |
| S21 | In a desktop-hosted issue session: whether `turn.start`, `turn.complete` and the AskUserQuestion / ExitPlanMode `tool.call` reach the mod with no `agentId` on the main loop, and whether `$.session.messages()` holds the brief as the first user message | By hand, with the spike's `session ids` line |
| S22 | What `list_sections` answers in the classic and the sections layout, what `list_groups` answers, whether `get_session` for `self` carries `group` and `pinned`, whether `get_layout` answers `views: []` for a session open nowhere; whether the app already dots a finished, off-screen session | Spike: `sidebar (quiet, mcp only)` |
| S23 | Whether `start_session` takes the aliases `sonnet` and `haiku` (or wants the app's model ids), and whether an effort above the caller's is refused or ignored | Spike: a second start with `haiku`, `low` |
| S24 | Whether `start_session { context: 'fork' }` from a mod starts from a worktree session, whether the fork can be detached, whether a linked fork wakes the pane's session after each turn, and whether a fork's `$.session.messages()` holds the carried transcript | By hand |
| S25 | Whether `open_session_in { target: 'split' }` right after a start shows the session, whether the detach keeps the split, what a refusal looks like, and whether `get_window_layout` names the split session's id | Spike: `open_session_in split`, the layout line |
| S26 | Whether an `Input` keeps typed text across a redraw that draws the same `value`, and which key types a newline in a multi-row `Input` on the desktop | By hand |
| S27 | Whether `$.model.fork` answers on the desktop host or says there is nothing to fork, and how much of the prefix the prompt cache serves | By hand: the draft's cost line |
| S28 | Whether the app's listing or `get_session` names a session's worktree branch, and whether the branch exists when `start_session` returns | The key lists of the spike's `list_sessions` and `get_session self` lines |
| S29 | Whether `gh issue develop --name <branch> --branch-repo <checkout repo>` for an issue of another repository needs rights in the issue's repository | By hand |
| S30 | Whether `classic.PermissionRequest` fires in desktop-hosted sessions, and whether it fires for AskUserQuestion and ExitPlanMode there | By hand inside an issue session |
| S31 | How `Select` draws and picks in the desktop app at 46 columns | By hand |
| S32 | Whether a mod's own `$.ui.scroll` to a key scrolls the desktop pane to a row drawn a moment ago (the kit cannot exercise it) | By hand; a debug line says when both tries were refused |
| S33 | The board request's answer with a token that has `read:project`: its shape and cost | The first run with the scope |
| S34 | Whether the desktop shows the pane title (`Issues (n)`) as a tab label while more than one pane is open | By hand, with two panes open |
| S35 | The wording `$.mcp.call` uses for an unknown or disconnected server | The reason in any `… not read (<reason>)` spike line |
| S36 | Whether two sessions writing different store keys within a second both keep their writes | By hand |

Open, without a spike id:

- Which changes leave an issue's `updatedAt` as it was (pinning, reactions, project status,
  perhaps relation edits), and whether a branch link moves it.
- GitHub Enterprise Server: schemas without the relation fields, without the arguments of
  `closedByPullRequestsReferences`, or without `stateReason` on Issue; and whether gh's list
  error names the failing path (`(repository.issues.nodes.0.parent)`).

Answered: S9 (`claude plugin test` ships with the engine's own CLI, not with the 2.1.207
CLI), S10 (two remotes resolve to the upstream; `--search "sort:updated-desc"` is accepted).

## Maintenance

- Re-verify this file when the Claude Code build, the desktop app or gh changes, and note the
  tested builds here and in the README.
- A fact that turns out wrong is corrected here and, where the design depended on it, in
  [`CONTEXT.md`](CONTEXT.md) in the same change; an answered spike item moves from
  [Not verified yet](#not-verified-yet) into the sections above, with how it was verified.
