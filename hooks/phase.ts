// The issue session's own record (E12) and what the pane makes of it (E10):
// which issue a session works on, read from its brief's marker line; what its
// last finished turn asked of the owner; the record as the store keeps it; the
// status line; and the proposals a pane toasts. Pure: no `$` here.
import type { Mapping, PhaseAsk, PhaseRecord, SelfIssue } from '../types'
import { MARKER } from './brief'
import type { Strings } from './i18n'

/** What the first line of a hand-off brief names: an issue (`spec#n`) or the spike, and the pane that wrote it. */
export type Marker = { kind: 'issue'; spec: string; number: number; rowKey: string; repo: string; fromId: string } | { kind: 'spike'; fromId: string }

const MARKER_LINE = new RegExp(`^${MARKER} (\\S+)#(\\d+)(?: \\(from ([^)\\s]*)\\))?\\s*$`)
const SPIKE_LINE = new RegExp(`^${MARKER} spike(?: \\(from ([^)\\s]*)\\))?\\s*$`)

/**
 * The marker of a hand-off brief, read from the text's first line only (A-F5: a line, never a prefix of any text):
 * `Issue Radar hand-off: acme/widgets#42 (from local_pane)`, `… ghe.example.com/acme/widgets#7`, `… spike (from x)`.
 * The row key is lowercased as rowKeyOf makes it (`github.com/` before a two-part spec). Null for anything else.
 */
export function parseMarker(text: string): Marker | null {
  const first = text.trimStart().split('\n', 1)[0]?.replace(/\r$/, '') ?? ''
  const spike = SPIKE_LINE.exec(first)
  if (spike !== null) return { kind: 'spike', fromId: spike[1] ?? '' }
  const found = MARKER_LINE.exec(first)
  if (found === null) return null
  const spec = found[1] ?? ''
  const number = Number(found[2])
  const parts = spec.split('/')
  if (!Number.isInteger(number) || number <= 0 || parts.length < 2 || parts.length > 3 || parts.some(part => part === '')) return null
  const key = (parts.length === 2 ? `github.com/${spec}` : spec).toLowerCase()

  return { kind: 'issue', spec, number, rowKey: `${key}#${number}`, repo: parts.slice(-2).join('/'), fromId: found[3] ?? '' }
}

/**
 * Whether two texts open with the same hand-off: the same issue (or the spike) from the same pane. A brief the host
 * passed on with a byte changed is still that brief; another issue's brief, or none, is another prompt (B6-BEH-1).
 */
export function isSameHandOff(a: string, b: string): boolean {
  const x = parseMarker(a)
  const y = parseMarker(b)
  if (x === null || y === null || x.kind !== y.kind || x.fromId !== y.fromId) return false

  return x.kind === 'spike' || (y.kind === 'issue' && x.rowKey === y.rowKey)
}

