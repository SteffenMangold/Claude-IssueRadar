/** The language of the pane's labels and of the recaps. */
export type Language = 'de' | 'en'

/** The installation-wide options, as the manifest's userConfig declares them, with defaults applied. */
export type Options = {
  openAtStart: boolean
  /** Minutes between timed fetches while the pane is shown; 0 turns the timer off. */
  refreshMinutes: number
  /** Open issues listed per repository, the most recently updated first. */
  maxIssues: number
  /** Master switch for AI recaps; a repository still needs its one-time consent. */
  recaps: boolean
  /** Model alias for the recaps (`haiku`, `sonnet`). */
  recapModel: string
  language: Language
  /** How many days back each repository's collapsed "Recently closed" part reaches (E22); 0 hides it. Clamped to 0–90. */
  closedDays: number
  /** Whether the pane adds the collapsed "Assigned to me" section from GitHub search (E11). */
  assignedToMe: boolean
  /** Whether resting the pointer on an issue's number shows its card (E4, desktop). */
  hoverCards: boolean
  /** Whether issues that arrive while the pane is shown raise one toast per refresh (E5); the marks stay either way. */
  arrivalToasts: boolean
  /** E2: the `#` typeahead in the prompt box, and the context block for the open issues a sent prompt mentions. */
  issueMentions: boolean
}

/** E2: an issue this conversation already carries, and since when (the user turn it entered at). */
export type Attached = {
  /** `$.session.turns()` when it entered. */
  turn: number
  /** The issue's `updatedAt` it entered at; null when not known. */
  updatedAt: string | null
  /** A prompt's context block, an E6 tool answer, or a hand-off brief. */
  via: 'prompt' | 'tool' | 'brief'
}

/** E2: what this conversation carries, keyed by row key; entries of another conversation (`/clear`, a resume) count for nothing. */
export type AttachedRecord = {
  /** `$.session.id()` when the entries were made: a /clear goes on under another id. */
  conversation: string
  entries: Record<string, Attached>
}

/** A GitHub repository as `gh repo view` resolved it. */
export type RepoInfo = {
  /** `github.com`, or a GitHub Enterprise host. */
  host: string
  owner: string
  name: string
  url: string
  defaultBranch: string
  isPrivate: boolean
  hasIssues: boolean
  isArchived: boolean
  isFork: boolean
}

/** Why a repository shows no list, or that it does (`ok`). */
export type RepoStateKind =
  | 'ok'
  | 'loading'
  | 'no-git'
  | 'no-remote'
  | 'not-github'
  | 'signed-out'
  | 'gh-missing'
  | 'token-invalid'
  | 'no-access'
  | 'issues-disabled'
  | 'archived'
  | 'offline'
  | 'rate-limited'
  /** The token lacks a scope a field needs (GraphQL's INSUFFICIENT_SCOPES); `detail` names the scope. */
  | 'missing-scope'
  | 'error'

export type RepoState = {
  kind: RepoStateKind
  /** The host a sign-in concerns. */
  host?: string
  /** The first line of what `gh` said, for `error`; the repository asked for; or the missing scope, for `missing-scope`. */
  detail?: string
}

export type IssueLabel = { name: string; color: string }

/** Another issue a row relates to (a parent, a blocker, a sub-issue), possibly in another repository. */
export type IssueRef = {
  number: number
  /** `owner/name`, read from the issue's URL. */
  repo: string
  /** `OPEN` or `CLOSED`, as GitHub says it. */
  state: string
  /** The title, cut to 60 characters; empty where the store keeps none (a blocker). */
  title: string
  url: string
}

/** Done and all of an epic's sub-issues. */
export type IssueProgress = { completed: number; total: number }

/** What a row shows of an issue's relations (E17), from the list call; absent when there are none. */
export type IssueRelations = {
  parent: IssueRef | null
  /** The issue's own sub-issues, when it has any. */
  subIssues: IssueProgress | null
  /** Open blockers: how many, how many in all (closed ones too), and the first two open ones (no titles). */
  blockedBy: { open: number; total: number; refs: IssueRef[] }
}

