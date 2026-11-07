// E1: the session state a mapped row shows, and the earlier attempts of an
// issue. One badge per row (plan 4.5): the app's listing says whether the
// session is there (listed: active; missing from a complete list but found:
// archived; not found: gone), the issue session's own record says what it is
// doing (E12/E10), and the two merge here. Pure: no `$` here.
import type { DoneMapping, Mapping, PhaseRecord, PreviousAttempt, SessionLive } from '../types'
import { phaseFor, phaseKind } from './phase'
import type { SessionEntry } from './session'

/** What a row's session line shows; the vocabulary every pane shares (B crossCutting 1). */
export type BadgeKind = 'self' | 'gone' | 'archived' | 'starting' | 'working' | 'question' | 'waiting' | 'proposal' | 'error' | 'idle' | 'active'

/** A row's badge: its kind, since when its state holds where that is known, and whether what it rests on is old. */
export type Badge = { kind: BadgeKind; since: number | null; isStale: boolean }

/** For the first two minutes after a start, a session without a record reads as starting. */
export const STARTING_MS = 120_000
/** How many attempts an issue keeps, the newest first. */
export const ATTEMPTS_KEPT = 3

/**
 * The app's state words the mod knows, exact only (A-F16: substring families misread `unarchived`, `disconnected`,
 * `task_running`). None is documented (A-F3); the spike records the words the app uses (S20) and this table grows from
 * them. An unknown word means nothing here: listing membership still says the session is active.
 */
const STATE_WORDS: Readonly<Record<string, NonNullable<SessionLive['state']>>> = {
  running: 'working',
  working: 'working',
  busy: 'working',
  streaming: 'working',
  needs_input: 'waiting',
  'needs-input': 'waiting',
  waiting_for_input: 'waiting',
  awaiting_input: 'waiting',
  requires_action: 'waiting',
  awaiting_permission: 'waiting',
  idle: 'idle',
  ready: 'idle',
  completed: 'idle',
  done: 'idle',
  starting: 'starting',
  queued: 'starting',
  pending: 'starting',
  failed: 'failed',
  error: 'failed',
}

/** The app's word as the mod reads it, or null for none it knows (the raw word is kept for the spike). */
export function stateFamily(word: string): SessionLive['state'] {
  return STATE_WORDS[word.trim().toLowerCase()] ?? null
}

/** What one entry of the app says of a mapped session, as a tracking pass keeps it. */
export function liveOf(entry: SessionEntry, presence: SessionLive['presence'], at: number): SessionLive {
  const fromFlags = entry.needsInput === true ? 'waiting' : entry.isRunning === true ? 'working' : null

  return { sessionId: entry.id, presence, state: fromFlags ?? stateFamily(entry.state), raw: entry.state, link: entry.link, branch: entry.branch, pr: entry.pr, at }
}

/** A session the app no longer knows (get_session said so). */
export function goneLive(sessionId: string, at: number): SessionLive {
  return { sessionId, presence: 'gone', state: null, raw: '', link: null, branch: null, pr: 'no', at }
}

/** The app's state as a badge. */
function appKind(state: NonNullable<SessionLive['state']>): BadgeKind {
  return state === 'failed' ? 'error' : state
}

export type BadgeInput = {
  mapping: Mapping
  /** The tracking pass's word on the row; used only while it names the mapping's session (A-F11). */
  live: SessionLive | undefined
  /** The issue session's record as the pane accepted it (E10). */
  record: PhaseRecord | undefined
  /** The mapping names this very session (the pane drawn inside its own issue session). */
  isSelf: boolean
  now: number
  /** How old the app's word may be before the badge is drawn subdued. */
  staleMs: number
}

/**
 * The row's one badge (plan 4.5): this session; then gone or archived from the app; otherwise the newer of the record
 * and the app's state word, except that a proposal stands while the app says only waiting or idle (the listing cannot
 * see a proposal); a record alone; the app's word alone; starting for two minutes after a start; active while listed.
 * Null when nothing is known (no route to the app, no record): the row looks as V1 drew it.
 */
export function rowBadge(input: BadgeInput): Badge | null {
  const { mapping, now } = input
  if (input.isSelf) return { kind: 'self', since: null, isStale: false }
  const live = input.live?.sessionId === mapping.sessionId ? input.live : undefined
  const isStale = live !== undefined && now - live.at > input.staleMs
  if (live?.presence === 'gone') return { kind: 'gone', since: null, isStale }
  if (live?.presence === 'archived') return { kind: 'archived', since: null, isStale }
  const record = input.record === undefined ? null : phaseFor(input.record, mapping)
  const app = live?.state ?? null
  if (record !== null) {
    const kind = phaseKind(record)
    if (app === null || live === undefined || record.at >= live.at) return { kind, since: record.at, isStale: false }
    if (kind === 'proposal' && (app === 'waiting' || app === 'idle')) return { kind, since: record.at, isStale: false }

    return { kind: appKind(app), since: null, isStale }
  }
  if (app !== null) return { kind: appKind(app), since: null, isStale }
  if (now - mapping.startedAt < STARTING_MS) return { kind: 'starting', since: mapping.startedAt, isStale: false }
  if (live?.presence === 'active') return { kind: 'active', since: null, isStale }

  return null
}

/** Whether a mapping names this session (its engine id, or its desktop id once known). */
export function isOwnSession(mapping: Pick<Mapping, 'sessionId'>, ids: readonly string[]): boolean {
  return ids.some(id => id !== '' && id === mapping.sessionId)
}

/** A stored attempts list as the mod can use it, each entry checked; empty when it is none. */
export function asAttempts(value: unknown): PreviousAttempt[] {
  if (!Array.isArray(value)) return []

  return value.flatMap(item => {
    if (typeof item !== 'object' || item === null) return []
    const given = item as Record<string, unknown>
    const { sessionId, title, startedAt, endedAs, at } = given
    if (typeof sessionId !== 'string' || sessionId === '' || typeof title !== 'string' || typeof startedAt !== 'number' || typeof at !== 'number') return []
    if (endedAs !== 'archived' && endedAs !== 'gone') return []
    const attempt: PreviousAttempt = { sessionId, title, startedAt, endedAs, at }
    if (typeof given['branch'] === 'string' && given['branch'] !== '') attempt.branch = given['branch']
    if (given['isSlug'] === true) attempt.isSlug = true

    return [attempt]
  })
}

/** The attempts with `attempt` first, one per session, at most ATTEMPTS_KEPT. */
export function withAttempt(list: readonly PreviousAttempt[], attempt: PreviousAttempt): PreviousAttempt[] {
  return [attempt, ...list.filter(found => found.sessionId !== attempt.sessionId)].slice(0, ATTEMPTS_KEPT)
}

/** A stored record of a closed issue's session (E22-b), checked; undefined when it is none. */
export function asDone(value: unknown): DoneMapping | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const given = value as Record<string, unknown>
  const { v, sessionId, title, startedAt, startedFrom, closedAt } = given
  if (v !== 1 || typeof sessionId !== 'string' || sessionId === '' || typeof title !== 'string' || typeof startedAt !== 'number' || typeof startedFrom !== 'string' || typeof closedAt !== 'number') return undefined

  return { v: 1, sessionId, title, startedAt, startedFrom, closedAt }
}
