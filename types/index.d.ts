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
}

export type LinkedPr = { number: number; state: string; url: string }

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
}

/** The store's per-repository cache of the list. */
export type RepoCache = {
  fetchedAt: number
  rows: IssueRow[]
  meta: Record<string, IssueMeta>
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
    }
  }
}
