import type { RenderSurface, UiOpenResult } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { branchName, renderBrief, sessionName, sessionTitle } from '../hooks/brief'
import { classify, excerptOf, isRepoSpec } from '../hooks/github'
import { trimRecap } from '../hooks/recap'
import { parseSessionId } from '../hooks/session'

const PANE = {
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

const SECTION = 'github.com/acme/widgets'
const ROW_42 = `${SECTION}#42`
const ROW_7 = `${SECTION}#7`

const REPO = JSON.stringify({
  nameWithOwner: 'acme/widgets',
  isPrivate: false,
  hasIssuesEnabled: true,
  isArchived: false,
  isFork: false,
  url: 'https://github.com/acme/widgets',
  defaultBranchRef: { name: 'main' },
})

const ISSUES = JSON.stringify([
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

function issueView(number: number, state = 'OPEN'): string {
  return JSON.stringify({
    number,
    state,
    body: 'The export throws on a folder without files.\n\nExpected: an empty archive instead.',
    comments: [{ author: { login: 'maintainer' }, createdAt: '2026-11-04T08:00:00Z', body: 'Can reproduce on main.' }],
    updatedAt: number === 42 ? '2026-11-05T09:00:00Z' : '2026-11-01T09:00:00Z',
    closedByPullRequestsReferences: [],
    url: `https://github.com/acme/widgets/issues/${number}`,
  })
}

function ran(stdout: string, exitCode = 0, stderr = '') {
  return { value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } }
}

const USAGE = { input_tokens: 300, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

type On = Parameters<TestBody>[1]
type Engine = Parameters<TestBody>[0]
type McpCall = { server: string; tool: string; args: Record<string, unknown> }
type McpAnswer = { value: { content: Array<{ type: 'text'; text: string }>; isError: boolean } }

type Setup = {
  /** What gh answers to `gh repo view`; the default is a healthy repository. */
  repo?: () => ReturnType<typeof ran>
  /** Values the store holds before the session starts. */
  stored?: Record<string, unknown>
  /** What `session.surfaces` answers; the default is a desktop. */
  surfaces?: RenderSurface[]
  /** What `ui.open` answers; the default places the pane. */
  open?: () => { value: UiOpenResult }
  /** What the desktop answers to `$.mcp.call`; the default starts and reports sessions. */
  mcp?: (call: McpCall) => McpAnswer
  /** What a typed `$.tool.call` gets beneath the plugin; registered only when given. */
  toolCall?: () => { deny: string }
}

type Project = {
  store: Map<string, unknown>
  mcp: McpCall[]
  opened: string[]
  /** The texts put into the prompt box, in order; the composer keeps them as its draft. */
  filled: string[]
}

/** A desktop session in a checkout of acme/widgets with two open issues. The test's hooks stand for the engine: the first registration of an event answers it. */
function project(on: On, setup: Setup = {}): Project {
  const store = new Map<string, unknown>(Object.entries(setup.stored ?? {}))
  const mcp: McpCall[] = []
  const opened: string[] = []
  const filled: string[] = []
  let draft = ''
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
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

    return setup.open === undefined ? { value: { isPlaced: true } } : setup.open()
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [{ id: 'issue-radar', title: 'Issues', isShown: true, isFocused: false, isPlaced: true }] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  on('session.root', () => ({ value: 'D:\\proj' }))
  on('session.id', () => ({ value: 'local_pane' }))
  on('session.repo', () => ({ value: { root: 'D:\\proj', remote: 'https://github.com/acme/widgets', internal: false, name: null } }))
  on('session.surfaces', () => ({ value: setup.surfaces ?? ['desktop'] }))
  on('fs.read', () => ({ value: '{ "name": "issue-radar", "version": "9.9.9" }' }))
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('prompt.fill', (_, e) => {
    draft = e.mode === 'append' ? draft + e.text : e.text
    filled.push(e.text)

    return { isFilled: true, text: draft, cursor: draft.length }
  })
  on('process.run', (_, e) => {
    const argv = e.argv
    if (argv[0] !== 'gh') return ran('')
    if (argv[1] === 'repo') return setup.repo === undefined ? ran(REPO) : setup.repo()
    if (argv[1] === 'issue' && argv[2] === 'list') return ran(ISSUES)
    if (argv[1] === 'issue' && argv[2] === 'view') return ran(issueView(Number(argv[3])))

    return ran('')
  })
  on('model.complete', () => ({
    value: { isAnswered: true, text: 'Der Export bricht bei leeren Ordnern ab; erwartet wird stattdessen ein leeres Archiv.', usage: USAGE },
  }))
  on('mcp.call', (_, e) => {
    const call: McpCall = { server: e.server, tool: e.tool, args: (e.args ?? {}) as Record<string, unknown> }
    mcp.push(call)
    if (setup.mcp !== undefined) return setup.mcp(call)
    if (e.tool === 'start_session') return { value: { content: [{ type: 'text', text: 'Started session local_abc123 ("#42 Export fails for empty folders").' }], isError: false } }
    if (e.tool === 'get_session') return { value: { content: [{ type: 'text', text: '{"sessionId":"local_abc123","title":"#42 Export fails for empty folders","state":"idle"}' }], isError: false } }

    return { value: { content: [{ type: 'text', text: 'ok' }], isError: false } }
  })
  if (setup.toolCall !== undefined) {
    const answer = setup.toolCall
    on('tool.call', () => answer())
  }

  return { store, mcp, opened, filled }
}

async function started($: Engine, on: On) {
  const clock = mock.clock(on, { now: Date.parse('2026-11-06T12:00:00.000Z') })
  await $.session.start({ cwd: 'D:\\proj', surface: 'desktop', isInteractive: true })
  await clock.advance(1_000)

  return clock
}

test('the pane lists the open issues with their excerpt and actions, on desktop and terminal', async ($, on) => {
  const { store } = project(on)
  await started($, on)

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ key: `row-title:${ROW_42}` })).toBeDefined()
    expect(await ui.find({ key: `row-title:${ROW_7}` })).toBeDefined()
    expect(await ui.find({ key: `work:${ROW_42}` })).toBeDefined()
    expect(await ui.find({ key: `here:${ROW_42}` })).toBeDefined()
    // Before the consent the row shows an excerpt of the body, never a recap.
    expect(await ui.find({ type: 'Text', text: /export throws on a folder without files/ })).toBeDefined()
    expect(await ui.find({ key: `consent-on:${SECTION}` })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /issue-radar v9\.9\.9/ })).toBeDefined()
    if (surface === 'terminal') expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)

    await ui.unmount()
  }

  // The list is cached without bodies: metadata and a short excerpt only.
  const cache = store.get(`cache:${SECTION}`) as { rows: unknown[]; meta: Record<string, { excerpt: string }> }
  expect(cache.rows).toHaveLength(2)
  expect(cache.meta['42']?.excerpt.startsWith('The export throws')).toBe(true)
  expect(JSON.stringify(cache)).not.toContain('Can reproduce')
  expect(store.get('debug:last')).toBeDefined()
})