/** The issue's place among other issues, read fresh for a brief (E17); the session's state only, never the store. */
export type IssueTree = {
  parent: IssueRef | null
  /** The parent's sub-issue progress. */
  parentProgress: IssueProgress | null
  /** The parent's other sub-issues, at most 10. */
  siblings: IssueRef[]
  /** The issue's own sub-issues, at most 20. */
  subIssues: IssueRef[]
  subProgress: IssueProgress | null
  blockedBy: IssueRef[]
  blocking: IssueRef[]
}

/** An issue's reactions (E4): GitHub's content name (`THUMBS_UP`, `HEART`, …) to how many reacted; only those above 0. */
export type Reactions = Record<string, number>

/** One open issue as the list call returns it. */
export type IssueRow = {
  number: number
  title: string
  url: string
  createdAt: string
  updatedAt: string
  author: string
  labels: IssueLabel[]
  assignees: string[]
  milestone: string | null
  isPinned: boolean
  /** Its parent, sub-issues and blockers (E17); absent when it has none, or the host does not answer them. */
  relations?: IssueRelations
  /** `REOPENED` on an open issue that was closed once (E5); absent otherwise. It stays for as long as the issue is open. */
  stateReason?: string
  /** Its reactions (E4); absent when it has none, and on rows stored before E4. */
  reactions?: Reactions
}

/** A pull request that will close an issue, as gh's view names it; `state` is empty there (gh sends none). */
export type LinkedPr = { number: number; state: string; url: string }

export type PrState = 'OPEN' | 'MERGED' | 'CLOSED'
export type PrReview = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED'
export type PrChecks = 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | 'EXPECTED'

/** A linked pull request with its state, from GraphQL (E3). */
export type PrLink = {
  number: number
  url: string
  /** `owner/name` of the pull request's repository. */
  repo: string
  state: PrState
  isDraft: boolean
  review: PrReview | null
  /** The head commit's check rollup; null when it has no checks. */
  checks: PrChecks | null
}

/** One repository's pull-request states (E3), the store's `prs:<repoKey>`: metadata only, no titles or bodies. */
export type PrRecord = {
  v: 1
  /** When the last sweep over the listed issues answered. */
  fetchedAt: number
  /** The newest `updatedAt` of the issues that sweep covered. */
  asOf: string
  /** Issue number to its linked pull requests (open and merged), at most 3; only issues with at least one. */
  rows: Record<string, PrLink[]>
  /** Issue number to how many pull requests reference it in all; only issues with at least one. */
  total: Record<string, number>
  /** The signed-in account's login on the host, as the request answered it (E5: the owner's own new issues are no news). */
  viewer?: string
}

/** The pull request the desktop app binds to an issue session (`ccd_pr` `get_status`); field names provisional (S14). */
export type SessionPr = {
  number: number
  url: string
  /** `owner/name`, read from the URL; empty when it names none. */
  repo: string
  state: PrState | 'DRAFT' | ''
  review: PrReview | null
  passed: number
  failed: number
  pending: number
  /** The failing checks' names, at most 5, each cut to 40 characters. */
  failing: string[]
  /** `MERGEABLE`, `CONFLICTING`, … as the app says it; empty when it says nothing. */
  mergeable: string
  /** When it was read. */
  at: number
  /** The session the app answered for: the row draws it only while its mapping names that session. */
  sessionId?: string
}

export type IssueComment = { author: string; createdAt: string; body: string }

/** What the per-issue details call adds to a row; `body` lives in the session's state only. */
export type IssueDetails = {
  /** The row's `updatedAt` these details belong to. */
  updatedAt: string
  state: string
  commentCount: number
  /** The latest comments, newest last, each cut to 600 characters. */
  comments: IssueComment[]
  /** The first 160 characters of the body, whitespace collapsed. */
  excerpt: string
  /** The body, cut to 6,000 characters; not persisted. */
  body: string
  linkedPrs: LinkedPr[]
  fetchedAt: number
  /** Parent, siblings, sub-issues and blockers, read for a brief only (E17); never in the store. */
  tree?: IssueTree
}

