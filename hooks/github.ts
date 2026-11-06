// GitHub through the signed-in `gh`: the repository of a checkout, the open
// issues of a repository, and the details of one issue. The mod never sees a
// token; every failure becomes a named state.
import type { EngineInterface } from 'claude-code'

import type { IssueComment, IssueDetails, IssueRow, LinkedPr, RepoInfo, RepoState } from '../types'

const LIST_FIELDS = 'number,title,url,createdAt,updatedAt,author,labels,assignees,milestone,isPinned'
const VIEW_FIELDS = 'number,state,body,comments,updatedAt,closedByPullRequestsReferences,url'
const REPO_FIELDS = 'nameWithOwner,isPrivate,hasIssuesEnabled,isArchived,isFork,url,defaultBranchRef'
export const BODY_CHARS = 6_000
export const EXCERPT_CHARS = 160
export const COMMENT_CHARS = 600
export const COMMENTS_KEPT = 3

export type GhResult = { ok: true; stdout: string } | { ok: false; state: RepoState }

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

/** Names the failure: the exit code first (4 is signed out), then what gh said. */
export function classify(exitCode: number, stderr: string, host: string, repo: string): RepoState {
  const said = stderr.toLowerCase()
  if (exitCode === 4) return { kind: 'signed-out', host }
  if (said.includes('not a git repository')) return { kind: 'no-git' }
  if (said.includes('no git remotes found')) return { kind: 'no-remote' }
  if (said.includes('known github host')) return { kind: 'not-github' }
  if (said.includes('bad credentials') || said.includes('http 401')) return { kind: 'token-invalid', host }
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
export async function gh($: EngineInterface, args: readonly string[], options: { cwd?: string; host?: string; repo?: string; timeoutMs?: number } = {}): Promise<GhResult> {
  try {
    // No env of our own: gh prompts nothing without a TTY, and the host's PATH must stay as it is (Doc Radar's precedent).
    const ran = await $.process.run(['gh', ...args], { cwd: options.cwd, timeoutMs: options.timeoutMs ?? 30_000 })
    if (ran.exitCode === 0) return { ok: true, stdout: ran.stdout }

    return { ok: false, state: classify(ran.exitCode, ran.stderr, options.host ?? 'github.com', options.repo ?? '') }
  } catch (error) {
    return { ok: false, state: classifyThrow(error) }
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function login(value: unknown): string {
  return typeof value === 'object' && value !== null ? str((value as Json)['login'], '?') : '?'
}

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

function parseRows(text: string): IssueRow[] | null {
  const json = parseJson(text)
  if (!Array.isArray(json)) return null
  const rows: IssueRow[] = []
  for (const item of json) {
    if (typeof item !== 'object' || item === null) continue
    const data = item as Json
    const number = Number(data['number'])
    if (!Number.isInteger(number) || number <= 0) continue
    const labels = Array.isArray(data['labels'])
      ? (data['labels'] as unknown[])
          .filter((label): label is Json => typeof label === 'object' && label !== null)
          .map(label => ({ name: str(label['name']), color: str(label['color']) }))
          .filter(label => label.name !== '')
      : []
    const assignees = Array.isArray(data['assignees']) ? (data['assignees'] as unknown[]).map(login).filter(name => name !== '?') : []
    const milestone = data['milestone']
    rows.push({
      number,
      title: str(data['title']),
      url: str(data['url']),
      createdAt: str(data['createdAt']),
      updatedAt: str(data['updatedAt']),
      author: login(data['author']),
      labels,
      assignees,
      milestone: typeof milestone === 'object' && milestone !== null ? str((milestone as Json)['title']) || null : null,
      isPinned: data['isPinned'] === true,
    })
  }

  return rows
}

/** The open issues of a repository, the most recently updated first, pull requests excluded by gh itself. */
export async function listIssues($: EngineInterface, info: RepoInfo, limit: number): Promise<{ rows: IssueRow[] } | { state: RepoState }> {
  const ran = await gh(
    $,
    ['issue', 'list', '-R', repoSpec(info), '--state', 'open', '--limit', String(Math.max(1, limit)), '--search', 'sort:updated-desc', '--json', LIST_FIELDS],
    { host: info.host, repo: repoLabel(info) },
  )
  if (!ran.ok) return { state: ran.state }
  const rows = parseRows(ran.stdout)
  if (rows === null) return { state: { kind: 'error', detail: 'gh issue list answered no JSON' } }

  return { rows: rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }
}

function collapse(text: string): string {
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

function parseDetails(text: string, row: IssueRow, now: number): IssueDetails | null {
  const json = parseJson(text)
  if (typeof json !== 'object' || json === null) return null
  const data = json as Json
  const body = str(data['body'])
  const comments: IssueComment[] = Array.isArray(data['comments'])
    ? (data['comments'] as unknown[])
        .filter((comment): comment is Json => typeof comment === 'object' && comment !== null)
        .map(comment => ({ author: login(comment['author']), createdAt: str(comment['createdAt']), body: collapse(str(comment['body'])).slice(0, COMMENT_CHARS) }))
    : []
  const linkedPrs: LinkedPr[] = Array.isArray(data['closedByPullRequestsReferences'])
    ? (data['closedByPullRequestsReferences'] as unknown[])
        .filter((pr): pr is Json => typeof pr === 'object' && pr !== null)
        .map(pr => ({ number: Number(pr['number']), state: str(pr['state']), url: str(pr['url']) }))
        .filter(pr => Number.isInteger(pr.number) && pr.number > 0)
    : []

  return {
    updatedAt: str(data['updatedAt']) || row.updatedAt,
    state: str(data['state'], 'OPEN'),
    commentCount: comments.length,
    comments: comments.slice(-COMMENTS_KEPT),
    excerpt: excerptOf(body),
    body: body.slice(0, BODY_CHARS),
    linkedPrs,
    fetchedAt: now,
  }
}

/** The details of one issue: state, body, comments and the pull requests that will close it. */
export async function viewIssue($: EngineInterface, info: RepoInfo, row: IssueRow, now: number): Promise<{ details: IssueDetails } | { state: RepoState }> {
  const ran = await gh($, ['issue', 'view', String(row.number), '-R', repoSpec(info), '--json', VIEW_FIELDS], { host: info.host, repo: repoLabel(info) })
  if (!ran.ok) return { state: ran.state }
  const details = parseDetails(ran.stdout, row, now)
  if (details === null) return { state: { kind: 'error', detail: 'gh issue view answered no JSON' } }

  return { details }
}
