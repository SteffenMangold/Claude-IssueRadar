// Pull-request state (E3): what GraphQL says of the pull requests that will
// close an issue, which of them a row shows first, the words and tone it shows
// them with, and when a repository's states are read again. Pure: no `$`. The
// status strip, the opened row and later the issue tool (E6) and the prompt
// context (E2) read the same words.
import type { IssueDetails, PrChecks, PrLink, PrRecord, PrReview, PrState, SessionPr } from '../types'
import { asString, countOf, isRecord, nodesOf, repoOfUrl } from './github'
import type { Strings } from './i18n'

/** The pull requests a GraphQL request reads per issue, the newest ones; the opened row lists as many. */
export const PR_LINKS_MAX = 3
/** How often a repository's pull-request states are read again on the timer. */
export const PR_EVERY_MS = 10 * 60_000
/** The shortest gap between two reads that a press, a command or a tool asks for. */
export const PR_MIN_GAP_MS = 30_000
/** Past this age a stored state is drawn without its words: a neutral chip (E3-5). */
export const PR_STALE_MS = 2 * PR_EVERY_MS
/** How long a session's pull request, as the app reported it, counts (it is read every minute while the app answers). */
export const SESSION_PR_STALE_MS = 10 * 60_000
/** A cross-repository chip names the repository by at most this many characters (E3-8). */
const REPO_SHORT = 10

const STATES: readonly string[] = ['OPEN', 'MERGED', 'CLOSED']
const REVIEWS: readonly string[] = ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']
const CHECKS: readonly string[] = ['SUCCESS', 'FAILURE', 'ERROR', 'PENDING', 'EXPECTED']

/** An issue's linked pull requests as one request read them, and how many reference it in all. */
export type PrLinks = { links: PrLink[]; total: number }

export type PrTone = 'merged' | 'muted' | 'error' | 'warning' | 'success' | 'accent'

/** A linked pull request as a row shows it: its state unknown (null) until GraphQL or the app said it. */
export type ShownPr = {
  number: number
  url: string
  repo: string
  state: PrState | null
  isDraft: boolean
  review: PrReview | null
  checks: PrChecks | null
  /** The pull request the app binds to this issue's session. */
  fromSession: boolean
  /** E19-2: when it merged and into which branch, where GraphQL said. */
  mergedAt?: string
  base?: string
}

export function asReview(value: unknown): PrReview | null {
  const said = asString(value).toUpperCase()

  return REVIEWS.includes(said) ? (said as PrReview) : null
}

function asChecks(value: unknown): PrChecks | null {
  const said = asString(value).toUpperCase()

  return CHECKS.includes(said) ? (said as PrChecks) : null
}

/**
 * An issue's `closedByPullRequestsReferences` connection: open and merged pull requests (gh's own set; closed,
 * unmerged ones are not asked, E7-1). A node the token may not read comes as null and is skipped, the issue's other
 * pull requests kept (E3-3); a head commit without checks, or without a rollup, reads as no checks.
 */
export function parsePrConnection(value: unknown): PrLinks {
  const links: PrLink[] = []
  for (const node of nodesOf(value)) {
    if (!isRecord(node)) continue
    const number = Number(node['number'])
    const state = asString(node['state']).toUpperCase()
    if (!Number.isInteger(number) || number <= 0 || !STATES.includes(state)) continue
    const url = asString(node['url'])
    const repository = node['repository']
    const repo = (isRecord(repository) ? asString(repository['nameWithOwner']) : '') || (repoOfUrl(url)?.repo ?? '')
    const head = nodesOf(node['commits'])[0]
    const commit = isRecord(head) ? head['commit'] : undefined
    const rollup = isRecord(commit) ? commit['statusCheckRollup'] : undefined
    const link: PrLink = { number, url, repo, state: state as PrState, isDraft: node['isDraft'] === true, review: asReview(node['reviewDecision']), checks: isRecord(rollup) ? asChecks(rollup['state']) : null }
    // E19-2: a merged one's time and base branch, so the close-out waits while GitHub closes the issue itself.
    if (link.state === 'MERGED' && typeof node['mergedAt'] === 'string') link.mergedAt = node['mergedAt']
    if (link.state === 'MERGED' && typeof node['baseRefName'] === 'string') link.base = node['baseRefName']
    links.push(link)
  }
  const counted = countOf(isRecord(value) ? value['totalCount'] : undefined) ?? 0

  return { links: links.slice(0, PR_LINKS_MAX), total: Math.max(counted, links.length) }
}

