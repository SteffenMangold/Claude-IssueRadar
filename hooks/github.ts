// GitHub through the signed-in `gh`: the repository of a checkout, the open
// issues of a repository, and the details of one issue. The mod never sees a
// token; every failure becomes a named state.
import type { EngineInterface } from 'claude-code'

import type { IssueComment, IssueDetails, IssueMeta, IssueProgress, IssueRef, IssueRelations, IssueRow, IssueTree, LinkedPr, RepoInfo, RepoState, RepoStateKind } from '../types'

export const LIST_FIELDS = 'number,title,url,createdAt,updatedAt,author,labels,assignees,milestone,isPinned'
/** What a row shows of an issue's relations (E17); gh pages blockers by 50, as the GraphQL row does. */
export const LIST_RELATIONS = 'parent,subIssuesSummary,blockedBy'
export const VIEW_FIELDS = 'number,state,body,comments,updatedAt,closedByPullRequestsReferences,url'
/** The issue's tree for a brief (E17): its parent, its sub-issues and both directions of blocking. */
export const TREE_FIELDS = 'parent,subIssues,subIssuesSummary,blockedBy,blocking'
/** What the parent read asks: its sub-issues are the siblings. */
export const PARENT_FIELDS = 'number,title,state,subIssues,subIssuesSummary'
const REPO_FIELDS = 'nameWithOwner,isPrivate,hasIssuesEnabled,isArchived,isFork,url,defaultBranchRef'
export const BODY_CHARS = 6_000
export const EXCERPT_CHARS = 160
export const COMMENT_CHARS = 600
export const COMMENTS_KEPT = 3
/** A related issue's title as a row keeps it (the store holds it). */
export const REF_TITLE_CHARS = 60
/** A related issue's title as a brief's tree quotes it. */
export const TREE_TITLE_CHARS = 80
/** The relation field names gh or GraphQL name when a host lacks them (an older GitHub Enterprise). */
export const RELATION_FIELD = /\b(?:parent|subIssues|subIssuesSummary|blockedBy|blocking)\b/

/**
 * Failures the relation fields cannot cause: asking again without them would only double the call. Everything else
 * (a refused node in another organization, a field the host lacks, an answer gh calls an error) is asked once more
 * without them (E17-1). A missing scope is in this set too: the relation fields need none beyond the issues' own.
 */
const NOT_THE_RELATIONS: ReadonlySet<RepoStateKind> = new Set<RepoStateKind>(['signed-out', 'token-invalid', 'rate-limited', 'offline', 'gh-missing', 'missing-scope'])

/** How long a repository goes without relations after a failure that did not name them: most likely a blip (E17-1). */
export const RELATIONS_PAUSE_MS = 30 * 60_000

/**
 * The repositories (by key) whose list failed with the relation fields and was asked again without them, and until when they
 * go without: for the rest of the module's life when gh's failure named a relation field (a host without them, a
 * related issue the token may not read), else for half an hour. A reload, or `/issue-radar reset`, tries them again.
 */
const relationsOff = new Map<string, number>()

export function hasRelations(info: Pick<RepoInfo, 'host' | 'owner' | 'name'>, now: number): boolean {
  const until = relationsOff.get(repoKey(info))

  return until === undefined || now >= until
}

/** Lists and fetches this repository without relation fields until `until` (for good when not given). */
export function dropRelations(info: Pick<RepoInfo, 'host' | 'owner' | 'name'>, until = Number.POSITIVE_INFINITY): void {
  relationsOff.set(repoKey(info), until)
}

export function resetRelations(): void {
  relationsOff.clear()
}

/**
 * What a gh call came to. A failure keeps what the process wrote to stdout and its exit code when it ran at all:
 * `gh api graphql` exits 1 with partial data on stdout, which a caller may still use.
 */
export type GhResult = { ok: true; stdout: string } | { ok: false; state: RepoState; stdout?: string; stderr?: string; exitCode?: number }

export type GhOptions = {
  cwd?: string
  /** Variables set over the host's own environment (`GH_HOST` for a search on another host); never a token. */
  env?: Record<string, string>
  host?: string
  repo?: string
  timeoutMs?: number
}

