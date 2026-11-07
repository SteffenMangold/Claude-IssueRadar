// The desktop app's session tools, reached from the mod: starting an issue
// session, detaching it, opening it again, and reading what the app knows.
// Two routes reach a tool: `$.mcp.call` (no permission prompt) and the typed
// `$.tool.call` (the permission check and its approval card). Which one works
// is spike item S1. Two rules decide which a call may take:
// - `callDesktop`, for calls a press raised: `$.mcp.call` first; the typed
//   route only when that route failed at transport level, never after an
//   answer of the app (a refusal is the result, not a reason to ask again);
// - `quietDesktop`, for everything the mod does on its own: never a card.
import type { EngineInterface } from 'claude-code'

import type { SessionPr, StartRoute } from '../types'
import { asReview, repoOfPr } from './prs'

export type StartArgs = {
  title: string
  name: string
  prompt: string
  background: string
  branch_name?: string
  use_worktree?: boolean
}

export type DesktopRoute = Exclude<StartRoute, 'none'>

/**
 * A desktop call's outcome. `via` is the route that answered. On a failure, `isTransport` says the answer is no
 * word of the app's: the call threw, the server or tool is unknown or not connected, it timed out, or the typed
 * route was refused (no such tool, a denied permission). Such a failure says nothing about the session asked about.
 */
export type DesktopCall =
  | { ok: true; text: string; structured: unknown; via: DesktopRoute }
  | { ok: false; reason: string; text: string; via: DesktopRoute | 'none'; isTransport: boolean }

export type StartOutcome = {
  route: StartRoute
  sessionId: string | null
  /** What the app answered, cut short, for the spike notes and the debug log. */
  raw: string
  /** Why no route started a session. */
  reason?: string
}

/** How long a quiet call may take before it counts as unanswered (A-F4: a desktop call never holds up a refresh). */
export const QUIET_TIMEOUT_MS = 5_000
/** How long quiet calls leave one call's mcp route alone after it failed at transport level. */
const MCP_RETRY_MS = 10 * 60_000

/** The route that last started a session, for the spike notes; it no longer decides the order of the routes. */
let knownRoute: DesktopRoute | null = null
/**
 * The calls whose mcp route failed at transport level, by `server/tool`: until when quiet calls skip that route, and
 * what the failure said. Kept per call, so one server or tool the mod cannot reach never silences another (E19-1).
 */
const mcpBroken = new Map<string, { until: number; reason: string }>()

export function routeInUse(): StartRoute {
  return knownRoute ?? 'none'
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''

  return content
    .map(block => (typeof block === 'object' && block !== null && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : ''))
    .filter(text => text !== '')
    .join('\n')
}

function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)

  return message.replace(/\s+/g, ' ').slice(0, 160)
}

/** Whether an error text is about reaching the tool rather than an answer of the app: the server or tool unknown, not connected. */
export function isTransportText(text: string): boolean {
  return /\bunknown (?:mcp )?(?:server|tool)\b|\bno such (?:mcp )?(?:server|tool)\b|\bno (?:mcp )?server\b|\bserver\b.{0,60}\b(?:not (?:found|connected|available|running)|disconnected|unavailable)\b|\bnot connected to (?:the |an? )?(?:mcp )?server\b|\bfailed to connect\b/i.test(
    text,
  )
}

/** The words `consent` carries on a typed call a press raised: the owner's own action, as the permission path reads it. */
export function pressConsent(label: string, subject: string): string {
  return `The user pressed "${label}" for ${subject} in the Issue Radar pane.`
}

/** The words `consent` carries on a typed call the owner's own command raised. */
export function commandConsent(command: string): string {
  return `The user ran the command "${command}".`
}

/**
 * The structured part of a typed call's record: its `structuredContent` when the tool declared one; nothing when the
 * record is only the content blocks (the text then speaks for it); the record itself when it is a plain object.
 */
function structuredOf(record: unknown): unknown {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return undefined
  const fields = record as Record<string, unknown>
  if ('structuredContent' in fields) return fields['structuredContent']

  return Array.isArray(fields['content']) ? undefined : record
}