/** Markdown, quote marks and blockquote marks a model may wrap a line in. */
const WRAPPING = /[*_`>#~"'„“”«»]/g

/**
 * What a finished turn asked of the owner, from the last line of its answer (markdown and quote marks stripped): the
 * closing `Go?` (or `Los?`) of the brief's phase 4, or the fix variant's `Push and open the PR?`, is the proposal; any other line ending in `?` a question; anything
 * else nothing. A model that wraps the question in a sentence reads as a question: a miss only weakens a badge.
 */
export function askOf(answer: string): PhaseAsk {
  const lines = answer
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(WRAPPING, '').trim())
    .filter(line => line !== '')
  const last = lines.at(-1) ?? ''
  // E20: the fix variant's stop before GitHub ("Push and open the PR?", PUSH_LINE) waits for the owner's go as well.
  if (/^(?:go|los|push and open the pr)\s*\?$/i.test(last)) return 'proposal'

  return last.endsWith('?') ? 'question' : 'none'
}

const ACTIVITIES: ReadonlySet<string> = new Set(['working', 'waiting', 'error'])
const ASKS: ReadonlySet<string> = new Set(['proposal', 'question', 'none'])

/** A stored record as the mod can use it, every field checked; null when it is none or of another shape. */
export function readPhase(value: unknown): PhaseRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const given = value as Record<string, unknown>
  const { v, sessionId, activity, ask, at, turns } = given
  if (v !== 1 || typeof sessionId !== 'string' || typeof activity !== 'string' || !ACTIVITIES.has(activity) || typeof ask !== 'string' || !ASKS.has(ask)) return null
  if (typeof at !== 'number' || !Number.isFinite(at) || typeof turns !== 'number' || !Number.isFinite(turns)) return null
  const record: PhaseRecord = { v: 1, sessionId, activity: activity as PhaseRecord['activity'], ask: ask as PhaseAsk, at, turns }
  if (typeof given['engineId'] === 'string' && given['engineId'] !== '') record.engineId = given['engineId']
  if (typeof given['title'] === 'string') record.title = given['title']
  if (typeof given['filedGroupId'] === 'string') record.filedGroupId = given['filedGroupId']
  if (typeof given['filedAt'] === 'number') record.filedAt = given['filedAt']
  if (typeof given['fileTries'] === 'number') record.fileTries = given['fileTries']

  return record
}

/**
 * The record a mapped row may draw: one written under the mapping's session id (the desktop's, or the engine's where
 * the two differ, S4); otherwise one written since the mapping's start (a session that knows only its engine id);
 * none else, so an earlier session's record never speaks for the current one.
 */
export function phaseFor(record: PhaseRecord | null, mapping: Mapping): PhaseRecord | null {
  if (record === null) return null
  if (record.sessionId === mapping.sessionId || record.engineId === mapping.sessionId) return record

  return record.at >= mapping.startedAt ? record : null
}

/** The badge a record stands for (E10). */
export type PhaseKind = 'working' | 'proposal' | 'question' | 'waiting' | 'error'

export function phaseKind(record: PhaseRecord): PhaseKind {
  if (record.activity === 'error') return 'error'
  if (record.activity === 'working') return 'working'

  return record.ask === 'proposal' ? 'proposal' : record.ask === 'question' ? 'question' : 'waiting'
}

/** Whether two sets of accepted records say the same (an atom write redraws the pane, so only a change is written). */
export function samePhases(a: Readonly<Record<string, PhaseRecord>>, b: Readonly<Record<string, PhaseRecord>>): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false

  return keys.every(key => {
    const x = a[key]
    const y = b[key]

    return x !== undefined && y !== undefined && x.sessionId === y.sessionId && x.activity === y.activity && x.ask === y.ask && x.at === y.at
  })
}

/**
 * The rows whose proposal waits and has not been toasted in this session: the record waits on the closing `Go?` (or
 * an open plan approval), is newer than the last proposal toasted for its row, and newer than the session itself.
 */
export function proposalsDue(found: Readonly<Record<string, PhaseRecord>>, seen: { since: number; seen: Readonly<Record<string, number>> }): string[] {
  return Object.entries(found)
    .filter(([rowKey, record]) => record.activity === 'waiting' && record.ask === 'proposal' && record.at > (seen.seen[rowKey] ?? seen.since))
    .map(([rowKey]) => rowKey)
    .sort()
}

/** How a toast names a row: `#42` in the checkout's repository, `owner/name#42` elsewhere (B-E10-5). */
export function toastRef(rowKey: string, checkoutKey: string): string {
  const hash = rowKey.lastIndexOf('#')
  const section = rowKey.slice(0, hash)
  const number = rowKey.slice(hash + 1)
  if (section === checkoutKey) return `#${number}`

  return `${section.split('/').slice(-2).join('/')}#${number}`
}

/** The status line of an issue session (E12): `Issue #42 · acme/widgets`, and that the proposal waits for the owner's go. */
export function statusText(S: Strings, self: SelfIssue, record: PhaseRecord | null): string {
  if (self.isSpike) return S.statusSpike
  const waits = record !== null && record.activity === 'waiting' && record.ask === 'proposal'

  return `${S.statusIssue(self.number, self.repo)}${self.mode === 'fix' ? S.statusFix : ''}${waits ? S.statusProposal : ''}`
}