/** `owner/name` or `host/owner/name`; a leading dash would reach gh as a flag, not a repository. */
export function isRepoSpec(spec: string): boolean {
  return !spec.startsWith('-') && /^(?:[\w.-]+\/)?[\w.-]+\/[\w.-]+$/.test(spec)
}

type Json = Record<string, unknown>

export function repoKey(repo: Pick<RepoInfo, 'host' | 'owner' | 'name'>): string {
  return `${repo.host}/${repo.owner}/${repo.name}`.toLowerCase()
}

/** What `-R` takes: `owner/name` on github.com, `host/owner/name` elsewhere. */
export function repoSpec(repo: Pick<RepoInfo, 'host' | 'owner' | 'name'>): string {
  return repo.host === 'github.com' ? `${repo.owner}/${repo.name}` : `${repo.host}/${repo.owner}/${repo.name}`
}

export function repoLabel(repo: Pick<RepoInfo, 'host' | 'owner' | 'name'>): string {
  return `${repo.owner}/${repo.name}`
}

/** The host of a repository as the owner typed it (`host/owner/name`), else github.com. */
function hostOfSpec(spec: string): string {
  const parts = spec.split('/').filter(part => part !== '')

  return parts.length >= 3 && parts[0] !== undefined && parts[0].includes('.') ? parts[0] : 'github.com'
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map(line => line.trim()).find(line => line !== '') ?? ''
}

/**
 * The scope a scope wall names: `['read:project']` in GitHub's GraphQL message, `[read:project]` in `gh project`'s;
 * null when the text names none.
 */