async function viaMcp($: EngineInterface, server: string, tool: string, args: Record<string, unknown>): Promise<DesktopCall> {
  try {
    const result = await $.mcp.call(server, tool, args)
    const text = textOf(result.content)
    if (result.isError) return { ok: false, reason: text.slice(0, 160) || 'the tool reported an error', text, via: 'mcp', isTransport: isTransportText(text) }

    return { ok: true, text, structured: result.structuredContent, via: 'mcp' }
  } catch (error) {
    return { ok: false, reason: reasonOf(error), text: '', via: 'mcp', isTransport: true }
  }
}

async function viaTool($: EngineInterface, server: string, tool: string, args: Record<string, unknown>, consent?: string): Promise<DesktopCall> {
  try {
    // The laid types know the desktop's tools only after the first load; the input is `{ tool, ...arguments }`, plus the
    // reserved `consent` (ToolCallReserved) for a call a press raised. The engine requires `$.tool.call(...)` spelled at the
    // call site: the cast goes on the argument and the result.
    const input: Record<string, unknown> = { tool: `mcp__${server}__${tool}`, ...args }
    if (consent !== undefined) input['consent'] = consent
    const result = (await $.tool.call(input as never)) as unknown as Record<string, unknown>
    if (typeof result['deny'] === 'string') return { ok: false, reason: result['deny'], text: '', via: 'tool', isTransport: true }
    const record = result['result']
    const text = typeof result['text'] === 'string' ? result['text'] : textOf((record as { content?: unknown } | undefined)?.content ?? record)
    if (result['isError'] === true) return { ok: false, reason: text.slice(0, 160) || 'the tool reported an error', text, via: 'tool', isTransport: isTransportText(text) }

    return { ok: true, text, structured: structuredOf(record), via: 'tool' }
  } catch (error) {
    return { ok: false, reason: reasonOf(error), text: '', via: 'tool', isTransport: true }
  }
}

/**
 * Calls a desktop tool for a press: `$.mcp.call` first, then the typed `$.tool.call` (carrying `consent`, the press
 * in words) only when the mcp route failed at transport level. An answer of the app (refused, not found, not on
 * screen, an invalid argument) is the result: asking again on the typed route could raise an approval card for a
 * call the app already refused, and would replace the app's words with the route's (A-F1, B-E20-3).
 */
export async function callDesktop($: EngineInterface, server: string, tool: string, args: Record<string, unknown>, consent?: string): Promise<DesktopCall> {
  const first = await viaMcp($, server, tool, args)
  if (first.ok || !first.isTransport) return first
  const second = await viaTool($, server, tool, args, consent)
  if (second.ok || !second.isTransport) return second

  return { ...second, reason: `mcp: ${first.reason}; tool: ${second.reason}` }
}

const TIMED_OUT = Symbol('timed out')

/** `work`, or TIMED_OUT once `ms` passed on the engine's clock first. The calls beneath never reject (they catch). */
function withTimeout<T>($: EngineInterface, work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return new Promise(resolve => {
    const timer = $.clock.after(ms, () => resolve(TIMED_OUT))
    work.then(
      value => {
        timer.cancel()
        resolve(value)
      },
      () => {
        timer.cancel()
        resolve(TIMED_OUT)
      },
    )
  })
}

function timedOut(via: DesktopRoute, ms: number): DesktopCall {
  return { ok: false, reason: `no answer within ${ms} ms`, text: '', via, isTransport: true }
}

