// The shared test harness: a desktop session in a checkout of acme/widgets
// with two open issues. The test's hooks stand for the engine beneath the
// plugin (the first registration of an event answers it); `project` records
// what the plugin asked of them, so tests assert on keys and argv, not on
// incidental text.
import type { PromptAutocompleteSuggestion, PromptSubmitInput, RegisteredToolSpec, RenderSurface, UiOpenResult } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { MockClock, TestBody } from 'claude-code/testing'

export const PANE = {
  plugin: 'issue-radar',
  component: 'Pane',
  requestId: 'issue-radar',
  props: {
    title: 'Issues',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

export const SECTION = 'github.com/acme/widgets'
export const ROW_42 = `${SECTION}#42`
export const ROW_7 = `${SECTION}#7`
/** Where the mocked clock starts. */
export const NOW = Date.parse('2026-11-06T12:00:00.000Z')
/** One timer period at the default interval (refreshMinutes 3). */
export const TICK_MS = 180_000

export const REPO = JSON.stringify({
  nameWithOwner: 'acme/widgets',
  isPrivate: false,
  hasIssuesEnabled: true,
  isArchived: false,
  isFork: false,
  url: 'https://github.com/acme/widgets',
  defaultBranchRef: { name: 'main' },
})

export const ISSUES = JSON.stringify([
  {
    number: 42,
    title: 'Export fails for empty folders',
    url: 'https://github.com/acme/widgets/issues/42',
    createdAt: '2026-11-03T10:00:00Z',
    updatedAt: '2026-11-05T09:00:00Z',
    author: { login: 'reporter' },
    labels: [{ name: 'bug', color: 'd73a4a' }],
    assignees: [],
    milestone: null,
    isPinned: false,
  },
  {
    number: 7,
    title: 'Dark mode for the settings page',
    url: 'https://github.com/acme/widgets/issues/7',
    createdAt: '2026-10-01T10:00:00Z',
    updatedAt: '2026-11-01T09:00:00Z',
    author: { login: 'designer' },
    labels: [],
    assignees: [{ login: 'steffen' }],
    milestone: { title: 'v2' },
    isPinned: true,
  },
])

/** `gh issue view <n> --json …` for one of the two issues; `extra` overrides fields (`closedByPullRequestsReferences`, `body` …). */
export function issueView(number: number, state = 'OPEN', extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number,
    state,
    body: 'The export throws on a folder without files.\n\nExpected: an empty archive instead.',
    comments: [{ author: { login: 'maintainer' }, createdAt: '2026-11-04T08:00:00Z', body: 'Can reproduce on main.' }],
    updatedAt: number === 42 ? '2026-11-05T09:00:00Z' : '2026-11-01T09:00:00Z',
    closedByPullRequestsReferences: [],
    url: `https://github.com/acme/widgets/issues/${number}`,
    ...extra,
  })
}

export type Ran = { value: { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean } }

export function ran(stdout: string, exitCode = 0, stderr = ''): Ran {
  return { value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } }
}

/** What `gh api graphql` answers: the body on stdout, exit 1 and gh's message on stderr when there are errors. */
export function graphAnswer(data: unknown, errors?: ReadonlyArray<Record<string, unknown>>): Ran {
  const first = errors?.[0]

  return errors === undefined ? ran(JSON.stringify({ data })) : ran(JSON.stringify({ data, errors }), 1, `gh: ${String(first?.['message'] ?? 'error')}`)
}