export function scopeIn(text: string): string | null {
  return /(?:following scopes|required scopes):?\s*\[\s*'?([\w:-]+)'?/i.exec(text)?.[1] ?? null
}

/** Names the failure: the exit code first (4 is signed out), then what gh said. */
export function classify(exitCode: number, stderr: string, host: string, repo: string): RepoState {
  const said = stderr.toLowerCase()
  if (exitCode === 4) return { kind: 'signed-out', host }
  if (said.includes('not a git repository')) return { kind: 'no-git' }
  if (said.includes('no git remotes found')) return { kind: 'no-remote' }
  if (said.includes('known github host')) return { kind: 'not-github' }
  if (said.includes('bad credentials') || said.includes('http 401')) return { kind: 'token-invalid', host }
  // A token without a scope a field needs: GraphQL's INSUFFICIENT_SCOPES text, or gh's own for `gh project`.
  if (said.includes('has not been granted the required scopes') || said.includes('missing required scopes')) {
    return { kind: 'missing-scope', host, detail: scopeIn(stderr) ?? 'read:project' }
  }
  if (said.includes('rate limit')) return { kind: 'rate-limited', host }
  if (
    said.includes('dial tcp') ||
    said.includes('error connecting') ||
    said.includes('no such host') ||
    said.includes('tls handshake') ||
    said.includes('network is unreachable') ||
    said.includes('i/o timeout') ||
    said.includes('connection refused')
  ) {
    return { kind: 'offline', host }
  }
  if (said.includes('could not resolve to a repository') || said.includes('not_found') || said.includes('http 404')) {
    return { kind: 'no-access', host, detail: repo }
  }
  if (said.includes('to get started with github cli') || said.includes('gh auth login')) return { kind: 'signed-out', host }

  return { kind: 'error', host, detail: firstLine(stderr) || `exit ${exitCode}` }
}

function classifyThrow(error: unknown): RepoState {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  if (message.includes('enoent') || message.includes('not found') || message.includes('not recognized') || message.includes('cannot start')) {
    return { kind: 'gh-missing' }
  }
  if (message.includes('timed out') || message.includes('timeout')) return { kind: 'offline' }

  return { kind: 'error', detail: firstLine(error instanceof Error ? error.message : String(error)) }
}

/** Runs gh with the given arguments; `host` and `repo` only name the state a failure gets. */
export async function gh($: EngineInterface, args: readonly string[], options: GhOptions = {}): Promise<GhResult> {
  try {
    // Only variables a caller names go on top of the host's environment: gh prompts nothing without a TTY,
    // and the host's PATH must stay as it is (Doc Radar's precedent).
    const ran = await $.process.run(['gh', ...args], { cwd: options.cwd, timeoutMs: options.timeoutMs ?? 30_000, ...(options.env === undefined ? {} : { env: options.env }) })
    if (ran.exitCode === 0) return { ok: true, stdout: ran.stdout }

    return { ok: false, state: classify(ran.exitCode, ran.stderr, options.host ?? 'github.com', options.repo ?? ''), stdout: ran.stdout, stderr: ran.stderr, exitCode: ran.exitCode }
  } catch (error) {
    return { ok: false, state: classifyThrow(error) }
  }
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

export function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** The `login` of an author or assignee record; `?` when there is none. */
export function loginOf(value: unknown): string {
  return isRecord(value) ? asString(value['login'], '?') : '?'
}

/** The `nodes` of a GraphQL connection (or a gh list that answers one); empty when it is none. */
export function nodesOf(value: unknown): unknown[] {
  return isRecord(value) && Array.isArray(value['nodes']) ? (value['nodes'] as unknown[]) : []
}

/** A count GraphQL or gh answered: a whole number not below zero, else null. */
export function countOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

const str = asString
const login = loginOf

function parseRepo(text: string): RepoInfo | null {
  const json = parseJson(text)
  if (typeof json !== 'object' || json === null) return null
  const data = json as Json
  const nameWithOwner = str(data['nameWithOwner'])
  const [owner, name] = nameWithOwner.split('/')
  const url = str(data['url'])
  const host = (() => {
    try {
      return new URL(url).host.toLowerCase()
    } catch {
      return 'github.com'
    }
  })()
  if (owner === undefined || name === undefined || owner === '' || name === '') return null
  const branch = data['defaultBranchRef']

  return {
    host,
    owner,
    name,
    url,
    defaultBranch: typeof branch === 'object' && branch !== null ? str((branch as Json)['name'], 'main') : 'main',
    isPrivate: data['isPrivate'] === true,
    hasIssues: data['hasIssuesEnabled'] !== false,
    isArchived: data['isArchived'] === true,
    isFork: data['isFork'] === true,
  }
}

/** Resolves the repository of the checkout at `root`; `$.session.repo()` null means no git repository at all. */
export async function resolveCheckout($: EngineInterface, root: string): Promise<{ info: RepoInfo | null; state: RepoState }> {
  const repo = await $.session.repo().catch(() => null)
  if (repo === null) return { info: null, state: { kind: 'no-git' } }
  const ran = await gh($, ['repo', 'view', '--json', REPO_FIELDS], { cwd: root, timeoutMs: 30_000 })
  if (!ran.ok) return { info: null, state: ran.state }
  const info = parseRepo(ran.stdout)
  if (info === null) return { info: null, state: { kind: 'error', detail: 'gh repo view answered no repository' } }

  return { info, state: stateOf(info) }
}

/** Resolves a repository the owner named (`owner/name` or `host/owner/name`). */
export async function resolveNamed($: EngineInterface, spec: string): Promise<{ info: RepoInfo | null; state: RepoState }> {
  const host = hostOfSpec(spec)
  // Flags first, then `--`: gh stops flag parsing there, so a stored spec can only ever be the repository.
  const ran = await gh($, ['repo', 'view', '--json', REPO_FIELDS, '--', spec], { host, repo: spec, timeoutMs: 30_000 })
  if (!ran.ok) return { info: null, state: ran.state }
  const info = parseRepo(ran.stdout)
  if (info === null) return { info: null, state: { kind: 'error', detail: 'gh repo view answered no repository' } }

  return { info, state: stateOf(info) }
}

/** A repository that cannot list issues, or `ok`. */
export function stateOf(info: RepoInfo): RepoState {
  if (info.isArchived) return { kind: 'archived', detail: repoLabel(info) }
  if (!info.hasIssues) return { kind: 'issues-disabled', detail: repoLabel(info) }

  return { kind: 'ok' }
}

/** `host` and `owner/name` of an issue's or a pull request's URL (`https://host/owner/name/issues/n`); null when it names none. */
export function repoOfUrl(url: string): { host: string; repo: string } | null {
  try {
    const parsed = new URL(url)
    const [owner, name] = parsed.pathname.split('/').filter(part => part !== '')
    if (owner === undefined || name === undefined) return null

    return { host: parsed.host.toLowerCase(), repo: `${owner}/${name}` }
  } catch {
    return null
  }
}

/** A related issue from `{ number, state, title, url }`, its title cut to `titleChars` (0 keeps none); null when it is none. */
export function refOf(node: unknown, titleChars: number = REF_TITLE_CHARS): IssueRef | null {
  if (!isRecord(node)) return null
  const number = Number(node['number'])
  if (!Number.isInteger(number) || number <= 0) return null
  const url = asString(node['url'])

  return { number, repo: repoOfUrl(url)?.repo ?? '', state: asString(node['state']).toUpperCase(), title: titleChars > 0 ? collapse(asString(node['title'])).slice(0, titleChars) : '', url }
}

/** `{ completed, total }` of a `subIssuesSummary`; null when it counts no sub-issue. */
export function progressOf(value: unknown): IssueProgress | null {
  if (!isRecord(value)) return null
  const total = countOf(value['total'])
  if (total === null || total === 0) return null

  return { completed: Math.min(total, countOf(value['completed']) ?? 0), total }
}

/**
 * What a row shows of an issue's relations, from gh's list fields or the GraphQL row (same shapes): the parent, the
 * sub-issue progress, and the open blockers (counted, the first two kept without titles). Undefined when there is
 * nothing to show, so the store keeps nothing for most rows.
 */
export function parseRelations(data: Json): IssueRelations | undefined {
  const parent = refOf(data['parent'])
  const subIssues = progressOf(data['subIssuesSummary'])
  const blockers = nodesOf(data['blockedBy'])
    .map(node => refOf(node, 0))
    .filter((ref): ref is IssueRef => ref !== null)
  const open = blockers.filter(ref => ref.state === 'OPEN')
  if (parent === null && subIssues === null && open.length === 0) return undefined
  const total = Math.max(countOf(isRecord(data['blockedBy']) ? data['blockedBy']['totalCount'] : undefined) ?? 0, blockers.length)

  return { parent, subIssues, blockedBy: { open: open.length, total, refs: open.slice(0, 2) } }
}

/** One row from an issue record whose labels and assignees are lists (gh) or connections (GraphQL). */
function rowOf(data: Json): IssueRow | null {
  const number = Number(data['number'])
  if (!Number.isInteger(number) || number <= 0) return null
  const listed = (value: unknown): unknown[] => (Array.isArray(value) ? value : nodesOf(value))
  const labels = listed(data['labels'])
    .filter(isRecord)
    .map(label => ({ name: str(label['name']), color: str(label['color']) }))
    .filter(label => label.name !== '')
  const assignees = listed(data['assignees'])
    .map(login)
    .filter(name => name !== '?')
  const milestone = data['milestone']
  const row: IssueRow = {
    number,
    title: str(data['title']),
    url: str(data['url']),
    createdAt: str(data['createdAt']),
    updatedAt: str(data['updatedAt']),
    author: login(data['author']),
    labels,
    assignees,
    milestone: isRecord(milestone) ? str(milestone['title']) || null : null,
    isPinned: data['isPinned'] === true,
  }
  const relations = parseRelations(data)
  if (relations !== undefined) row.relations = relations

  return row
}

function parseRows(text: string): IssueRow[] | null {
  const json = parseJson(text)
  if (!Array.isArray(json)) return null

  return json.filter(isRecord).map(rowOf).filter((row): row is IssueRow => row !== null)
}

/** One issue of the GraphQL Row fragment (E7, with E17's relations when asked) as a row; null when it is none. */
export function parseGraphRow(node: unknown): IssueRow | null {
  return isRecord(node) ? rowOf(node) : null
}

/**
 * The open issues of a repository, the most recently updated first, pull requests excluded by gh itself. Asks the
 * relation fields too (E17), unless this repository failed with them before: a list that fails with them for any
 * reason they could cause is asked once more without them (E17-1), and the repository lists without them for good if
 * gh's failure named a relation field, else for half an hour, whether that second list answers or fails as well.
 */
export async function listIssues($: EngineInterface, info: RepoInfo, limit: number): Promise<{ rows: IssueRow[] } | { state: RepoState }> {
  const now = await $.clock.now()
  const withRelations = hasRelations(info, now)
  const args = (fields: string) => ['issue', 'list', '-R', repoSpec(info), '--state', 'open', '--limit', String(Math.max(1, limit)), '--search', 'sort:updated-desc', '--json', fields]
  let ran = await gh($, args(withRelations ? `${LIST_FIELDS},${LIST_RELATIONS}` : LIST_FIELDS), { host: info.host, repo: repoLabel(info) })
  if (!ran.ok && withRelations && !NOT_THE_RELATIONS.has(ran.state.kind)) {
    const said = ran.stderr ?? ran.state.detail ?? ''
    const isNamed = RELATION_FIELD.test(said)
    ran = await gh($, args(LIST_FIELDS), { host: info.host, repo: repoLabel(info) })
    // Remembered whether the list without them answers or fails as well: a failure that lasts (a 5xx, an outage) then
    // costs one call per refresh, as in V1, not two, and the fields are asked again once the half hour is over.
    dropRelations(info, isNamed ? Number.POSITIVE_INFINITY : now + RELATIONS_PAUSE_MS)
    $.ui.log(
      `issue-radar: ${repoLabel(info)} lists without relations ${isNamed ? 'from now on' : 'for 30 minutes'}${ran.ok ? '' : ', and failed without them too'} (${said.replace(/\s+/g, ' ').slice(0, 200)})`,
      { to: 'debug' },
    )
  }
  if (!ran.ok) return { state: ran.state }
  const rows = parseRows(ran.stdout)
  if (rows === null) return { state: { kind: 'error', detail: 'gh issue list answered no JSON' } }

  return { rows: rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }
}

export function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** The first `max` characters of a body, markup softened, cut at a word. */
export function excerptOf(body: string, max = EXCERPT_CHARS): string {
  const plain = collapse(
    body
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/[*_`>]/g, ''),
  )
  if (plain.length <= max) return plain
  const cut = plain.slice(0, max)
  const space = cut.lastIndexOf(' ')

  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`
}

/**
 * The pull requests that will close an issue, from gh's list or a GraphQL connection's nodes: one reader for both
 * paths (E7-1). gh's items carry no state, so theirs is empty; nobody draws an empty state as `()`.
 */
export function linkedPrsOf(items: readonly unknown[]): LinkedPr[] {
  return items
    .filter(isRecord)
    .map(pr => ({ number: Number(pr['number']), state: str(pr['state']).toUpperCase(), url: str(pr['url']) }))
    .filter(pr => Number.isInteger(pr.number) && pr.number > 0)
}

function commentOf(comment: Json): IssueComment {
  return { author: login(comment['author']), createdAt: str(comment['createdAt']), body: collapse(str(comment['body'])).slice(0, COMMENT_CHARS) }
}

/** What the store keeps of an issue's details: no body, no comments. */
export function metaOf(details: IssueDetails): IssueMeta {
  return { updatedAt: details.updatedAt, commentCount: details.commentCount, excerpt: details.excerpt, linkedPrs: details.linkedPrs }
}

/** The issue's tree from gh's view with the tree fields; undefined when it relates to nothing. Titles cut for the brief. */
export function parseTree(data: Json): IssueTree | undefined {
  const refs = (value: unknown, max: number) =>
    nodesOf(value)
      .map(node => refOf(node, TREE_TITLE_CHARS))
      .filter((ref): ref is IssueRef => ref !== null)
      .slice(0, max)
  const parent = refOf(data['parent'], TREE_TITLE_CHARS)
  const subIssues = refs(data['subIssues'], 20)
  const blockedBy = refs(data['blockedBy'], 10)
  const blocking = refs(data['blocking'], 10)
  if (parent === null && subIssues.length === 0 && blockedBy.length === 0 && blocking.length === 0) return undefined

  return { parent, parentProgress: null, siblings: [], subIssues, subProgress: progressOf(data['subIssuesSummary']), blockedBy, blocking }
}

function parseDetails(text: string, row: IssueRow, now: number, hasTree: boolean): IssueDetails | null {
  const json = parseJson(text)
  if (!isRecord(json)) return null
  const data = json
  const body = str(data['body'])
  const comments: IssueComment[] = Array.isArray(data['comments']) ? (data['comments'] as unknown[]).filter(isRecord).map(commentOf) : []
  const linked = data['closedByPullRequestsReferences']
  const details: IssueDetails = {
    updatedAt: str(data['updatedAt']) || row.updatedAt,
    state: str(data['state'], 'OPEN'),
    commentCount: comments.length,
    comments: comments.slice(-COMMENTS_KEPT),
    excerpt: excerptOf(body),
    body: body.slice(0, BODY_CHARS),
    linkedPrs: linkedPrsOf(Array.isArray(linked) ? linked : nodesOf(linked)),
    fetchedAt: now,
  }
  const tree = hasTree ? parseTree(data) : undefined
  if (tree !== undefined) details.tree = tree

  return details
}

/**
 * One issue of the GraphQL Details fragment (E7's tier 2): the body, the last comments with the exact total, and the
 * pull requests that will close it, open and merged ones only, as gh's view lists them (E7-1).
 */
export function parseGraphDetails(node: unknown, row: IssueRow, now: number): IssueDetails {
  const data = isRecord(node) ? node : {}
  const body = str(data['body'])
  const comments = nodesOf(data['comments']).filter(isRecord).map(commentOf)
  const total = countOf(isRecord(data['comments']) ? data['comments']['totalCount'] : undefined)

  return {
    updatedAt: str(data['updatedAt']) || row.updatedAt,
    state: str(data['state'], 'OPEN'),
    commentCount: Math.max(total ?? 0, comments.length),
    comments: comments.slice(-COMMENTS_KEPT),
    excerpt: excerptOf(body),
    body: body.slice(0, BODY_CHARS),
    linkedPrs: linkedPrsOf(nodesOf(data['closedByPullRequestsReferences'])),
    fetchedAt: now,
  }
}

/**
 * The details of one issue: state, body, comments and the pull requests that will close it. With `tree` (a brief's
 * fresh read) the tree fields too (E17); a view that fails with them for a reason they could cause is asked once more
 * without them, and the brief then has no tree.
 */
export async function viewIssue($: EngineInterface, info: RepoInfo, row: IssueRow, now: number, options: { tree?: boolean } = {}): Promise<{ details: IssueDetails } | { state: RepoState }> {
  const withTree = options.tree === true && hasRelations(info, now)
  const args = (fields: string) => ['issue', 'view', String(row.number), '-R', repoSpec(info), '--json', fields]
  let ran = await gh($, args(withTree ? `${VIEW_FIELDS},${TREE_FIELDS}` : VIEW_FIELDS), { host: info.host, repo: repoLabel(info) })
  let hasTree = withTree
  if (!ran.ok && withTree && !NOT_THE_RELATIONS.has(ran.state.kind)) {
    $.ui.log(`issue-radar: the tree of #${row.number} failed (${ran.state.kind} ${ran.state.detail ?? ''}); asking without it`, { to: 'debug' })
    ran = await gh($, args(VIEW_FIELDS), { host: info.host, repo: repoLabel(info) })
    hasTree = false
  }
  if (!ran.ok) return { state: ran.state }
  const details = parseDetails(ran.stdout, row, now, hasTree)
  if (details === null) return { state: { kind: 'error', detail: 'gh issue view answered no JSON' } }

  return { details }
}

/**
 * The parent's sub-issues and progress, for the siblings of a brief's tree (E17): one read of the parent, which may
 * sit in another repository, on the host its URL names. Null when its URL names no repository; a failure is a state.
 */
export async function viewParent($: EngineInterface, parent: IssueRef, fallbackHost: string): Promise<{ subIssues: IssueRef[]; progress: IssueProgress | null } | { state: RepoState } | null> {
  const where = repoOfUrl(parent.url)
  const host = where?.host ?? fallbackHost
  const repo = where?.repo ?? parent.repo
  const spec = host === 'github.com' ? repo : `${host}/${repo}`
  if (repo === '' || !isRepoSpec(spec)) return null
  const ran = await gh($, ['issue', 'view', String(parent.number), '-R', spec, '--json', PARENT_FIELDS], { host, repo })
  if (!ran.ok) return { state: ran.state }
  const json = parseJson(ran.stdout)
  if (!isRecord(json)) return { state: { kind: 'error', detail: 'gh issue view answered no JSON' } }
  const subIssues = nodesOf(json['subIssues'])
    .map(node => refOf(node, TREE_TITLE_CHARS))
    .filter((ref): ref is IssueRef => ref !== null)

  return { subIssues, progress: progressOf(json['subIssuesSummary']) }
}