/**
 * A repository's record from one sweep over `numbers`: only issues with a linked pull request are kept. `viewer`, the
 * signed-in account the request answered for (E5), is kept when known.
 */
export function recordOf(links: ReadonlyMap<number, PrLinks>, asOf: string, now: number, viewer: string | null = null): PrRecord {
  const rows: Record<string, PrLink[]> = {}
  const total: Record<string, number> = {}
  for (const [number, found] of links) {
    if (found.links.length === 0 && found.total === 0) continue
    rows[String(number)] = found.links
    total[String(number)] = found.total
  }

  return viewer === null ? { v: 1, fetchedAt: now, asOf, rows, total } : { v: 1, fetchedAt: now, asOf, rows, total, viewer }
}

/**
 * A record with some issues read again (E7's tier 2 patched them): their links replace the old ones, the sweep's time
 * stays, and `asOf` moves on to the newest of them, since every issue newer than the record was among them.
 */
export function mergeLinks(record: PrRecord, links: ReadonlyMap<number, PrLinks>, asOf: string): PrRecord {
  const rows = { ...record.rows }
  const total = { ...record.total }
  for (const [number, found] of links) {
    const key = String(number)
    if (found.links.length === 0 && found.total === 0) {
      delete rows[key]
      delete total[key]
    } else {
      rows[key] = found.links
      total[key] = found.total
    }
  }

  return { ...record, rows, total, asOf: asOf > record.asOf ? asOf : record.asOf }
}

/** A stored link as the mod can draw it; null when it is none. */
function asLink(value: unknown): PrLink | null {
  if (!isRecord(value)) return null
  const number = Number(value['number'])
  const state = asString(value['state']).toUpperCase()
  if (!Number.isInteger(number) || number <= 0 || !STATES.includes(state)) return null

  const link: PrLink = { number, url: asString(value['url']), repo: asString(value['repo']), state: state as PrState, isDraft: value['isDraft'] === true, review: asReview(value['review']), checks: asChecks(value['checks']) }
  if (typeof value['mergedAt'] === 'string') link.mergedAt = value['mergedAt']
  if (typeof value['base'] === 'string') link.base = value['base']

  return link
}

/** A stored record as the mod can use it, every link checked (the drawing trusts it); anything else is none. */
export function asRecord(value: unknown): PrRecord | undefined {
  if (!isRecord(value) || value['v'] !== 1 || typeof value['fetchedAt'] !== 'number') return undefined
  const rows: Record<string, PrLink[]> = {}
  const total: Record<string, number> = {}
  const givenRows = value['rows']
  const givenTotal = value['total']
  if (isRecord(givenRows)) {
    for (const [number, list] of Object.entries(givenRows)) {
      if (Array.isArray(list)) rows[number] = list.map(asLink).filter((link): link is PrLink => link !== null)
    }
  }
  if (isRecord(givenTotal)) {
    for (const [number, counted] of Object.entries(givenTotal)) {
      const valid = countOf(counted)
      if (valid !== null) total[number] = valid
    }
  }

  const viewer = asString(value['viewer'])

  return viewer === '' ? { v: 1, fetchedAt: value['fetchedAt'], asOf: asString(value['asOf']), rows, total } : { v: 1, fetchedAt: value['fetchedAt'], asOf: asString(value['asOf']), rows, total, viewer }
}

/**
 * Whether a repository's pull-request states are due for a read. Never while a back-off holds; at once when none was
 * read or tried; for a press, a command or a changing tool once the last read or try is 30 s old; else (the timer, the
 * start, an attach or a gh read: F-BUDGET-2) once it is ten minutes
 * old, or as soon as a listed issue is newer than the record (a changed issue may have a new pull request), unless the
 * last try failed: a failure always waits the full interval (E3-2).
 */
export function isPrsDue(record: PrRecord | undefined, rows: readonly { updatedAt: string }[], reason: string, now: number, triedAt: number | undefined, until = 0): boolean {
  if (now < until || rows.length === 0) return false
  if (record === undefined && triedAt === undefined) return true
  const since = Math.max(record?.fetchedAt ?? 0, triedAt ?? 0)
  const isAsked = reason === 'press' || reason === 'manual' || reason === 'tool'
  if (now - since >= (isAsked ? PR_MIN_GAP_MS : PR_EVERY_MS)) return true
  const failedLast = triedAt !== undefined && (record === undefined || triedAt > record.fetchedAt)

  return !failedLast && record !== undefined && rows.some(row => row.updatedAt > record.asOf)
}

