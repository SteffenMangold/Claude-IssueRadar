// The desktop app's session tools, reached from the mod: starting an issue
// session (two routes and a floor), detaching it, opening it again. Which
// route works is the project's spike item S1; the module remembers the one
// that did.
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

export type DesktopCall = { ok: true; text: string; structured: unknown } | { ok: false; reason: string; text: string }

export type StartOutcome = {
  route: StartRoute
  sessionId: string | null
  /** What the app answered, cut short, for the spike notes and the debug log. */
  raw: string
  /** Why no route started a session. */
  reason?: string
}

/** The route that last worked; a later call tries it first. */
let knownRoute: Exclude<StartRoute, 'none'> | null = null

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

async function viaMcp($: EngineInterface, server: string, tool: string, args: Record<string, unknown>): Promise<DesktopCall> {
  try {
    const result = await $.mcp.call(server, tool, args)
    const text = textOf(result.content)
    if (result.isError) return { ok: false, reason: text.slice(0, 160) || 'the tool reported an error', text }

    return { ok: true, text, structured: result.structuredContent }
  } catch (error) {
    return { ok: false, reason: reasonOf(error), text: '' }
  }
}

async function viaTool($: EngineInterface, server: string, tool: string, args: Record<string, unknown>): Promise<DesktopCall> {
  try {
    // The laid types know the desktop's tools only after the first load; the input is `{ tool, ...arguments }`.
    // The engine requires `$.tool.call(...)` spelled at the call site: the cast goes on the argument and the result.
    const result = (await $.tool.call({ tool: `mcp__${server}__${tool}`, ...args } as never)) as unknown as Record<string, unknown>
    if (typeof result['deny'] === 'string') return { ok: false, reason: result['deny'], text: '' }
    const text = typeof result['text'] === 'string' ? result['text'] : textOf((result['result'] as { content?: unknown } | undefined)?.content ?? result['result'])
    if (result['isError'] === true) return { ok: false, reason: text.slice(0, 160) || 'the tool reported an error', text }

    return { ok: true, text, structured: result['result'] }
  } catch (error) {
    return { ok: false, reason: reasonOf(error), text: '' }
  }
}

/** Calls a desktop tool by the route that started the last session, or by both routes in order. */
export async function callDesktop($: EngineInterface, server: string, tool: string, args: Record<string, unknown>): Promise<DesktopCall> {
  if (knownRoute === 'tool') return viaTool($, server, tool, args)
  if (knownRoute === 'mcp') return viaMcp($, server, tool, args)
  const first = await viaMcp($, server, tool, args)
  if (first.ok) return first

  return viaTool($, server, tool, args)
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

/** Starts a desktop session: `$.mcp.call` first, the typed tool call second; `route: 'none'` means the caller falls back to the prompt box. */
export async function startDesktopSession($: EngineInterface, args: StartArgs): Promise<StartOutcome> {
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

  const attempts: Array<{ route: Exclude<StartRoute, 'none'>; run: () => Promise<DesktopCall> }> = []
  const mcp = { route: 'mcp' as const, run: () => viaMcp($, 'ccd_session', 'start_session', input) }
  const tool = { route: 'tool' as const, run: () => viaTool($, 'ccd_session', 'start_session', input) }
  attempts.push(...(knownRoute === 'tool' ? [tool, mcp] : [mcp, tool]))

  const reasons: string[] = []
  for (const attempt of attempts) {
    const answer = await attempt.run()
    if (answer.ok) {
      knownRoute = attempt.route
      const sessionId = parseSessionId(answer.structured, answer.text)
      $.ui.log(`issue-radar: start_session via ${attempt.route}: ${answer.text.slice(0, 400)}`, { to: 'debug' })

      return { route: attempt.route, sessionId, raw: answer.text.slice(0, 400) }
    }
    reasons.push(`${attempt.route}: ${answer.reason}`)
    $.ui.log(`issue-radar: start_session via ${attempt.route} failed: ${answer.reason}`, { to: 'debug' })
  }

  return { route: 'none', sessionId: null, raw: '', reason: reasons.join('; ') }
}

/** Moves a session the pane started to the top level; false when the app refused or the route is unknown. */
export async function detachSession($: EngineInterface, sessionId: string): Promise<{ ok: boolean; reason?: string }> {
  const answer = await callDesktop($, 'ccd_session_mgmt', 'detach_session', { session_id: sessionId })
  if (!answer.ok) return { ok: false, reason: answer.reason }
  $.ui.log(`issue-radar: detach_session: ${answer.text.slice(0, 200)}`, { to: 'debug' })

  return { ok: true }
}

export type SessionLook = { exists: true; isArchived: boolean; title: string; link: string | null; state: string } | { exists: false }

/** What the app knows about a session the pane started. */
export async function lookUpSession($: EngineInterface, sessionId: string): Promise<SessionLook> {
  const answer = await callDesktop($, 'ccd_session_mgmt', 'get_session', { session_id: sessionId })
  if (!answer.ok) {
    const said = answer.reason.toLowerCase()
    // A failure of the call itself (no such server or tool, a refused route) says nothing about the
    // session; only an answer about the session releases it. Anything else keeps the mapping.
    const aboutTransport = /\b(server|tool|route|connect|permission)/.test(said)
    const saysMissing = said.includes('not found') || said.includes('unknown') || said.includes('no session') || said.includes('does not exist')
    if (!aboutTransport && saysMissing) return { exists: false }

    return { exists: true, isArchived: false, title: '', link: null, state: 'unknown' }
  }
  let data: Record<string, unknown> = {}
  if (typeof answer.structured === 'object' && answer.structured !== null) data = answer.structured as Record<string, unknown>
  else {
    try {
      const start = answer.text.indexOf('{')
      if (start >= 0) data = JSON.parse(answer.text.slice(start)) as Record<string, unknown>
    } catch {
      data = {}
    }
  }
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

/** Focuses a session the pane started; false when the app refused (not started by this session, not on screen, a text field holds the cursor). */
export async function focusSession($: EngineInterface, sessionId: string): Promise<{ ok: boolean; reason?: string }> {
  const answer = await callDesktop($, 'ccd_window', 'open_session_in', { session_id: sessionId, target: 'focus' })

  return answer.ok ? { ok: true } : { ok: false, reason: answer.reason }
}