test('one consent per repository switches the recaps on, and switching them off removes them', async ($, on) => {
  const { store } = project(on)
  const clock = await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: `consent-on:${SECTION}` })
  await clock.advance(1_000)
  expect(await ui.find({ type: 'Text', text: /bricht bei leeren Ordnern ab/ })).toBeDefined()
  expect(await ui.find({ key: `consent-on:${SECTION}` })).toBeUndefined()
  expect((store.get('settings:github.com/acme/widgets') as { consent: Record<string, boolean> }).consent[SECTION]).toBe(true)
  const recaps = store.get(`recaps:${SECTION}`) as Record<string, { updatedAt: string; text: string }>
  expect(recaps['42']?.updatedAt).toBe('2026-11-05T09:00:00Z')
  expect(recaps['7']?.text).toContain('Archiv')

  // The settings panel's toggle switches the repository off again and drops its recaps from the store.
  await ui.press({ key: 'settings' })
  await ui.press({ key: `consent:${SECTION}` })
  expect(store.get(`recaps:${SECTION}`)).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /export throws on a folder without files/ })).toBeDefined()
  await ui.unmount()
})

test('Work on it starts one session per issue, remembers it, detaches it and relabels the button', async ($, on) => {
  const { store, mcp } = project(on)
  await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: `work:${ROW_42}` })

  const start = mcp.find(call => call.tool === 'start_session')
  expect(start?.server).toBe('ccd_session')
  expect(start?.args['initiation']).toBe('user_asked')
  expect(start?.args['title']).toBe('#42 Export fails for empty folders')
  expect(start?.args['name']).toBe('issue-42-widgets')
  expect(start?.args['use_worktree']).toBe(true)
  expect(start?.args['branch_name']).toBe('issue-42-export-fails-for-emp')
  expect(String(start?.args['prompt']).startsWith('Issue Radar hand-off: acme/widgets#42')).toBe(true)
  expect(String(start?.args['prompt'])).toContain('Phase 3 - Interview')
  expect(String(start?.args['prompt'])).toContain('<issue-text>')
  expect(String(start?.args['prompt'])).toContain('Closes acme/widgets#42')
  expect(String(start?.args['background']).length).toBeGreaterThan(80)
  expect(mcp.find(call => call.tool === 'detach_session')?.args['session_id']).toBe('local_abc123')

  const mapping = store.get(`session:${ROW_42}`) as { sessionId: string; detached: boolean; startedFrom: string }
  expect(mapping.sessionId).toBe('local_abc123')
  expect(mapping.detached).toBe(true)
  expect(mapping.startedFrom).toBe('local_pane')
  expect(String((await ui.find({ key: `work:${ROW_42}` }))?.props['label'])).toBe('Zur Session')

  // A second press opens the existing session instead of starting another.
  await ui.press({ key: `work:${ROW_42}` })
  expect(mcp.filter(call => call.tool === 'start_session')).toHaveLength(1)
  expect(mcp.find(call => call.tool === 'open_session_in')?.args['session_id']).toBe('local_abc123')
  await ui.unmount()
})

