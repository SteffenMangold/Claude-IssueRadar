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
}

export type RecapUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
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
}

/** The issue session the pane started for an issue. */
export type Mapping = {
  sessionId: string
  title: string
  startedAt: number
  /** The id of the pane's session that started it. */
  startedFrom: string
  /** Whether the session was detached to the top level. */
  detached: boolean
}

/** Per-repository choices, kept in the store under the checkout's resolved repository. */
export type RepoSettings = {
  /** Further repositories to watch, as `owner/name` or `host/owner/name`. */
  watch: string[]
  /** Recap consent per repository key; absent means not asked yet. */
  consent: Record<string, boolean>
  /** Sections the owner collapsed. */
  collapsed: Record<string, boolean>
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
    }
  }
}
