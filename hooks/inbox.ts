// E11: the open issues assigned to the signed-in gh account in any repository
// of one host, from GitHub search. It is the one call of the mod that draws on
// the REST search budget (30 a minute, shared with the owner's other tools), so
// it is rare and shared: one store key per host for every pane and project on
// the machine, an age gate and a back-off kept in the store, never in memory.
import type { EngineInterface } from 'claude-code'

import type { InboxCache, InboxRow, IssueLabel, RepoState } from '../types'
import { asString, countOf, gh, isRecord, parseJson, repoOfUrl } from './github'

/** At most this many assigned issues are listed (and the issue cap, when that is lower). */
export const INBOX_CAP = 30
export const INBOX_FIELDS = 'repository,number,title,url,updatedAt,createdAt,commentsCount,labels,isPullRequest'
/** The shortest gap between two searches the owner's ↻ asks for (the `press` reason only, E11-2). */
export const INBOX_PRESS_GAP_MS = 60_000
/** How long a search waits after it found no network. */
export const INBOX_OFFLINE_MS = 2 * 60_000
/** How long every search waits after a rate limit, ↻ included. */
export const INBOX_RATE_MS = 10 * 60_000

/** How old the shared result may grow before a search is due: 15 minutes, or five timer periods when those are longer. */
export function inboxPeriod(refreshMinutes: number): number {
  return Math.max(15 * 60_000, Math.round(refreshMinutes * 5 * 60_000))
}

/**
 * The search: open issues assigned to `@me`, archived repositories and pull requests left out, the most recently
 * updated first. gh search has no `--hostname`; on another host `GH_HOST` (gh's documented variable) names it, and
 * nothing else is set over the host's environment.
 */
export function searchArgs(host: string, limit: number): { args: string[]; env?: Record<string, string> } {
  const args = ['search', 'issues', '--assignee', '@me', '--state', 'open', '--archived=false', '--sort', 'updated', '--order', 'desc', '--limit', String(Math.max(1, limit)), '--json', INBOX_FIELDS]

  return host === 'github.com' ? { args } : { args, env: { GH_HOST: host } }
}

/** The rows of gh search's answer; pull requests and anything without a number are skipped. Null when it is no list. */
export function parseInbox(text: string, fallbackHost: string): InboxRow[] | null {
  const json = parseJson(text)
  if (!Array.isArray(json)) return null
  const rows: InboxRow[] = []
  for (const item of json) {
    if (!isRecord(item) || item['isPullRequest'] === true) continue
    const number = Number(item['number'])
    if (!Number.isInteger(number) || number <= 0) continue
    const url = asString(item['url'])
    const where = repoOfUrl(url)
    const repository = item['repository']
    const repo = (isRecord(repository) ? asString(repository['nameWithOwner']) : '') || (where?.repo ?? '')
    if (repo === '' || !repo.includes('/')) continue
    const labels: IssueLabel[] = Array.isArray(item['labels'])
      ? (item['labels'] as unknown[]).filter(isRecord).map(label => ({ name: asString(label['name']), color: asString(label['color']) })).filter(label => label.name !== '')
      : []
    rows.push({
      host: where?.host ?? fallbackHost,
      repo,
      number,
      title: asString(item['title']),
      url,
      createdAt: asString(item['createdAt']),
      updatedAt: asString(item['updatedAt']),
      commentCount: countOf(item['commentsCount']) ?? 0,
      labels,
    })
  }

  return rows
}

/** One search through the signed-in gh; a failure is a named state. */
export async function searchAssigned($: EngineInterface, host: string, limit: number): Promise<{ rows: InboxRow[] } | { state: RepoState }> {
  const { args, env } = searchArgs(host, limit)
  const ran = await gh($, args, { host, ...(env === undefined ? {} : { env }) })
  if (!ran.ok) return { state: ran.state }
  const rows = parseInbox(ran.stdout, host)
  if (rows === null) return { state: { kind: 'error', host, detail: 'gh search issues answered no JSON' } }

  return { rows }
}

function asRows(value: unknown): InboxRow[] {
  if (!Array.isArray(value)) return []

  return value.filter(isRecord).flatMap(row => {
    const number = Number(row['number'])
    const repo = asString(row['repo'])
    if (!Number.isInteger(number) || number <= 0 || !repo.includes('/')) return []
    const labels = Array.isArray(row['labels']) ? (row['labels'] as unknown[]).filter(isRecord).map(label => ({ name: asString(label['name']), color: asString(label['color']) })) : []

    return [
      {
        host: asString(row['host'], 'github.com'),
        repo,
        number,
        title: asString(row['title']),
        url: asString(row['url']),
        createdAt: asString(row['createdAt']),
        updatedAt: asString(row['updatedAt']),
        commentCount: countOf(row['commentCount']) ?? 0,
        labels,
      },
    ]
  })
}

function timeOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** The store's record as the mod can use it, every row checked; anything else is none. */
export function asInboxCache(value: unknown): InboxCache | undefined {
  if (!isRecord(value) || value['v'] !== 1) return undefined
  const fetchedAt = timeOf(value['fetchedAt'])
  if (fetchedAt === undefined) return undefined
  const cache: InboxCache = { v: 1, fetchedAt, rows: asRows(value['rows']) }
  const triedAt = timeOf(value['triedAt'])
  const retryAt = timeOf(value['retryAt'])
  const holdUntil = timeOf(value['holdUntil'])
  if (triedAt !== undefined) cache.triedAt = triedAt
  if (retryAt !== undefined) cache.retryAt = retryAt
  if (holdUntil !== undefined) cache.holdUntil = holdUntil

  return cache
}

/**
 * Whether a search is due. Age-based, never by the refresh's reason alone (E11-1), so the attach refresh that finds
 * the pane placed searches once: without a stored result at once; nothing while a rate limit holds; for the owner's
 * ↻ once the last try is a minute old (E11-2); else once the last result is `period` old and no back-off holds.
 */
export function isInboxDue(stored: InboxCache | undefined, reason: string, now: number, period: number): boolean {
  if (stored === undefined) return true
  if (now < (stored.holdUntil ?? 0)) return false
  if (reason === 'press') return now - Math.max(stored.fetchedAt, stored.triedAt ?? 0) >= INBOX_PRESS_GAP_MS

  return now - stored.fetchedAt >= period && now >= (stored.retryAt ?? 0)
}

/**
 * The store's record after a failed search: the last rows kept, the next try put off by what failed (E11-6): a rate
 * limit holds every search for 10 minutes, no network 2 minutes, anything else (signed out, an error, no gh) a whole
 * period, so a search that keeps failing never runs on every tick.
 */
export function failedInbox(stored: InboxCache | undefined, state: RepoState, now: number, period: number): InboxCache {
  const base: InboxCache = { v: 1, fetchedAt: stored?.fetchedAt ?? 0, rows: stored?.rows ?? [], triedAt: now }
  if (state.kind === 'rate-limited') return { ...base, retryAt: now + INBOX_RATE_MS, holdUntil: now + INBOX_RATE_MS }
  if (state.kind === 'offline') return { ...base, retryAt: now + INBOX_OFFLINE_MS }

  return { ...base, retryAt: now + period }
}