test('when no route starts a session, the brief lands in the prompt box, and sending it there changes nothing', async ($, on) => {
  const { filled, opened } = project(on, {
    mcp: () => ({ value: { content: [{ type: 'text', text: 'unknown server ccd_session' }], isError: true } }),
    toolCall: () => ({ deny: 'no such tool' }),
  })
  await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: `work:${ROW_42}` })
  expect(filled).toHaveLength(1)
  expect(filled[0]?.startsWith('Issue Radar hand-off: acme/widgets#42')).toBe(true)
  expect(String((await ui.find({ key: `work:${ROW_42}` }))?.props['label'])).toBe('Bearbeiten')

  // Take it here fills the same brief, set apart from the draft, without any session call.
  await ui.press({ key: `here:${ROW_7}` })
  expect(filled).toHaveLength(2)
  expect(filled[1]?.startsWith('\n\nIssue Radar hand-off: acme/widgets#7')).toBe(true)

  // The pane's own session sends its own brief: it is not an issue session, the pane stays.
  const before = opened.length
  await $.prompt.submit({ text: filled[0] ?? '', wait: false, origin: { kind: 'composer' } })
  expect(await ui.find({ key: `work:${ROW_7}` })).toBeDefined()
  expect(opened.length).toBe(before)
  await ui.unmount()
})

test('a failing desktop call never releases a remembered session', async ($, on) => {
  const { store, mcp } = project(on, {
    stored: { [`session:${ROW_42}`]: { sessionId: 'local_abc123', title: '#42 Export fails', startedAt: 1, startedFrom: 'local_pane', detached: true } },
    mcp: () => ({ value: { content: [{ type: 'text', text: 'unknown server ccd_session_mgmt' }], isError: true } }),
    toolCall: () => ({ deny: 'no such tool' }),
  })
  await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: `work:${ROW_42}` })
  expect(store.get(`session:${ROW_42}`)).toBeDefined()
  expect(mcp.find(call => call.tool === 'start_session')).toBeUndefined()
  await ui.unmount()
})