/** `ms` as the hour and minute of the engine's local time, for a reason that says until when. */
function clockTime(ms: number): string {
  const at = new Date(ms)

  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

export type QuietOptions = {
  /** How long each attempt may take before it counts as unanswered; QUIET_TIMEOUT_MS when not given. */
  timeoutMs?: number
  /** Tries the mcp route even while an earlier transport failure holds it back: the spike measures the route itself. */
  isMeasurement?: boolean
  /** Never asks the typed route, not even its permission check: a measurement of the mcp route alone. */
  isMcpOnly?: boolean
}

/**
 * Calls a desktop tool on the mod's own initiative (a refresh, tracking, an issue session reading itself): never an
 * approval card. `$.mcp.call` first, unless this very call (server and tool) failed there at transport level in the
 * last ten minutes; the typed route only when `$.tool.check` answers `allow` for exactly this call. Each attempt is
 * raced against the timeout on the engine's clock; a timeout reads as no answer (`isTransport`), never as a session
 * that is gone. A skipped mcp route is named in the reason.
 */
export async function quietDesktop($: EngineInterface, server: string, tool: string, args: Record<string, unknown>, options: QuietOptions = {}): Promise<DesktopCall> {
  const timeoutMs = options.timeoutMs ?? QUIET_TIMEOUT_MS
  const now = await $.clock.now()
  const key = `${server}/${tool}`
  const broken = mcpBroken.get(key)
  let mcpSaid: string
  if (broken === undefined || now >= broken.until || options.isMeasurement === true) {
    const answer = await withTimeout($, viaMcp($, server, tool, args), timeoutMs)
    if (answer === TIMED_OUT) return timedOut('mcp', timeoutMs)
    if (answer.ok || !answer.isTransport) {
      // The app answered on this route: whatever held it back is over.
      mcpBroken.delete(key)

      return answer
    }
    mcpBroken.set(key, { until: now + MCP_RETRY_MS, reason: answer.reason })
    mcpSaid = `mcp: ${answer.reason}`
  } else mcpSaid = `mcp skipped until ${clockTime(broken.until)} after a transport failure (${broken.reason})`
  if (options.isMcpOnly === true) return { ok: false, reason: mcpSaid, text: '', via: 'none', isTransport: true }
  const verdict = await $.tool.check({ tool: `mcp__${server}__${tool}`, input: args }).catch(() => null)
  const decision = verdict?.decision ?? 'none'
  if (decision !== 'allow') {
    return { ok: false, reason: `${mcpSaid}; the typed route would ${decision === 'none' ? 'not be decided' : decision}`, text: '', via: 'none', isTransport: true }
  }
  const answer = await withTimeout($, viaTool($, server, tool, args), timeoutMs)
  if (answer === TIMED_OUT) return timedOut('tool', timeoutMs)

  return answer.ok || !answer.isTransport ? answer : { ...answer, reason: `${mcpSaid}; tool: ${answer.reason}` }
}

/** Reads the new session's id out of what the app answered: a structured field first, then the text. */
export function parseSessionId(structured: unknown, text: string): string | null {
  if (typeof structured === 'object' && structured !== null) {
    for (const key of ['session_id', 'sessionId', 'id']) {
      const value = (structured as Record<string, unknown>)[key]
      if (typeof value === 'string' && value !== '') return value
    }
  }
  const quoted = /"session_?[iI]d"\s*:\s*"([^"]+)"/.exec(text)
  if (quoted?.[1] !== undefined) return quoted[1]
  const labelled = /session[_ ]?id\s*[:=]\s*["'`]?([A-Za-z0-9_-]{6,})/i.exec(text)
  if (labelled?.[1] !== undefined) return labelled[1]
  const local = /\b(local_[A-Za-z0-9_-]{4,})\b/.exec(text)
  if (local?.[1] !== undefined) return local[1]

  return null
}