/** The small part of the details that the store keeps per issue. */
export type IssueMeta = {
  updatedAt: string
  commentCount: number
  excerpt: string
  linkedPrs: LinkedPr[]
  /**
   * When a list (the default one or a filtered one) last showed the issue (E14-1): beyond the listed rows the store
   * keeps the most recently shown, up to a bound, so a filter applied again costs no second read or recap.
   */
  seenAt?: number
}

export type RecapUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export type TriageKind = 'bug' | 'feature' | 'question' | 'other'
export type TriageSize = 'S' | 'M' | 'L'
export type TriageCriteria = 'stated' | 'partial' | 'missing'

/** E9: a small model's guess from the recap's own call: what the issue is, how large, how ready, what is missing. */
export type Triage = {
  kind: TriageKind
  /** Null when the text allows no estimate. */
  size: TriageSize | null
  /** Whether the issue states acceptance criteria. */
  criteria: TriageCriteria
  /** At most three short phrases in the owner's language, each at most 60 characters. */
  gaps: string[]
}

/** One recap, kept per issue and last-updated time. */
export type Recap = {
  updatedAt: string
  text: string
  model: string
  at: number
  usage: RecapUsage
  /** Set when the model gave no usable answer; `text` is then empty. */
  error?: string
  /** What the recap call asked (E9): 2 also asks the triage; absent reads 1 (V1). */
  v?: number
  /** The language the recap and the gaps are in (C-E9-5); absent on V1 recaps. */
  language?: Language
  /** E9's triage; absent on V1 recaps and when the answer carried none that holds. */
  triage?: Triage
}

/** E5: what the owner has seen of one repository, the store's `seen:<repoKey>`, shared by every session. */
export type SeenRecord = {
  v: 1
  /** When it was last written (the local clock). */
  at: number
  /** The newest `createdAt` (GitHub's time) among the issues the owner has seen. */
  newest: string
  /** Issue number to the `updatedAt` (GitHub's time) the owner last saw it at; the most recently updated, bounded. */
  rows: Record<string, string>
  /** The issues the owner saw while GitHub called them reopened (E5-2: the reason stays while the issue is open). */
  reopened?: Record<string, true>
}

/**
 * E5: a marked row seen in a look; its mark fades ten minutes later unless the issue changes again. Once faded, the
 * session's baseline takes it (`reopened`: GitHub called the issue reopened when the look saw it).
 */
export type Glimpse = { at: number; updatedAt: string; reopened?: true }

/** E5: why a row is marked. */
export type Mark = 'new' | 'updated' | 'reopened'

/** E5: the issue numbers of one repository this session has listed (each `true`). */
export type ListedNumbers = Record<string, true>

/** The issue session the pane started for an issue. */
export type Mapping = {
  sessionId: string
  title: string
  startedAt: number
  /** The id of the pane's session that started it. */
  startedFrom: string
  /** Whether the session was detached to the top level. */
  detached: boolean
  /**
   * The key of the checkout's repository as the starting pane resolved it (gh's choice, `upstream` in a fork), so the
   * issue session reads the project's lists and settings without gh (E2, R4-INT-2). Absent in mappings written before.
   */
  checkoutKey?: string
}

/** Per-repository choices, kept in the store under the checkout's resolved repository. */
export type RepoSettings = {
  /** Further repositories to watch, as `owner/name` or `host/owner/name`. */
  watch: string[]
  /** Recap consent per repository key; absent means not asked yet. */
  consent: Record<string, boolean>
  /** Sections the owner collapsed; `inbox` is E11's section, collapsed unless it is false. */
  collapsed: Record<string, boolean>
  /** The saved views (E14), at most 8. */
  views?: SavedView[]
  /** Whether rows show their GitHub Projects status (E18); off unless true. */
  boards?: boolean
  /** The repositories whose "Recently closed" part is expanded (E22), by section key. */
  showClosed?: Record<string, boolean>
}