/** `owner/name` of a session's pull request from its URL; empty when it names none. */
export function repoOfPr(url: string): string {
  return /\/([^/]+\/[^/]+)\/pull\/\d+/.exec(url)?.[1] ?? repoOfUrl(url)?.repo ?? ''
}

function rank(pr: ShownPr): number {
  if (pr.fromSession) return 0
  if (pr.state === 'OPEN') return pr.isDraft ? 2 : 1
  if (pr.state === 'MERGED') return 3
  if (pr.state === 'CLOSED') return 4

  return 5
}

function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * The pull requests a row shows, the most relevant first: the issue session's own (E3-6: matched on repository and
 * number, from its URL), then open and ready, open drafts, merged, closed, and those whose state is unknown; ties go
 * to the higher number. GraphQL's record speaks while it is fresh; a stale record still names its links, without
 * state (E3-5). The details' links (gh's view, no state) are added when they are newer than the record, so a link made
 * since shows at once. `total` counts the open and merged ones in all, beyond the three read.
 */
export function linksOf(record: PrRecord | undefined, number: number, details: IssueDetails | undefined, session: SessionPr | undefined, sectionRepo: string, now: number): { links: ShownPr[]; total: number } {
  const isFresh = record !== undefined && now - record.fetchedAt < PR_STALE_MS
  const shown: ShownPr[] = (record?.rows[String(number)] ?? []).map(pr =>
    isFresh ? { ...pr, fromSession: false } : { number: pr.number, url: pr.url, repo: pr.repo, state: null, isDraft: false, review: null, checks: null, fromSession: false },
  )
  let total = Math.max(record?.total[String(number)] ?? 0, shown.length)
  if (details !== undefined && (record === undefined || details.fetchedAt > record.fetchedAt)) {
    for (const pr of details.linkedPrs) {
      const repo = repoOfPr(pr.url) || sectionRepo
      if (shown.some(found => found.number === pr.number && sameRepo(found.repo, repo))) continue
      shown.push({ number: pr.number, url: pr.url, repo, state: null, isDraft: false, review: null, checks: null, fromSession: false })
      total += 1
    }
  }
  if (session !== undefined && now - session.at < SESSION_PR_STALE_MS && session.number > 0) {
    const repo = session.repo || repoOfPr(session.url) || sectionRepo
    const state: PrState | null = session.state === 'DRAFT' ? 'OPEN' : session.state === '' ? null : session.state
    // E19-2 (B7-BEH-2): a merge only the app reported carries no time from GraphQL: when this pane first read it merged
    // stands for it (its base stays unknown, which the close-out reads as the default branch), so the hold applies.
    const seenMerged = state === 'MERGED' ? new Date(session.mergedSeenAt ?? session.at).toISOString() : undefined
    const own = shown.find(found => found.number === session.number && sameRepo(found.repo, repo))
    if (own !== undefined) {
      own.fromSession = true
      if (state !== null) own.state = state
      if (session.state === 'DRAFT') own.isDraft = true
      if (session.review !== null) own.review = session.review
      if (seenMerged !== undefined && own.mergedAt === undefined) own.mergedAt = seenMerged
    } else {
      shown.push({ number: session.number, url: session.url, repo, state, isDraft: session.state === 'DRAFT', review: session.review, checks: null, fromSession: true, ...(seenMerged === undefined ? {} : { mergedAt: seenMerged }) })
      if (state !== 'CLOSED') total += 1
    }
  }
  shown.sort((a, b) => rank(a) - rank(b) || b.number - a.number)

  return { links: shown, total }
}

/** The check status that speaks for a pull request: the app's counts for the session's own, else GitHub's rollup. */
function checksOf(pr: ShownPr, session: SessionPr | undefined): PrChecks | null {
  if (pr.fromSession && session !== undefined && session.passed + session.failed + session.pending > 0) {
    if (session.failed > 0) return 'FAILURE'
    if (session.pending > 0) return 'PENDING'

    return 'SUCCESS'
  }

  return pr.checks
}

/**
 * The one word a chip shows, the most actionable first: merged, closed, failing checks, changes requested, draft,
 * pending checks, approved, passing checks, review needed, open. Null while the state is unknown.
 */
