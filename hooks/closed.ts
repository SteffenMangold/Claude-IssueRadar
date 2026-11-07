// E22: the recently closed issues of a repository, for the collapsed part at
// the end of its section: one `gh issue list --state closed` over the last days
// (a GraphQL search on GitHub's side, GraphQL points, not the REST search
// budget), read only while the part is expanded and the pane is shown.
import type { EngineInterface } from 'claude-code'

import type { ClosedCache, ClosedPr, ClosedRow, RepoInfo, RepoState } from '../types'
import { utcDay } from './filter'
import { asString, countOf, gh, isRecord, loginOf, parseJson, repoLabel, repoOfUrl, repoSpec } from './github'

export const CLOSED_FIELDS = 'number,title,url,closedAt,stateReason,closedByPullRequestsReferences'
/** One page holds this many; a larger page costs the same request (E22-3). */
export const CLOSED_FETCH = 30
/** The part draws this many, the newest closed first. */
export const CLOSED_SHOWN = 10
/** An expanded list is read again on the timer once it is this old. */
export const CLOSED_FRESH_MS = 15 * 60_000
/** Expanding the part reads the list when it is this old. */
export const CLOSED_EXPAND_FRESH_MS = 10 * 60_000
/** The shortest gap for a refresh the owner, a command or a tool asked for, and after an issue left the open list. */
export const CLOSED_MIN_MS = 30_000
/** A loading flag this old belongs to a fetch a reload cut off: the pane no longer draws it (E22-1). */
export const CLOSED_LOADING_MS = 60_000

/** What asks for the closed list: a refresh's reason, or the owner expanding the part. */
export type ClosedReason = 'start' | 'timer' | 'press' | 'manual' | 'tool' | 'attach' | 'expand'

/** The first day of the window, as `closed:>=` takes it (a UTC date). */
export function sinceDate(now: number, days: number): string {
  return utcDay(now, days)
}

function prOf(value: unknown): ClosedPr | null {
  if (!isRecord(value)) return null
  const number = Number(value['number'])
  if (!Number.isInteger(number) || number <= 0) return null
  const url = asString(value['url'])
  const repository = value['repository']
  const owner = isRecord(repository) ? loginOf(repository['owner']) : '?'
  const name = isRecord(repository) ? asString(repository['name']) : ''
  const repo = owner !== '?' && name !== '' ? `${owner}/${name}` : (repoOfUrl(url)?.repo ?? '')

  return { number, url, repo }
}

/**
 * The closed issues of gh's answer, the newest closed first (search cannot sort by closing time): number, title, URL,
 * closing time, the reason (empty for issues closed before GitHub kept one) and the pull requests that closed them.
 * Null when the answer is no list.
 */
export function parseClosed(text: string): ClosedRow[] | null {
  const json = parseJson(text)
  if (!Array.isArray(json)) return null
  const rows: ClosedRow[] = []
  for (const item of json) {
    if (!isRecord(item)) continue
    const number = Number(item['number'])
    if (!Number.isInteger(number) || number <= 0) continue
    const linked = item['closedByPullRequestsReferences']
    const prs = (Array.isArray(linked) ? (linked as unknown[]) : []).map(prOf).filter((pr): pr is ClosedPr => pr !== null)
    rows.push({ number, title: asString(item['title']), url: asString(item['url']), closedAt: asString(item['closedAt']), stateReason: asString(item['stateReason']).toUpperCase(), prs })
  }

  return rows.sort((a, b) => b.closedAt.localeCompare(a.closedAt) || b.number - a.number)
}

/** The repository's issues closed since `since` (a UTC date), at most 30, with their reason and closing pull request. */
export async function listClosed($: EngineInterface, info: RepoInfo, since: string): Promise<{ rows: ClosedRow[] } | { state: RepoState }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) return { state: { kind: 'error', host: info.host, detail: `invalid date ${since}` } }
  const ran = await gh(
    $,
    ['issue', 'list', '-R', repoSpec(info), '--state', 'closed', '--limit', String(CLOSED_FETCH), '--search', `closed:>=${since} sort:updated-desc`, '--json', CLOSED_FIELDS],
    { host: info.host, repo: repoLabel(info) },
  )
  if (!ran.ok) return { state: ran.state }
  const rows = parseClosed(ran.stdout)
  if (rows === null) return { state: { kind: 'error', host: info.host, detail: 'gh issue list answered no JSON' } }

  return { rows }
}

/**
 * Whether an expanded list is read again, timed from the last read of this window or the last try at it (`triedAt`,
 * answered or not), whichever is later, so a list that keeps failing waits as a read one does (E3-2): at once when
 * this window has neither; after an issue left the open list once 30 s passed; on expanding once 10 minutes passed;
 * for a press, a command or a changing tool once 30 s passed; on the timer, at the start and at an attach or a gh read
 * (F-BUDGET-2) once 15 minutes passed.
 */
export function isClosedDue(cache: ClosedCache | undefined, since: string, reason: ClosedReason, now: number, isNudged: boolean, triedAt?: number): boolean {
  const readAt = cache !== undefined && cache.since === since ? cache.fetchedAt : undefined
  if (readAt === undefined && triedAt === undefined) return true
  const age = now - Math.max(readAt ?? Number.NEGATIVE_INFINITY, triedAt ?? Number.NEGATIVE_INFINITY)
  if (isNudged) return age >= CLOSED_MIN_MS
  if (reason === 'expand') return age >= CLOSED_EXPAND_FRESH_MS
  if (reason === 'press' || reason === 'manual' || reason === 'tool') return age >= CLOSED_MIN_MS

  return age >= CLOSED_FRESH_MS
}

/** The record a fetch leaves: the newest ten and how many the fetch returned. */
export function closedRecord(rows: readonly ClosedRow[], since: string, now: number): ClosedCache {
  return { v: 1, fetchedAt: now, since, rows: rows.slice(0, CLOSED_SHOWN), count: rows.length }
}

/** The count a header pill shows: the number, or `10+` once more closed than the part draws. */
export function closedCountLabel(cache: ClosedCache): string {
  return cache.count > CLOSED_SHOWN ? `${CLOSED_SHOWN}+` : String(cache.count)
}

/** The store's record as the mod can use it, every row checked; anything else is none. */
export function asClosedCache(value: unknown): ClosedCache | undefined {
  if (!isRecord(value) || value['v'] !== 1 || typeof value['fetchedAt'] !== 'number' || typeof value['since'] !== 'string' || !Array.isArray(value['rows'])) return undefined
  const rows = (value['rows'] as unknown[]).filter(isRecord).flatMap(row => {
    const number = Number(row['number'])
    if (!Number.isInteger(number) || number <= 0) return []
    const prs = (Array.isArray(row['prs']) ? (row['prs'] as unknown[]) : []).filter(isRecord).flatMap(pr => {
      const n = Number(pr['number'])

      return Number.isInteger(n) && n > 0 ? [{ number: n, url: asString(pr['url']), repo: asString(pr['repo']) }] : []
    })

    return [{ number, title: asString(row['title']), url: asString(row['url']), closedAt: asString(row['closedAt']), stateReason: asString(row['stateReason']), prs }]
  })

  return { v: 1, fetchedAt: value['fetchedAt'], since: value['since'], rows: rows.slice(0, CLOSED_SHOWN), count: countOf(value['count']) ?? rows.length }
}