/** The GraphQL operation a recorded argv names (`IssueRadarProbe`), or null for any other command. */
export function op(argv: readonly string[]): string | null {
  const query = argv.find(arg => arg.startsWith('query='))

  return query === undefined ? null : (/^query=\s*(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? null)
}

/** How many recorded gh calls start with these words (`count(argv, 'issue', 'list')`). */
export function count(argv: readonly (readonly string[])[], ...words: string[]): number {
  return argv.filter(call => call[0] === 'gh' && words.every((word, index) => call[index + 1] === word)).length
}

/** The recorded GraphQL calls of one operation (`ops(argv, 'IssueRadarProbe')`), in order. */
export function ops(argv: readonly (readonly string[])[], name: string): string[][] {
  return argv.filter(call => op(call) === name).map(call => [...call])
}

/** The query a recorded GraphQL argv sends (the text after `query=`); empty for any other command. */
export function graphQuery(argv: readonly string[]): string {
  return argv.find(arg => arg.startsWith('query='))?.slice('query='.length) ?? ''
}

/** The flag and value pairs of a recorded argv (`-f owner=acme`, `-F first=2`), for `toContain`. */
export function pairs(argv: readonly string[]): string[] {
  return argv.flatMap((arg, index) => (arg.startsWith('-') && index + 1 < argv.length ? [`${arg} ${argv[index + 1] ?? ''}`] : []))
}

export const USAGE = { input_tokens: 300, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

export type On = Parameters<TestBody>[1]
export type Engine = Parameters<TestBody>[0]
export type McpCall = { server: string; tool: string; args: Record<string, unknown> }
export type McpAnswer = { value: { content: Array<{ type: 'text'; text: string }>; isError: boolean; structuredContent?: unknown } }
export type CheckDecision = 'allow' | 'ask' | 'deny'
/** A `$.tool.check` verdict with what stands behind it (a rule, another plugin's hook), as the engine answers a query (no classic hook runs there, B4-BEH-2). */
export type CheckVerdict = { decision: CheckDecision; reason?: string; rule?: string; plugin?: string }

/** An answer of the desktop app to `$.mcp.call`: text, optionally an error. */
export function mcpText(text: string, isError = false): McpAnswer {
  return { value: { content: [{ type: 'text', text }], isError } }
}

export type Setup = {
  /** What gh answers to `gh repo view`; the default is a healthy repository. */
  repo?: () => Ran
  /** Answers a gh call by its argv (without the leading `gh`) before the defaults; undefined leaves it to them. */
  gh?: (args: readonly string[]) => Ran | undefined | Promise<Ran | undefined>
  /** Values the store holds before the session starts. */
  stored?: Record<string, unknown>
  /** What `session.surfaces` answers; the default is a desktop. */
  surfaces?: RenderSurface[]
  /** What `ui.open` answers, asked at each open (so whether `$.ui.panes()` lists the pane as placed); the default places it. */
  open?: () => { value: UiOpenResult }
  /** What the desktop answers to `$.mcp.call`; the default starts and reports sessions. A throw stands for a server the engine cannot reach. */
  mcp?: (call: McpCall) => McpAnswer | Promise<McpAnswer>
  /** What a typed `$.tool.call` gets beneath the plugin; the default refuses it as an unknown tool. */
  toolCall?: (input: Record<string, unknown>) => Record<string, unknown>
  /** What a `$.tool.check` query (no tool_use_id) is answered, a decision or a whole verdict; the default is 'ask'. */
  check?: (tool: string, input: unknown) => CheckDecision | CheckVerdict
  /** What `$.tool.register` answers (E6); a throw stands for a host that adds no tools at run time. The default registers `mcp__issue-radar__<name>`. */
  register?: (spec: RegisteredToolSpec) => { tool: string }
  /** The rows the hooks beneath the plugin add to a `#` typeahead (`prompt.autocomplete`); none by default. */
  autocomplete?: () => PromptAutocompleteSuggestion[]
  /** What `$.session.id()` answers until `setSessionId` changes it; the default is 'local_pane'. */
  sessionId?: string
  /** The `origin` remote `$.session.repo()` names; the default is https://github.com/acme/widgets. */
  remote?: string
  /** What `$.tool.list()` answers, given the tool names the plugin registered; the default lists exactly those (R4-RT-3). */
  tools?: (registered: readonly string[]) => readonly string[]
  /** Whether a placed pane is shown at the start (not behind another tab); the default is true. */
  isShown?: boolean
  /** Which `$.store.set` keys the store refuses, asked at each write (a store past 4 MiB rejects every write); none by default. */
  storeRefuses?: (key: string) => boolean
  /**
   * Holds the answer to `$.store.get` of a key until the promise it returns settles, the value read before the wait (a
   * slow store, so two readers both see what was there); undefined answers at once, as the default does for every key.
   */
  storeDelay?: (key: string) => Promise<unknown> | undefined
  /** The text the model answers a `$.model.complete` with, per request; the default is V1's plain German recap. */
  model?: (request: { prompt: string; system: string }) => string
  /** The main conversation's messages `$.session.messages()` answers until `setMessages` changes them; none by default. */
  messages?: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>
  /**
   * Answers a git call by its argv (without the leading `git`); undefined, or no `git`, answers as a plain checkout
   * on main (`git rev-parse`: the branch, the git dir and the common dir alike; `git status`: clean).
   */
  git?: (args: readonly string[]) => Ran | undefined
  /** What `$.session.model()` answers; the default is 'claude-opus-test'. */
  sessionModel?: string
  /** The context window's input tokens `$.session.usage()` reports; absent by default (before the first response). */
  contextTokens?: number
}

/** `git rev-parse --abbrev-ref HEAD --path-format=absolute --git-dir --git-common-dir` in a plain checkout on `branch`. */
export function plainCheckout(branch = 'main'): Ran {
  return ran(`${branch}\nD:/proj/.git\nD:/proj/.git\n`)
}

/** The same in a linked worktree of the checkout on `branch` (the git dir differs from the common dir). */
export function linkedWorktree(branch = 'feature/x'): Ran {
  return ran(`${branch}\nD:/proj/.git/worktrees/wt1\nD:/proj/.git\n`)
}

/** The model's default answer: a plain sentence, as V1 asked it (no JSON, so no triage). */
export const PLAIN_RECAP = 'Der Export bricht bei leeren Ordnern ab; erwartet wird stattdessen ein leeres Archiv.'

export type Project = {
  store: Map<string, unknown>
  mcp: McpCall[]
  /** The ids of every `ui.open`, in order. */
  opened: string[]
  /** The titles of every `ui.open`, in order. */
  titles: string[]
  /** The texts put into the prompt box, in order; the composer keeps them as its draft. */
  filled: string[]
  /** Every `$.process.run` argv, in order. */
  argv: string[][]
  /** Every toast's text, in order. */
  toasts: string[]
  /** Every typed `$.tool.call` input that reached beneath the plugin. */
  toolCalls: Record<string, unknown>[]
  /** Every `$.tool.check` query (not a typed call's own check). */
  checks: Array<{ tool: string; input: unknown }>
  /** The ids of every `ui.close`, in order. */
  closed: string[]
  /**
   * Every `$.ui.log` line, in order. The 2.1.317 kit has no implementation beneath a plugin's `$.ui.scroll` (the call
   * rejects, no test hook is raised), so a scroll is seen only through the line the plugin logs when it is refused.
   */
  logs: string[]
  /** The prompt of every `$.model.complete` (a recap's names the issue's title), in order. */
  prompts: string[]
  /** The system prompt of every `$.model.complete`, in order (empty where none was given). */
  systems: string[]
  /** Shows or hides a placed pane (another tab in front of it), as `$.ui.panes()` reports it. */
  setShown: (isShown: boolean) => void
  /** Every tool spec the plugin registered (E6), in order. */
  registered: RegisteredToolSpec[]
  /** Every prompt that reached beneath the plugin's `prompt.submit` hook, with the context it carried (E2). */
  submitted: PromptSubmitInput[]
  /** Sets what `$.session.turns()` answers (the user turns so far; 0 at the start). */
  setTurns: (turns: number) => void
  /** Sets what `$.session.id()` answers from now on (a /clear or a resume goes on under another id). */
  setSessionId: (id: string) => void
  /** Every `$.ui.status` text, in order (undefined: the line was cleared). */
  statuses: Array<string | undefined>
  /** Sets what `$.session.messages()` answers (the main conversation's rows). */
  setMessages: (messages: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>) => void
}

/**
 * A desktop session in a checkout of acme/widgets with two open issues. The test's hooks stand for the engine: the
 * first registration of an event answers it. `$.ui.panes()` lists a pane as the engine does: only between its
 * `ui.open` and its `ui.close`, placed as that open answered, and shown only while placed (and not hidden by
 * `setShown(false)`); so a pane never opened, closed with ✕, or waiting on `no-surface` is not shown.
 */
export function project(on: On, setup: Setup = {}): Project {
  const store = new Map<string, unknown>(Object.entries(setup.stored ?? {}))
  const mcp: McpCall[] = []
  const opened: string[] = []
  const titles: string[] = []
  const closed: string[] = []
  const filled: string[] = []
  const argv: string[][] = []
  const toasts: string[] = []
  const toolCalls: Record<string, unknown>[] = []
  const checks: Array<{ tool: string; input: unknown }> = []
  const logs: string[] = []
  const prompts: string[] = []
  const systems: string[] = []
  const registered: RegisteredToolSpec[] = []
  const submitted: PromptSubmitInput[] = []
  const statuses: Array<string | undefined> = []
  let messages = setup.messages ?? []
  let turns = 0
  let sessionId = setup.sessionId ?? 'local_pane'
  /** The full names `$.tool.register` answered, in order. */
  const toolNames: string[] = []
  /** The open panes by id: the title and whether the latest open placed them. */
  const panes = new Map<string, { title: string; isPlaced: boolean }>()
  let isShown = setup.isShown ?? true
  let draft = ''
  on('store.get', (_, e) => {
    const value = store.get(e.key)
    const delay = setup.storeDelay?.(e.key)

    return delay === undefined ? { value } : delay.then(() => ({ value }))
  })
  on('store.set', (_, e) => {
    if (setup.storeRefuses?.(e.key) === true) throw new Error('the store is over 4 MiB of JSON text')
    store.set(e.key, e.value)

    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)

    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    titles.push(e.title ?? '')
    const answer: { value: UiOpenResult } = setup.open === undefined ? { value: { isPlaced: true } } : setup.open()
    panes.set(e.id, { title: e.title ?? e.id, isPlaced: answer.value.isPlaced })

    return answer
  })
  on('ui.close', (_, e) => {
    closed.push(e.id)
    panes.delete(e.id)

    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: [...panes].map(([id, pane]) => ({ id, title: pane.title, isShown: pane.isPlaced && isShown, isFocused: false, isPlaced: pane.isPlaced })),
  }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.log', (_, e) => {
    logs.push(e.text)

    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    statuses.push(e.text)

    return { value: undefined }
  })
  // The engine's own turn handling beneath the plugin (E12): a test raises turns with $.turn.start / $.turn.complete.
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.messages', () => ({ value: messages.map(message => ({ role: message.role, text: message.text, toolUses: [] })) }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  on('session.root', () => ({ value: 'D:\\proj' }))
  on('session.id', () => ({ value: sessionId }))
  on('session.repo', () => ({ value: { root: 'D:\\proj', remote: setup.remote ?? 'https://github.com/acme/widgets', internal: false, name: null } }))
  on('session.surfaces', () => ({ value: setup.surfaces ?? ['desktop'] }))
  on('fs.read', () => ({ value: '{ "name": "issue-radar", "version": "9.9.9" }' }))
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('prompt.submit', (_, e) => {
    submitted.push(e)

    return e.context === undefined ? { text: e.text } : { text: e.text, context: e.context }
  })
  on('prompt.autocomplete', () => ({ suggestions: setup.autocomplete?.() ?? [] }))
  on('session.turns', () => ({ value: turns }))
  on('session.model', () => ({ value: setup.sessionModel ?? 'claude-opus-test' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000, ...(setup.contextTokens === undefined ? {} : { tokens: setup.contextTokens }) }, rateLimits: [] } }))
  on('tool.register', (_, e) => {
    registered.push(e)
    const answer = setup.register === undefined ? { tool: `mcp__issue-radar__${e.name}` } : setup.register(e)
    toolNames.push(answer.tool)

    return { value: answer }
  })
  on('tool.list', () => ({ value: (setup.tools === undefined ? toolNames : setup.tools(toolNames)).map(name => ({ name, description: name, mcp: name.startsWith('mcp__') })) }))
  on('prompt.fill', (_, e) => {
    draft = e.mode === 'append' ? draft + e.text : e.text
    filled.push(e.text)

    return { isFilled: true, text: draft, cursor: draft.length }
  })
  on('process.run', async (_, e) => {
    const call = [...e.argv]
    argv.push(call)
    if (call[0] === 'git') {
      const own = setup.git?.(call.slice(1))
      if (own !== undefined) return own

      return call[1] === 'rev-parse' ? plainCheckout() : ran('')
    }
    if (call[0] !== 'gh') return ran('')
    const own = setup.gh === undefined ? undefined : await setup.gh(call.slice(1))
    if (own !== undefined) return own
    if (call[1] === 'repo') return setup.repo === undefined ? ran(REPO) : setup.repo()
    if (call[1] === 'issue' && call[2] === 'list') return ran(ISSUES)
    if (call[1] === 'issue' && call[2] === 'view') return ran(issueView(Number(call[3])))

    return ran('')
  })
  on('model.complete', (_, e) => {
    prompts.push(e.prompt)
    systems.push(e.system ?? '')
    const text = setup.model === undefined ? PLAIN_RECAP : setup.model({ prompt: e.prompt, system: e.system ?? '' })

    return { value: { isAnswered: true, text, usage: USAGE } }
  })
  on('mcp.call', async (_, e) => {
    const call: McpCall = { server: e.server, tool: e.tool, args: (e.args ?? {}) as Record<string, unknown> }
    mcp.push(call)
    if (setup.mcp !== undefined) return setup.mcp(call)
    if (e.tool === 'start_session') return mcpText('Started session local_abc123 ("#42 Export fails for empty folders").')
    // Asked about itself, a session gets its own id (A-F8): never the issue session's, or a pane would take itself for it.
    if (e.tool === 'get_session' && call.args['session_id'] === 'self') return mcpText(JSON.stringify({ sessionId, title: 'Pane' }))
    if (e.tool === 'get_session') return mcpText('{"sessionId":"local_abc123","title":"#42 Export fails for empty folders","state":"idle"}')

    return mcpText('ok')
  })
  // A typed call the plugin makes raises its own check (it carries a tool_use_id): let it through, as a session
  // without a check hook would, so the call reaches the tool.call hook below. Only a query is answered by `check`.
  on('tool.check', (_, e) => {
    if (e.tool_use_id !== undefined) return { decision: 'allow' }
    checks.push({ tool: e.tool, input: e.input })
    const verdict = setup.check === undefined ? 'ask' : setup.check(e.tool, e.input)

    return typeof verdict === 'string' ? { decision: verdict } : verdict
  })
  on('tool.call', (_, e) => {
    const input = { ...(e as unknown as Record<string, unknown>) }
    toolCalls.push(input)

    return (setup.toolCall === undefined ? { deny: 'no such tool' } : setup.toolCall(input)) as never
  })

  return {
    store,
    mcp,
    opened,
    titles,
    filled,
    argv,
    toasts,
    toolCalls,
    checks,
    closed,
    logs,
    prompts,
    systems,
    setShown: value => {
      isShown = value
    },
    registered,
    submitted,
    setTurns: value => {
      turns = value
    },
    setSessionId: value => {
      sessionId = value
    },
    statuses,
    setMessages: value => {
      messages = value
    },
  }
}

/** Starts the session on a mocked clock and lets the start refresh run; returns the clock. */
export async function started($: Engine, on: On, surface: RenderSurface = 'desktop'): Promise<MockClock> {
  const clock = mock.clock(on, { now: NOW })
  await $.session.start({ cwd: 'D:\\proj', surface, isInteractive: true })
  await clock.advance(1_000)

  return clock
}

/** Moves the clock on by whole timer periods, letting each tick's refresh run. */
export async function tick(clock: MockClock, periods = 1): Promise<void> {
  for (let done = 0; done < periods; done++) await clock.advance(TICK_MS)
}

/** Runs one of the mod's commands as the owner would type it. */
export async function command($: Engine, name: string, args = ''): Promise<string> {
  const result = await $.command.run({ command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

  return result.text ?? ''
}
