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

import type { StartRoute } from '../types'

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
/** How long the mcp route is left alone by quiet calls after it failed at transport level. */
const MCP_RETRY_MS = 10 * 60_000

/** The route that last started a session, for the spike notes; it no longer decides the order of the routes. */
let knownRoute: DesktopRoute | null = null
/** Until when quiet calls skip the mcp route, after it failed at transport level. */
let mcpBrokenUntil = 0

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

/**
 * Calls a desktop tool on the mod's own initiative (a refresh, tracking, an issue session reading itself): never an
 * approval card. `$.mcp.call` first, unless it failed at transport level in the last ten minutes; the typed route
 * only when `$.tool.check` answers `allow` for exactly this call. Each attempt is raced against `timeoutMs` on the
 * engine's clock; a timeout reads as no answer (`isTransport`), never as a session that is gone.
 */
export async function quietDesktop($: EngineInterface, server: string, tool: string, args: Record<string, unknown>, timeoutMs = QUIET_TIMEOUT_MS): Promise<DesktopCall> {
  const now = await $.clock.now()
  let first: DesktopCall | null = null
  if (now >= mcpBrokenUntil) {
    const answer = await withTimeout($, viaMcp($, server, tool, args), timeoutMs)
    if (answer === TIMED_OUT) return timedOut('mcp', timeoutMs)
    if (answer.ok || !answer.isTransport) return answer
    mcpBrokenUntil = now + MCP_RETRY_MS
    first = answer
  }
  const verdict = await $.tool.check({ tool: `mcp__${server}__${tool}`, input: args }).catch(() => null)
  const decision = verdict?.decision ?? 'none'
  if (decision !== 'allow') {
    const why = `the typed route would ${decision === 'none' ? 'not be decided' : decision}`

    return { ok: false, reason: first === null ? why : `mcp: ${first.reason}; ${why}`, text: '', via: 'none', isTransport: true }
  }
  const answer = await withTimeout($, viaTool($, server, tool, args), timeoutMs)

  return answer === TIMED_OUT ? timedOut('tool', timeoutMs) : answer
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

/** What the app knows about a session the pane started, read for a press. */
export async function lookUpSession($: EngineInterface, sessionId: string, consent?: string): Promise<SessionLook> {
  const answer = await callDesktop($, 'ccd_session_mgmt', 'get_session', { session_id: sessionId }, consent)
  if (!answer.ok) {
    const said = answer.reason.toLowerCase()
    // A failure of the call itself (no such server or tool, a refused route, no answer) says nothing about the
    // session; only the app's answer about the session releases it. Anything else keeps the mapping.
    const aboutTransport = answer.isTransport || /\b(server|tool|route|connect|permission)/.test(said)
    const saysMissing = said.includes('not found') || said.includes('unknown') || said.includes('no session') || said.includes('does not exist')
    if (!aboutTransport && saysMissing) return { exists: false }

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

/** Focuses a session the pane started, for a press; false when the app refused (not started by this session, not on screen, a text field holds the cursor). */
export async function focusSession($: EngineInterface, sessionId: string, consent?: string): Promise<{ ok: boolean; reason?: string }> {
  const answer = await callDesktop($, 'ccd_window', 'open_session_in', { session_id: sessionId, target: 'focus' }, consent)

  return answer.ok ? { ok: true } : { ok: false, reason: answer.reason }
}