export function prStatus(pr: ShownPr, session: SessionPr | undefined, S: Strings): { word: string; tone: PrTone } | null {
  if (pr.state === null) return null
  if (pr.state === 'MERGED') return { word: S.prMerged, tone: 'merged' }
  if (pr.state === 'CLOSED') return { word: S.prClosed, tone: 'muted' }
  const checks = checksOf(pr, session)
  if (checks === 'FAILURE' || checks === 'ERROR') return { word: S.prChecksFailed, tone: 'error' }
  if (pr.review === 'CHANGES_REQUESTED') return { word: S.prChanges, tone: 'warning' }
  if (pr.isDraft) return { word: S.prDraft, tone: 'muted' }
  if (checks === 'PENDING' || checks === 'EXPECTED') return { word: S.prChecksPending, tone: 'warning' }
  if (pr.review === 'APPROVED') return { word: S.prApproved, tone: 'success' }
  if (checks === 'SUCCESS') return { word: S.prChecksPassed, tone: 'success' }
  if (pr.review === 'REVIEW_REQUIRED') return { word: S.prReviewNeeded, tone: 'accent' }

  return { word: S.prOpen, tone: 'accent' }
}

/**
 * How a row names a pull request: `#57` in the section's repository; elsewhere `name#57`, the name cut to ten
 * characters (`isShort`, the chip) or `owner/name#57` (the opened row).
 */
export function prRefOf(pr: Pick<ShownPr, 'number' | 'repo'>, sectionRepo: string, isShort: boolean): string {
  if (pr.repo === '' || sameRepo(pr.repo, sectionRepo)) return `#${pr.number}`
  if (!isShort) return `${pr.repo}#${pr.number}`
  const name = pr.repo.split('/')[1] ?? pr.repo

  return `${name.length > REPO_SHORT ? `${name.slice(0, REPO_SHORT - 1)}…` : name}#${pr.number}`
}

/** E4's card line for one pull request: `PR #57 · offen · Entwurf · Checks ✓`, the bare `PR #57` while its state is unknown. */
export function prCardLine(pr: ShownPr, session: SessionPr | undefined, sectionRepo: string, S: Strings): string {
  const words = prLine(pr, session, S)
  const ref = S.prRef(prRefOf(pr, sectionRepo, true))

  return words === '' ? ref : `${ref} · ${words}`
}

/** A chip's text and tone: `PR #57 · Entwurf`, or a neutral `PR #57` while the state is unknown. */
export function prChip(pr: ShownPr, session: SessionPr | undefined, sectionRepo: string, S: Strings): { text: string; tone: PrTone | null } {
  const ref = S.prRef(prRefOf(pr, sectionRepo, true))
  const status = prStatus(pr, session, S)

  return status === null ? { text: ref, tone: null } : { text: `${ref} · ${status.word}`, tone: status.tone }
}

/**
 * The opened row's words for one pull request, after its link: state, checks, review, and for the issue session's
 * own the app's numbers (`Checks 8/9 · rot: lint · Konflikte · aus der Issue-Session`); empty while the state is unknown.
 */
export function prLine(pr: ShownPr, session: SessionPr | undefined, S: Strings): string {
  if (pr.state === null) return ''
  const parts: string[] = []
  if (pr.state === 'MERGED') parts.push(S.prMerged)
  else if (pr.state === 'CLOSED') parts.push(S.prClosed)
  else parts.push(...(pr.isDraft ? [S.prOpen, S.prDraft] : [S.prOpen]))
  const own = pr.fromSession && session !== undefined ? session : undefined
  const counted = own === undefined ? 0 : own.passed + own.failed + own.pending
  if (own !== undefined && counted > 0) parts.push(S.prCounts(own.passed, counted))
  else {
    const checks = pr.checks
    if (checks === 'FAILURE' || checks === 'ERROR') parts.push(S.prChecksFailed)
    else if (checks === 'PENDING' || checks === 'EXPECTED') parts.push(S.prChecksPending)
    else if (checks === 'SUCCESS') parts.push(S.prChecksPassed)
  }
  if (pr.review === 'CHANGES_REQUESTED') parts.push(S.prChanges)
  else if (pr.review === 'APPROVED') parts.push(S.prApproved)
  else if (pr.review === 'REVIEW_REQUIRED') parts.push(S.prReviewNeeded)
  if (own !== undefined) {
    if (own.failing.length > 0) parts.push(S.prFailing(own.failing.join(', ')))
    if (own.mergeable.toUpperCase() === 'CONFLICTING') parts.push(S.prConflicts)
  }
  if (pr.fromSession) parts.push(S.prFromSession)

  return parts.join(' · ')
}