/** The object an answer carries: its structured content, else the JSON from the first `{` of its text; empty when neither parses. */
export function parseObject(structured: unknown, text: string): Record<string, unknown> {
  if (typeof structured === 'object' && structured !== null && !Array.isArray(structured)) return structured as Record<string, unknown>
  const start = text.indexOf('{')
  if (start < 0) return {}
  try {
    const parsed = JSON.parse(text.slice(start)) as unknown

    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Starts a desktop session for a press (`consent` says which); `route: 'none'` means the caller falls back to the prompt box. */
export async function startDesktopSession($: EngineInterface, args: StartArgs, consent?: string): Promise<StartOutcome> {
  const input: Record<string, unknown> = {
    initiation: 'user_asked',
    title: args.title,
    name: args.name,
    prompt: args.prompt,
    context: 'fresh',
    background: args.background,
    wake_when_done: false,
  }
  if (args.use_worktree !== undefined) input['use_worktree'] = args.use_worktree
  if (args.branch_name !== undefined) input['branch_name'] = args.branch_name

  const answer = await callDesktop($, 'ccd_session', 'start_session', input, consent)
  if (!answer.ok) {
    $.ui.log(`issue-radar: start_session failed (${answer.via}): ${answer.reason}`, { to: 'debug' })

    return { route: 'none', sessionId: null, raw: '', reason: answer.reason }
  }
  knownRoute = answer.via
  $.ui.log(`issue-radar: start_session via ${answer.via}: ${answer.text.slice(0, 400)}`, { to: 'debug' })

  return { route: answer.via, sessionId: parseSessionId(answer.structured, answer.text), raw: answer.text.slice(0, 400) }
}

/** Moves a session the pane started to the top level; false when the app refused or no route reached it. */
export async function detachSession($: EngineInterface, sessionId: string, consent?: string): Promise<{ ok: boolean; reason?: string }> {
  const answer = await callDesktop($, 'ccd_session_mgmt', 'detach_session', { session_id: sessionId }, consent)
  if (!answer.ok) return { ok: false, reason: answer.reason }
  $.ui.log(`issue-radar: detach_session: ${answer.text.slice(0, 200)}`, { to: 'debug' })

  return { ok: true }
}

export type SessionLook = { exists: true; isArchived: boolean; title: string; link: string | null; state: string } | { exists: false }

/** What the app says of a thing that is not there, after an optional `is`, `was` or `has been`. */
const GONE = String.raw`(?:(?:is|was|has been) )?(?:not found|could not be found|cannot be found|can't be found|does not exist|doesn't exist|no longer exists|deleted)\b`

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Whether the app's error text says that the session asked about does not exist: "Session local_x not found.",
 * "No such session", "Unknown session id local_x", "local_x does not exist", "Could not find session local_x". Any
 * other failure ("An unknown error occurred while reading the session list", "Not found." alone, a refusal) does not:
 * releasing a mapping on it would let the next press start a second live session for the issue.
 */
export function saysSessionGone(text: string, sessionId: string): boolean {
  const said = text.replace(/\s+/g, ' ')
  if (/\b(?:no such|unknown) session(?:[ _-]?id)?\b|\bno session (?:with|named|found|matching|exists)\b|\b(?:could not|couldn't|cannot|can't) find (?:a |the )?session\b/i.test(said)) {
    return true
  }
  const id = sessionId === '' ? '' : escapeRegExp(sessionId)
  const named = id === '' ? '' : String.raw`(?: ["'\`]?${id}["'\`]?)?`
  // "session" as the subject, with nothing but this session's id between it and the words for gone.
  if (new RegExp(String.raw`\bsession(?: with)?(?: (?:id|session_id|sessionId))?${named}:? ${GONE}`, 'i').test(said)) return true

  // This session's id as the subject.
  return id !== '' && new RegExp(String.raw`["'\`]?${id}["'\`]?:? ${GONE}`, 'i').test(said)
}

/** What the app knows about a session the pane started, read for a press. */
export async function lookUpSession($: EngineInterface, sessionId: string, consent?: string): Promise<SessionLook> {
  const answer = await callDesktop($, 'ccd_session_mgmt', 'get_session', { session_id: sessionId }, consent)
  if (!answer.ok) {
    // A failure of the call itself (no such server or tool, a refused route, no answer) says nothing about the
    // session; only the app's own answer that this session is gone releases it. Anything else keeps the mapping.
    const aboutTransport = answer.isTransport || /\b(server|tool|route|connect|permission)/i.test(answer.reason)
    if (!aboutTransport && saysSessionGone(answer.text === '' ? answer.reason : answer.text, sessionId)) return { exists: false }

    return { exists: true, isArchived: false, title: '', link: null, state: 'unknown' }
  }
  const data = parseObject(answer.structured, answer.text)
  const str = (key: string) => (typeof data[key] === 'string' ? (data[key] as string) : '')
  // Only fall back to the prose when the answer carried no JSON: a parsed reply's title or an `"archived": false` field must not count.
  const parsed = Object.keys(data).length > 0
  const archived =
    data['archived'] === true ||
    data['isArchived'] === true ||
    str('state').toLowerCase() === 'archived' ||
    (!parsed && /\barchived\b/i.test(answer.text) && !/\bnot archived\b/i.test(answer.text))

  return { exists: true, isArchived: archived, title: str('title'), link: str('link') || null, state: str('state') }
}

// The app's sessions as E1 and E12 read them -------------------------------------

/**
 * One session as the app lists it (list_sessions) or describes it (get_session). The documented fields are the id,
 * `name` and `startedBy` (linked sessions), `group`, `pinned`, `link`; `title`, a branch and a pull request the schema
 * names as searchable; `parentSessionId` and `detached` (get_session). A state word and an archived flag are not
 * documented (A-F3): the mod reads them only where they appear, and the spike records what does (S20).
 */
export type SessionEntry = {
  id: string
  title: string
  /** The app's state word, lowercased, at most 32 characters; empty for none. */
  state: string
  /** An explicit archived flag or state word; null when the answer says nothing either way. */
  archived: boolean | null
  /** Explicit running / needs-input flags. */
  isRunning: boolean | null
  needsInput: boolean | null
  name: string | null
  link: string | null
  branch: string | null
  parentSessionId: string | null
  startedBy: string | null
  detached: boolean | null
  /** Whether the entry names a pull request: `unknown` when it carries no such field at all. */
  pr: 'yes' | 'no' | 'unknown'
  /** The entry's keys, for the spike (S20). */
  keys: string[]
}

const PR_KEYS = ['pr', 'pullRequest', 'pull_request', 'prNumber', 'pr_number', 'prUrl', 'pr_url', 'boundPr', 'bound_pr']

/** One entry of an answer, every field read defensively; null without an id. */
export function entryOf(data: Record<string, unknown>): SessionEntry | null {
  const text = (keys: readonly string[]): string => {
    for (const key of keys) {
      const value = data[key]
      if (typeof value === 'string' && value !== '') return value
    }

    return ''
  }
  const flag = (keys: readonly string[]): boolean | null => {
    for (const key of keys) if (typeof data[key] === 'boolean') return data[key] as boolean

    return null
  }
  const id = text(['sessionId', 'session_id', 'id'])
  if (id === '') return null
  const state = text(['state', 'status', 'activity', 'phase']).toLowerCase().slice(0, 32)
  const worktree = typeof data['worktree'] === 'object' && data['worktree'] !== null ? (data['worktree'] as Record<string, unknown>) : {}
  const branch = text(['branch', 'branchName', 'branch_name', 'gitBranch']) || (typeof worktree['branch'] === 'string' ? worktree['branch'] : '')
  const archivedFlag = flag(['archived', 'isArchived', 'is_archived'])
  const hasPrKey = PR_KEYS.some(key => key in data)
  const prValue = PR_KEYS.map(key => data[key]).find(value => value !== undefined && value !== null && value !== false && value !== '' && value !== 0)

  return {
    id,
    title: text(['title']),
    state,
    archived: archivedFlag ?? (state === 'archived' ? true : null),
    isRunning: flag(['isRunning', 'running']),
    needsInput: flag(['needsInput', 'needs_input', 'awaitingInput', 'awaiting_input']),
    name: text(['name']) || null,
    link: text(['link', 'url']) || null,
    branch: branch === '' ? null : branch,
    parentSessionId: text(['parentSessionId', 'parent_session_id']) || null,
    startedBy: text(['startedBy', 'started_by']) || null,
    detached: flag(['detached']),
    pr: prValue !== undefined ? 'yes' : hasPrKey ? 'no' : 'unknown',
    keys: Object.keys(data).slice(0, 40),
  }
}

/**
 * The entries of a list_sessions answer: an array, `{ sessions: [...] }`, or the JSON array in its text (prose around
 * it allowed). Null when the answer holds none: a listing that could not be read, never an empty one.
 */
export function parseSessions(structured: unknown, text: string): SessionEntry[] | null {
  const fromValue = (value: unknown): SessionEntry[] | null => {
    const list = Array.isArray(value) ? value : typeof value === 'object' && value !== null && Array.isArray((value as Record<string, unknown>)['sessions']) ? ((value as Record<string, unknown>)['sessions'] as unknown[]) : null
    if (list === null) return null

    return list.flatMap(item => {
      const entry = typeof item === 'object' && item !== null && !Array.isArray(item) ? entryOf(item as Record<string, unknown>) : null

      return entry === null ? [] : [entry]
    })
  }
  const given = fromValue(structured)
  if (given !== null) return given
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start >= 0 && end > start) {
    try {
      const parsed = fromValue(JSON.parse(text.slice(start, end + 1)) as unknown)
      if (parsed !== null) return parsed
    } catch {
      // Not the array: try the object below.
    }
  }
  const object = parseObject(undefined, text)

  return Array.isArray(object['sessions']) ? fromValue(object) : null
}

/** How many sessions one tracking pass lists at most (most recent first). */
export const LIST_LIMIT = 50

export type Listing = { ok: true; entries: SessionEntry[]; isFull: boolean; via: DesktopRoute } | { ok: false; reason: string; isTransport: boolean }

/**
 * The app's active sessions, read quietly (never a card): one list_sessions WITHOUT `include_archived` and without
 * `linked` (A-F3, S3): an id it lists is active; an id it misses while it lists fewer than its limit is not active.
 */
export async function listSessions($: EngineInterface, options: QuietOptions = {}): Promise<Listing> {
  const answer = await quietDesktop($, 'ccd_session_mgmt', 'list_sessions', { limit: LIST_LIMIT }, options)
  if (!answer.ok) return { ok: false, reason: answer.reason, isTransport: answer.isTransport }
  const entries = parseSessions(answer.structured, answer.text)
  if (entries === null) return { ok: false, reason: `no session list in the answer: ${answer.text.replace(/\s+/g, ' ').slice(0, 80)}`, isTransport: false }

  return { ok: true, entries, isFull: entries.length >= LIST_LIMIT, via: answer.via }
}

/** What one quiet get_session said of a session: found (with what it said), gone (the app's own words), or not known. */
export type Peek = { kind: 'found'; entry: SessionEntry } | { kind: 'gone' } | { kind: 'unknown'; reason: string }

/**
 * One session read quietly (never a card): `gone` only when the app's own answer says this session does not exist
 * (saysSessionGone); a transport failure, a timeout or any other error is `unknown`, never gone (A-F2). An answer
 * without a readable entry is found, with what it said.
 */
export async function peekSession($: EngineInterface, sessionId: string, options: QuietOptions = {}): Promise<Peek> {
  const answer = await quietDesktop($, 'ccd_session_mgmt', 'get_session', { session_id: sessionId }, options)
  if (!answer.ok) {
    if (!answer.isTransport && saysSessionGone(answer.text === '' ? answer.reason : answer.text, sessionId)) return { kind: 'gone' }

    return { kind: 'unknown', reason: answer.reason }
  }
  const data = parseObject(answer.structured, answer.text)
  const entry = entryOf(data) ?? entryOf({ ...data, sessionId })
  if (entry === null) return { kind: 'unknown', reason: 'no readable answer' }
  // Only fall back to the prose when the answer carried no JSON: a parsed reply's `"archived": false` must not count.
  const prose = Object.keys(data).length === 0 && /\barchived\b/i.test(answer.text) && !/\b(?:not|un)archived\b/i.test(answer.text)

  return { kind: 'found', entry: prose ? { ...entry, archived: true } : entry }
}

/** This session's own id as the desktop app names it (get_session 'self', quiet); empty when it did not answer (S4). */
export async function readSelfId($: EngineInterface): Promise<{ id: string; reason: string }> {
  const answer = await quietDesktop($, 'ccd_session_mgmt', 'get_session', { session_id: 'self' })
  if (!answer.ok) return { id: '', reason: answer.reason }
  const entry = entryOf(parseObject(answer.structured, answer.text))

  return entry === null ? { id: '', reason: 'no session id in the answer' } : { id: entry.id, reason: '' }
}

/** Restores an archived session for a press (`consent` says which); the app's refusal is the result. */
export async function unarchiveSession($: EngineInterface, sessionId: string, consent?: string): Promise<{ ok: boolean; reason: string }> {
  const answer = await callDesktop($, 'ccd_session_mgmt', 'unarchive_session', { session_id: sessionId }, consent)

  return answer.ok ? { ok: true, reason: '' } : { ok: false, reason: answer.reason }
}

export type OpenOutcome = { outcome: 'shown' | 'already' | 'refused'; reason: string }

/**
 * What open_session_in answered: refused on an error, a structured `ok: false` or `changed: false`, or prose that says
 * nothing changed (the app "changes nothing and says so"); already when it says the target was visible; shown else.
 */
export function readOpenAnswer(answer: DesktopCall): OpenOutcome {
  if (!answer.ok) return { outcome: 'refused', reason: answer.reason }
  const data = parseObject(answer.structured, answer.text)
  const first = answer.text.split('\n')[0]?.slice(0, 120) ?? ''
  if (data['ok'] === false || data['changed'] === false) return { outcome: 'refused', reason: first }
  if (data['noop'] === true || data['alreadyVisible'] === true || /\balready (?:visible|open|shown)\b|\bno-?op\b/i.test(answer.text)) return { outcome: 'already', reason: first }
  if (/not on screen|changes? nothing|nothing changed|did(?:n'?t| not) change|refus|looking at another|text field|not started by|cannot|can'?t/i.test(answer.text)) {
    return { outcome: 'refused', reason: first }
  }

  return { outcome: 'shown', reason: '' }
}

/** Shows a session the pane started, for a press; the app's refusal (not started by this session, not on screen, a text field holds the cursor) is the result. */
export async function openSessionIn($: EngineInterface, sessionId: string, target: 'split' | 'focus', consent?: string): Promise<OpenOutcome> {
  return readOpenAnswer(await callDesktop($, 'ccd_window', 'open_session_in', { session_id: sessionId, target }, consent))
}

/** Detaches a session the mod adopted on its own (no press, so never a card): the quiet route. */
export async function detachQuietly($: EngineInterface, sessionId: string): Promise<boolean> {
  return (await quietDesktop($, 'ccd_session_mgmt', 'detach_session', { session_id: sessionId })).ok
}

// The pull request the app binds to an issue session (E3) -------------------

type Fields = Record<string, unknown>

function recordIn(data: Fields, keys: readonly string[]): Fields | undefined {
  for (const key of keys) {
    const value = data[key]
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Fields
  }

  return undefined
}

function firstOf(data: Fields | undefined, keys: readonly string[]): unknown {
  if (data === undefined) return undefined
  for (const key of keys) if (data[key] !== undefined && data[key] !== null) return data[key]

  return undefined
}

/** A count the answer gives as a number, or as a list of what it counts; null when it gives neither. */
function tally(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value)

  return Array.isArray(value) ? value.length : null
}

/** The failing checks' names: strings, or records with a `name`; at most 5, each cut to 40 characters. */
function namesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  return value
    .map(item => (typeof item === 'string' ? item : typeof item === 'object' && item !== null && typeof (item as Fields)['name'] === 'string' ? ((item as Fields)['name'] as string) : ''))
    .map(name => name.replace(/\s+/g, ' ').trim())
    .filter(name => name !== '')
    .slice(0, 5)
    .map(name => (name.length > 40 ? `${name.slice(0, 39)}…` : name))
}