test('a signed-out gh shows its state, and a retry after signing in recovers', async ($, on) => {
  let calls = 0
  project(on, {
    repo: () => {
      calls += 1

      return calls === 1 ? ran('', 4, 'To get started with GitHub CLI, please run:  gh auth login') : ran(REPO)
    },
  })
  const clock = await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /nicht angemeldet/ })).toBeDefined()
  expect(await ui.find({ key: `work:${ROW_42}` })).toBeUndefined()

  await ui.press({ key: 'refresh' })
  await clock.advance(1_000)
  expect(await ui.find({ key: `work:${ROW_42}` })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /nicht angemeldet/ })).toBeUndefined()
  await ui.unmount()
})

test('an issue session does not open the pane or poll on its own', async ($, on) => {
  const { opened } = project(on, {
    stored: { [`session:${ROW_42}`]: { sessionId: 'local_pane', title: '#42', startedAt: 1, startedFrom: 'local_other', detached: true } },
  })
  await started($, on)

  expect(opened).toHaveLength(0)
})

test('the pane opens with the session and again when the desktop attaches', async ($, on) => {
  const { opened } = project(on, { surfaces: [], open: () => ({ value: { isPlaced: false, reason: 'no-surface' } }) })
  const clock = mock.clock(on, { now: Date.parse('2026-11-06T12:00:00.000Z') })
  await $.session.start({ cwd: 'D:\\proj', surface: null, isInteractive: false })
  await clock.advance(1_000)
  expect(opened).toEqual(['issue-radar'])

  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  expect(opened).toHaveLength(2)
})

test('the pure helpers behave', async () => {
  expect(parseSessionId({ session_id: 'local_x1' }, '')).toBe('local_x1')
  expect(parseSessionId(undefined, 'Started session local_abc123 for you')).toBe('local_abc123')
  expect(parseSessionId(undefined, '{"sessionId":"s-9f8e7d6c"}')).toBe('s-9f8e7d6c')
  expect(parseSessionId(undefined, 'nothing here')).toBeNull()
  expect(classify(4, 'anything', 'github.com', 'a/b')).toEqual({ kind: 'signed-out', host: 'github.com' })
  expect(classify(1, 'none of the git remotes configured for this repository point to a known GitHub host', 'github.com', 'a/b').kind).toBe('not-github')
  expect(classify(1, 'GraphQL: Could not resolve to a Repository with the name', 'github.com', 'a/b').kind).toBe('no-access')
  expect(isRepoSpec('acme/widgets')).toBe(true)
  expect(isRepoSpec('ghe.example.com/acme/widgets')).toBe(true)
  expect(isRepoSpec('-R/acme/widgets')).toBe(false)
  expect(isRepoSpec('widgets')).toBe(false)
  expect(excerptOf('# Title\n\nSome **bold** text with a [link](https://x) and `code`.')).toBe('Title Some bold text with a link and code.')
  expect(trimRecap(`${'A sentence. '.repeat(40)}`).length).toBeLessThanOrEqual(220)
  const row = {
    number: 1234,
    title: 'A very long issue title that will certainly exceed the sixty characters the app allows',
    url: '',
    createdAt: '',
    updatedAt: '',
    author: 'a',
    labels: [],
    assignees: [],
    milestone: null,
    isPinned: false,
  }
  expect(sessionTitle(row).length).toBeLessThanOrEqual(59)
  expect(branchName(row)).toBe('issue-1234-a-very-long-issue-ti')
  expect(sessionName(row, 'Daemand-Reports')).toBe('issue-1234-daemand-re')
  const brief = renderBrief({
    issueRepo: { host: 'github.com', owner: 'acme', name: 'reports', url: '', defaultBranch: 'main', isPrivate: true, hasIssues: true, isArchived: false, isFork: false },
    codeRepo: { host: 'github.com', owner: 'acme', name: 'widgets', url: '', defaultBranch: 'develop', isPrivate: true, hasIssues: true, isArchived: false, isFork: false },
    row,
    details: { updatedAt: '', state: 'OPEN', commentCount: 0, comments: [], excerpt: '', body: '', linkedPrs: [], fetchedAt: 0 },
    fetchedAt: '2026-11-06T12:00:00.000Z',
  })
  expect(brief).toContain('land in `acme/widgets` (this checkout; default branch `develop`)')
  expect(brief).toContain('Closes acme/reports#1234')
})