/** How a filtered list is sorted (E14); `updated` is V1's order. */
export type FilterSort = 'updated' | 'created' | 'oldest' | 'comments' | 'reactions'

/** How the rows of a section are grouped (E14), drawn without a fetch. */
export type FilterGroup = 'none' | 'label' | 'milestone' | 'assignee'

/** The pane's one filter over every section (E14), the session's state only; the default lists as V1 does. */
export type Filter = {
  /** A built-in view (`open`, `mine`, `unassigned`, `recent`, `blocked`, `epics`) or a saved one's id (`custom:…`). */
  view: string
  /** The search as the owner typed it; sanitized before it reaches gh. */
  search: string
  /** A label name; empty for any. */
  label: string
  /** A milestone title; empty for any. */
  milestone: string
  sort: FilterSort
  group: FilterGroup
  /** E18's board facet, `<owner>/<project number>:<status>`; empty for any. Drawn without a fetch. */
  board: string
}

/** A named query the owner saved for the checkout's repository (E14). */
export type SavedView = { id: string; name: string; query: string }

/** What the label and milestone pickers offer (E14): seen in the default lists, the most frequent first. */
export type Facets = { labels: string[]; milestones: string[] }

/** One GitHub Projects (v2) item of an issue (E18): the project and the item's single-select Status. */
export type BoardItem = { owner: string; project: number; title: string; status: string | null }

/** Whether a host's token reads Projects (`present`), lacks the scope (`missing`), or has not said yet (`unknown`). */
export type BoardScope = 'present' | 'missing' | 'unknown'

/** E18's board status, the session's state only: moving a card does not change an issue's updatedAt. */
export type Boards = {
  scope: Record<string, BoardScope>
  /** Per host: the scope a missing-scope answer named. */
  needs: Record<string, string>
  /** Per host: the first line of the last failure other than a missing scope; gone once a read answers. */
  detail: Record<string, string>
  /** Per row key: the issue's items in open projects. */
  items: Record<string, BoardItem[]>
  fetchedAt: number | null
}

/** One issue assigned to the signed-in account, from GitHub search (E11): metadata only. */
export type InboxRow = {
  host: string
  /** `owner/name`. */
  repo: string
  number: number
  title: string
  url: string
  createdAt: string
  updatedAt: string
  commentCount: number
  labels: IssueLabel[]
}

/** E11's section as the pane draws it. */
export type Inbox = {
  host: string
  state: RepoState
  rows: InboxRow[]
  fetchedAt: number | null
  /** When what is drawn was decided: this pane's search answered or failed, or it took the store's record; absent before. */
  at?: number
}

/** The store's `inbox:<host>`, shared by every pane on the machine, so the search budget is spent once. */
export type InboxCache = {
  v: 1
  /** When the last search answered; 0 when none did. */
  fetchedAt: number
  rows: InboxRow[]
  /** When the last search ran, answered or not. */
  triedAt?: number
  /** No timed search before this (a failure's back-off). */
  retryAt?: number
  /** No search at all before this, ↻ included (a rate limit). */
  holdUntil?: number
  /** What the last search met when it failed (gh's state and first line, never a token); absent once one answers. */
  failed?: RepoState
}

/** A pull request that closed an issue, as gh names it (E22). */
export type ClosedPr = { number: number; url: string; repo: string }

/** One recently closed issue (E22): metadata only. */
export type ClosedRow = {
  number: number
  title: string
  url: string
  closedAt: string
  /** `COMPLETED`, `NOT_PLANNED`, `DUPLICATE`; empty for issues closed before GitHub kept a reason. */
  stateReason: string
  prs: ClosedPr[]
}