/**
 * The bound pull request in what `ccd_pr` `get_status` answered, or null when it names none. The field names are
 * provisional until the spike records a real answer (S14): the number from `number`, `pr_number` or the URL; the
 * state upper-cased, a draft as `DRAFT`; the check counts from `checks`, `ci` or `check_counts` (numbers, or lists);
 * the failing checks' names; the review decision; the mergeability.
 */
export function parsePrStatus(structured: unknown, text: string, now: number): SessionPr | null {
  const data = parseObject(structured, text)
  const pr = recordIn(data, ['pr', 'pull_request', 'pullRequest', 'bound_pr', 'boundPr']) ?? data
  const url = String(firstOf(pr, ['url', 'html_url', 'htmlUrl']) ?? '')
  const given = Number(firstOf(pr, ['number', 'pr_number', 'prNumber']))
  const number = Number.isInteger(given) && given > 0 ? given : Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? Number.NaN)
  if (!Number.isInteger(number) || number <= 0) return null
  const draft = firstOf(pr, ['draft', 'isDraft', 'is_draft']) === true
  const stated = String(firstOf(pr, ['state', 'status']) ?? '').toUpperCase()
  const state: SessionPr['state'] = draft ? 'DRAFT' : stated === 'OPEN' || stated === 'MERGED' || stated === 'CLOSED' || stated === 'DRAFT' ? stated : ''
  const checks = recordIn(data, ['checks', 'ci', 'check_counts', 'checkCounts', 'ci_checks']) ?? recordIn(pr, ['checks', 'ci', 'check_counts', 'checkCounts']) ?? {}
  const failingList = firstOf(checks, ['failing', 'failing_checks', 'failingChecks', 'failed_checks']) ?? firstOf(data, ['failing_checks', 'failingChecks'])
  const failed = tally(firstOf(checks, ['failed', 'failure', 'failures'])) ?? tally(failingList) ?? 0
  const merge = firstOf(data, ['mergeable', 'mergeability', 'mergeable_state', 'merge_state_status', 'mergeStateStatus']) ?? firstOf(pr, ['mergeable', 'mergeability', 'mergeable_state'])

  return {
    number,
    url,
    repo: repoOfPr(url),
    state,
    review: asReview(firstOf(data, ['review_decision', 'reviewDecision']) ?? firstOf(pr, ['review_decision', 'reviewDecision'])),
    passed: tally(firstOf(checks, ['passed', 'passing', 'success', 'successful', 'succeeded'])) ?? 0,
    failed,
    pending: tally(firstOf(checks, ['pending', 'in_progress', 'inProgress', 'queued', 'running'])) ?? 0,
    failing: namesOf(failingList),
    mergeable: typeof merge === 'boolean' ? (merge ? 'MERGEABLE' : 'CONFLICTING') : String(merge ?? '').toUpperCase(),
    at: now,
  }
}

export type PrStatusLook = { kind: 'pr'; pr: SessionPr; raw: string } | { kind: 'none'; raw: string } | { kind: 'failed'; reason: string; isTransport: boolean }

/**
 * What the app binds to a session as its pull request, read quietly (never a card): the app's cache, no GitHub
 * budget. `none` when the app answered and names no pull request; `failed` when it did not answer, or answered with an
 * error (E3-1: the caller backs off that one session, never the whole layer).
 */
export async function readPrStatus($: EngineInterface, sessionId: string, now: number, options: QuietOptions = {}): Promise<PrStatusLook> {
  const answer = await quietDesktop($, 'ccd_pr', 'get_status', { session_id: sessionId }, options)
  if (!answer.ok) return { kind: 'failed', reason: answer.reason, isTransport: answer.isTransport }
  const raw = answer.text.slice(0, 400)
  const pr = parsePrStatus(answer.structured, answer.text, now)

  return pr === null ? { kind: 'none', raw } : { kind: 'pr', pr, raw }
}