/** The store's `closed:<repoKey>` (E22): the newest closed issues of one window, replaced whole by each fetch. */
export type ClosedCache = {
  v: 1
  fetchedAt: number
  /** The UTC date the window starts on (`closed:>=`). */
  since: string
  /** The newest ten, by closing time. */
  rows: ClosedRow[]
  /** How many the fetch returned (at most 30). */
  count: number
}

/** One repository's section of the pane. */
export type Section = {
  /** `host/owner/name`. */
  key: string
  /** What the owner typed for a watched repository, or the checkout's name. */
  spec: string
  info: RepoInfo | null
  state: RepoState
  rows: IssueRow[]
  fetchedAt: number | null
  isCheckout: boolean
  /** The repository's open issues on GitHub when known (the probe's count, or an uncapped list's length; E7). */
  total?: number
  /** E14: the search a filtered list asked gh (`--search=<query>`); absent on the default list. */
  query?: string
  /** E14: which filter asked that list; the pane draws a section whose filter is not the current one as loading. */
  filterKey?: string
}

/** The store's per-repository cache of the list. */
export type RepoCache = {
  fetchedAt: number
  rows: IssueRow[]
  meta: Record<string, IssueMeta>
  /** The open issues on GitHub when known (E7). */
  total?: number
}

/** Which route started a desktop session, or that none did. */
export type StartRoute = 'mcp' | 'tool' | 'none'

declare module 'claude-code' {
  interface PluginState {
    'issue-radar': {
      sections: Shaped<Section[]>
      details: Shaped<Record<string, IssueDetails>>
      recaps: Shaped<Record<string, Recap>>
      mappings: Shaped<Record<string, Mapping>>
      settings: Shaped<RepoSettings>
      /** The row that is opened, as `host/owner/name#number`; empty for none. */
      opened: string
      /** Rows whose session start is in flight. */
      starting: Record<string, boolean>
      isRefreshing: boolean
      isSettingsOpen: boolean
      /** Recap tokens spent this session. */
      tokens: number
      version: string
      /** The checkout's resolved repository key; empty until resolved. */
      checkoutKey: string
      /** True in a session the pane started for an issue. */
      isIssueSession: boolean
      /** The route that last started a session, for the footer. */
      route: StartRoute
      /** Pull-request states per repository key (E3), mirrored from the store's `prs:`. */
      prs: Shaped<Record<string, PrRecord>>
      /** The pull request the app binds to each mapped issue session, by row key (E3); the session's memory only. */
      sessionPrs: Shaped<Record<string, SessionPr>>
      /** The pane's filter (E14): survives a hot reload, starts at the default in each new session. */
      filter: Shaped<Filter>
      isFilterOpen: boolean
      /** What the label and milestone pickers offer (E14). */
      facets: Shaped<Facets>
      /** Bumped when the filter clears its search, so the search field is drawn afresh, empty (E14-4). */
      searchGen: number
      /** E18's board status per row and the hosts' scope verdicts; never in the store. */
      boards: Shaped<Boards>
      /** E11's section. */
      inbox: Shaped<Inbox>
      /** E22's recently closed issues per repository key, mirrored from the store's `closed:`. */
      closed: Shaped<Record<string, ClosedCache>>
      /** E22: when a repository's closed list started loading; a display flag only (a reload leaves it, so it ages out). */
      closedLoading: Record<string, number>
      /** E22: the last failure per repository key, drawn above the last good rows. */
      closedErrors: Shaped<Record<string, RepoState>>
      /** E5: per repository key, the seen record as it stood when this session first listed it; marks compare against it. */
      seenBase: Shaped<Record<string, SeenRecord>>
      /** E5: per row key, when a look first saw the row's mark at its update time. */
      glimpsed: Shaped<Record<string, Glimpse>>
      /** E5: per repository key, the issue numbers this session has listed; an issue never listed before may be an arrival. */
      listed: Shaped<Record<string, ListedNumbers>>
      /** E2: the issues this conversation already carries (context blocks, E6 answers, a brief), the newest 100. */
      attached: Shaped<AttachedRecord>
    }
  }
}
