// Batch 0, the foundation: the two desktop routes, the refresh reasons and
// the background gate, mappings read per refresh and per click, GraphQL's
// core, the missing-scope state, drawn text made safe, and two V1 fixes.
import type { EngineInterface } from 'claude-code'
import { expect, mock } from 'claude-code/testing'

import { renderBrief } from '../hooks/brief'
import { classify, scopeIn } from '../hooks/github'
import type { GhResult } from '../hooks/github'
import { classifyGraph, graphErrors, graphqlArgs, operationOf, readGraph } from '../hooks/graph'
import { strings } from '../hooks/i18n'
import { isTransportText, quietDesktop, saysSessionGone } from '../hooks/session'
import { clean, cleanLine } from '../hooks/text'
import { prLine, prRefOf } from '../hooks/prs'
import { offerToast, takeToast } from '../hooks/toasts'
import type { McpAnswer } from './harness'
import { ISSUES, NOW, PANE, REPO, ROW_42, SECTION, command, count, issueView, mcpText, project, ran, started, test, tick } from './harness'

const MAPPED = { [`session:${ROW_42}`]: { sessionId: 'local_abc123', title: '#42 Export fails', startedAt: 1, startedFrom: 'local_pane', detached: true } }
const DE = strings('de')
const SCOPE_WALL =
  "GraphQL: Your token has not been granted the required scopes to execute this query. The 'id' field requires one of the following scopes: ['read:project'], but your token has only been granted the: ['gist', 'read:org', 'repo', 'workflow'] scopes."
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/

type DebugLast = { reason: string }

function lastReason(store: Map<string, unknown>): string | undefined {
  return (store.get('debug:last') as DebugLast | undefined)?.reason
}

/**
 * Just what `quietDesktop` touches of `$`, for a unit test of its own bookkeeping: a clock standing at `now` whose
 * timers never fire, an mcp route `answer` decides ('throw' for a server the engine cannot reach), every check 'ask'.
 */
function quietEngine(now: number, answer: (server: string, tool: string) => McpAnswer['value'] | 'throw', calls: string[]): EngineInterface {
  const fake = {
    clock: { now: async () => now, after: () => ({ cancel: () => undefined }) },
    mcp: {
      call: async (server: string, tool: string) => {
        calls.push(`${server}/${tool}`)
        const given = answer(server, tool)
        if (given === 'throw') throw new Error(`MCP server "${server}" is not connected`)

        return given
      },
    },
    tool: { check: async () => ({ decision: 'ask' }), call: async () => ({ deny: 'no such tool' }) },
  }

  return fake as unknown as EngineInterface
}

// Desktop routes ---------------------------------------------------------

test('a refusal the app answers on the mcp route is the result: no typed retry, the mapping stays', async ($, on) => {
  const { store, mcp, toolCalls, toasts } = project(on, {
    stored: MAPPED,
    mcp: call => {
      if (call.tool === 'open_session_in') return mcpText('Refused: the cursor is in a text field; nothing changed.', true)
      if (call.tool === 'get_session') return mcpText('{"sessionId":"local_abc123","title":"#42 Export fails","state":"idle"}')

      return mcpText('ok')
    },
  })
  await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: `work:${ROW_42}` })
  expect(mcp.filter(call => call.tool === 'open_session_in')).toHaveLength(1)
  expect(mcp.filter(call => call.tool === 'get_session')).toHaveLength(1)
  expect(toolCalls).toHaveLength(0)
  expect(store.get(`session:${ROW_42}`)).toBeDefined()
  expect(toasts).toHaveLength(1)
  await ui.unmount()
})

test('an app error that does not say the session is gone keeps the mapping, so no second session starts', async ($, on) => {
  const { store, mcp, toolCalls, toasts } = project(on, {
    stored: MAPPED,
    mcp: call => {
      if (call.tool === 'open_session_in') return mcpText('Refused: this session did not start that one; nothing changed.', true)
      if (call.tool === 'get_session') return mcpText('An unknown error occurred while reading the session list. Try again.', true)

      return mcpText('ok')
    },
  })
  await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: `work:${ROW_42}` })
  await ui.press({ key: `work:${ROW_42}` })
  expect(mcp.filter(call => call.tool === 'get_session')).toHaveLength(2)
  expect(mcp.find(call => call.tool === 'start_session')).toBeUndefined()
  expect(toolCalls).toHaveLength(0)
  expect((store.get(`session:${ROW_42}`) as { sessionId: string }).sessionId).toBe('local_abc123')
  expect(String((await ui.find({ key: `work:${ROW_42}` }))?.props['label'])).toBe('Zur Session')
  // Each press says the session runs and where to open it; none says it is gone.
  expect(toasts).toEqual([DE.openElsewhere('#42 Export fails'), DE.openElsewhere('#42 Export fails')])
  await ui.unmount()
})

test("the app's own 'not found' releases the mapping instead of being retried on the typed route", async ($, on) => {
  const { store, mcp, toolCalls } = project(on, {
    stored: MAPPED,
    mcp: call => (call.tool === 'open_session_in' || call.tool === 'get_session' ? mcpText(`Session ${String(call.args['session_id'])} not found.`, true) : mcpText('ok')),
  })
  await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: `work:${ROW_42}` })
  expect(toolCalls).toHaveLength(0)
  expect(store.get(`session:${ROW_42}`)).toBeUndefined()
  expect(mcp.find(call => call.tool === 'start_session')).toBeUndefined()
  expect(String((await ui.find({ key: `work:${ROW_42}` }))?.props['label'])).toBe('Bearbeiten')
  await ui.unmount()
})

test('an mcp route the engine cannot reach falls back to the typed route, which carries the press as consent', async ($, on) => {
  const { store, mcp, toolCalls } = project(on, {
    mcp: () => {
      throw new Error('MCP server "ccd_session" is not connected')
    },
    toolCall: input => {
      const text = input['tool'] === 'mcp__ccd_session__start_session' ? 'Started session local_t00l01.' : 'ok'

      return { result: { content: [{ type: 'text', text }] }, text }
    },
  })
  await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: `work:${ROW_42}` })
  expect(mcp.filter(call => call.tool === 'start_session')).toHaveLength(1)
  expect(toolCalls.map(call => call['tool'])).toEqual(['mcp__ccd_session__start_session', 'mcp__ccd_session_mgmt__detach_session'])
  expect(String(toolCalls[0]?.['consent'])).toContain('"Bearbeiten"')
  expect(String(toolCalls[0]?.['consent'])).toContain(ROW_42)
  expect(toolCalls[1]?.['consent']).toBe(toolCalls[0]?.['consent'])
  const mapping = store.get(`session:${ROW_42}`) as { sessionId: string; detached: boolean }
  expect(mapping.sessionId).toBe('local_t00l01')
  expect(mapping.detached).toBe(true)
  await ui.unmount()
})

test('an argument the app refuses at start_session stays refused: no approval card route, the brief goes to the prompt box', async ($, on) => {
  const { mcp, toolCalls, filled } = project(on, {
    mcp: call => (call.tool === 'start_session' ? mcpText('Invalid argument: branch_name "issue-42-export-fails-for-emp" already exists.', true) : mcpText('ok')),
  })
  await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: `work:${ROW_42}` })
  expect(mcp.filter(call => call.tool === 'start_session')).toHaveLength(1)
  expect(toolCalls).toHaveLength(0)
  expect(filled).toHaveLength(1)
  expect(filled[0]?.startsWith('Issue Radar hand-off: acme/widgets#42')).toBe(true)
  await ui.unmount()
})

test("the mod's own desktop read goes over mcp and never asks the permission check while mcp answers", async ($, on) => {
  const { mcp, toolCalls, checks } = project(on)
  await started($, on)

  const text = await command($, 'issue-radar', 'spike')
  const self = mcp.find(call => call.tool === 'get_session' && call.args['session_id'] === 'self')
  expect(self?.server).toBe('ccd_session_mgmt')
  expect(checks).toHaveLength(0)
  expect(toolCalls).toHaveLength(0)
  expect(text).toContain('get_session self (quiet, via mcp)')
})

test('a quiet read whose mcp route is unreachable asks the permission check and stops short of a card', async ($, on) => {
  const { toolCalls, checks } = project(on, { mcp: () => mcpText('unknown server ccd_session_mgmt', true) })
  await started($, on)

  await command($, 'issue-radar', 'spike')
  expect(checks).toEqual([{ tool: 'mcp__ccd_session_mgmt__get_session', input: { session_id: 'self' } }])
  // The spike's start is the owner's command and may take the typed route; the quiet read may not.
  expect(toolCalls.filter(call => call['tool'] === 'mcp__ccd_session_mgmt__get_session')).toHaveLength(0)
})

test('a quiet read takes the typed route only when the permission check allows exactly that call, and without consent', async ($, on) => {
  const { toolCalls, checks } = project(on, {
    mcp: () => mcpText('unknown server', true),
    check: (tool, input) => (tool === 'mcp__ccd_session_mgmt__get_session' && (input as { session_id?: string }).session_id === 'self' ? 'allow' : 'ask'),
    toolCall: input => {
      const text = input['tool'] === 'mcp__ccd_session_mgmt__get_session' ? '{"sessionId":"local_pane","title":"Pane","state":"idle"}' : 'nope'

      return input['tool'] === 'mcp__ccd_session_mgmt__get_session' ? { result: { content: [{ type: 'text', text }] }, text } : { deny: 'no such tool' }
    },
  })
  await started($, on)

  const text = await command($, 'issue-radar', 'spike')
  expect(checks).toHaveLength(1)
  const quiet = toolCalls.filter(call => call['tool'] === 'mcp__ccd_session_mgmt__get_session')
  expect(quiet).toHaveLength(1)
  expect(quiet[0]?.['session_id']).toBe('self')
  expect(quiet[0]?.['consent']).toBeUndefined()
  expect(text).toContain('get_session self (quiet, via tool)')
})

test('a quiet read the app does not answer in time gives up without trying another route', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { mcp, toolCalls, checks } = project(on, {
    mcp: async call => {
      if (call.tool === 'get_session' && call.args['session_id'] === 'self') await clock.sleep(60_000)

      return mcpText('{"sessionId":"local_abc123"}')
    },
  })
  await $.session.start({ cwd: 'D:\\proj', surface: 'desktop', isInteractive: true })
  await clock.advance(1_000)

  const pending = command($, 'issue-radar', 'spike')
  // Let the spike reach its quiet read (and arm its timeout) before the clock moves.
  await clock.settle()
  await clock.advance(5_000)
  const text = await pending
  expect(mcp.some(call => call.tool === 'get_session' && call.args['session_id'] === 'self')).toBe(true)
  expect(checks).toHaveLength(0)
  expect(toolCalls).toHaveLength(0)
  expect(text).toContain('no answer within 5000 ms')
})

test("the spike's quiet read measures the mcp route every time, even right after a transport failure there", async ($, on) => {
  const { mcp, toolCalls } = project(on, {
    mcp: call => {
      if (call.tool === 'get_session' && call.args['session_id'] === 'self') return mcpText('MCP server "ccd_session_mgmt" is not connected', true)

      return call.tool === 'start_session' ? mcpText('Started session local_abc123.') : mcpText('ok')
    },
  })
  await started($, on)

  await command($, 'issue-radar', 'spike')
  const again = await command($, 'issue-radar', 'spike')
  expect(mcp.filter(call => call.tool === 'get_session' && call.args['session_id'] === 'self')).toHaveLength(2)
  expect(toolCalls.filter(call => call['tool'] === 'mcp__ccd_session_mgmt__get_session')).toHaveLength(0)
  expect(again).toContain('get_session self (quiet): not read (mcp: MCP server "ccd_session_mgmt" is not connected; the typed route would ask)')
})

test('a transport failure holds back the mcp route of that one call only, and a skipped route says so', async () => {
  // Names of their own: this file's copy of the module keeps its back-off from test to test.
  const calls: string[] = []
  const answer = { content: [{ type: 'text' as const, text: '{"id":"x"}' }], isError: false }
  const $ = quietEngine(NOW, server => (server === 'bo_sidebar' ? 'throw' : answer), calls)

  const failed = await quietDesktop($, 'bo_sidebar', 'list_groups', {})
  expect(failed.ok ? 'answered' : failed.reason).toBe('mcp: MCP server "bo_sidebar" is not connected; the typed route would ask')
  // Another server, and another tool of the same server, still go over mcp.
  expect((await quietDesktop($, 'bo_mgmt', 'get_session', { session_id: 'self' })).ok).toBe(true)
  expect((await quietDesktop($, 'bo_sidebar', 'list_sections', {})).ok).toBe(false)
  expect(calls).toEqual(['bo_sidebar/list_groups', 'bo_mgmt/get_session', 'bo_sidebar/list_sections'])

  // The call that failed skips mcp for ten minutes and names the skip; a measurement tries it anyway.
  const skipped = await quietDesktop($, 'bo_sidebar', 'list_groups', {})
  expect(calls).toHaveLength(3)
  expect(skipped.ok ? 'answered' : skipped.reason).toMatch(/^mcp skipped until \d\d:\d\d after a transport failure \(MCP server "bo_sidebar" is not connected\); the typed route would ask$/)
  await quietDesktop($, 'bo_sidebar', 'list_groups', {}, { isMeasurement: true })
  expect(calls).toHaveLength(4)
  await quietDesktop(quietEngine(NOW + 10 * 60_000, () => answer, calls), 'bo_sidebar', 'list_groups', {})
  expect(calls).toHaveLength(5)
})

// Reasons, the background gate, mappings ---------------------------------

test('the ↻ press runs as press, a consent and a retry as manual', async ($, on) => {
  let lists = 0
  const { store } = project(on, {
    gh: args => {
      if (args[0] !== 'issue' || args[1] !== 'list') return undefined
      lists += 1

      return lists === 3 ? ran('', 1, SCOPE_WALL) : undefined
    },
  })
  const clock = await started($, on)
  expect(lastReason(store)).toBe('start')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'refresh' })
  await clock.advance(1_000)
  expect(lastReason(store)).toBe('press')

  // The consent re-runs the refresh itself; this third list hits a scope wall, whose state block offers a retry.
  await ui.press({ key: `consent-on:${SECTION}` })
  await clock.advance(1_000)
  expect(lastReason(store)).toBe('manual')
  expect(await ui.find({ key: `retry:${SECTION}` })).toBeDefined()

  await ui.press({ key: `retry:${SECTION}` })
  await clock.advance(1_000)
  expect(lastReason(store)).toBe('manual')
  expect(await ui.find({ key: `retry:${SECTION}` })).toBeUndefined()
  await ui.unmount()
})

test('a ↻ pressed while a refresh runs is queued and still runs as press', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { store, argv } = project(on, {
    gh: async args => {
      if (args[0] === 'issue' && args[1] === 'list') await clock.sleep(2_000)

      return undefined
    },
  })
  await $.session.start({ cwd: 'D:\\proj', surface: 'desktop', isInteractive: true })
  await clock.advance(1_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(count(argv, 'issue', 'list')).toBe(1)

  // The start refresh is still waiting for its list: the press can only be queued.
  await ui.press({ key: 'refresh' })
  expect(count(argv, 'issue', 'list')).toBe(1)
  await clock.advance(3_000)
  await clock.advance(3_000)
  expect(count(argv, 'issue', 'list')).toBe(2)
  expect(lastReason(store)).toBe('press')
  await ui.unmount()
})

test('a weaker reason scheduled later never downgrades a refresh already pending', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { store } = project(on, {
    gh: async args => {
      if (args[0] === 'issue' && args[1] === 'list') await clock.sleep(2_000)

      return undefined
    },
  })
  await $.session.start({ cwd: 'D:\\proj', surface: 'desktop', isInteractive: true })
  await clock.advance(1_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  // The start refresh ends at 2.6 s and re-runs the queued press 0.5 s later; a gh command the session runs meanwhile
  // asks for a 'tool' refresh, which replaces the pending one without making it less than the owner's press.
  await clock.advance(1_700)
  expect(lastReason(store)).toBe('start')
  await $.tool.call({ tool: 'Bash', command: 'gh issue close 7' })
  await clock.advance(5_000)
  expect(lastReason(store)).toBe('press')
  await ui.unmount()
})

test('the timer refreshes only while the pane is shown', async ($, on) => {
  const { argv, setShown } = project(on)
  const clock = await started($, on)
  expect(count(argv, 'issue', 'list')).toBe(1)

  setShown(false)
  await tick(clock, 2)
  expect(count(argv, 'issue', 'list')).toBe(1)

  setShown(true)
  await tick(clock)
  expect(count(argv, 'issue', 'list')).toBe(2)
})

test('the timer fetches nothing while no pane was ever opened', { options: { openAtStart: false } }, async ($, on) => {
  const { argv, opened } = project(on)
  const clock = await started($, on)
  expect(opened).toHaveLength(0)
  expect(count(argv, 'issue', 'list')).toBe(1)

  await tick(clock, 2)
  expect(count(argv, 'issue', 'list')).toBe(1)
})

test('the timer fetches nothing once the pane is closed with ✕', async ($, on) => {
  const { argv, closed } = project(on)
  const clock = await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'close' })
  await ui.unmount()
  expect(closed).toEqual(['issue-radar'])
  const before = count(argv, 'issue', 'list')

  await tick(clock, 2)
  expect(count(argv, 'issue', 'list')).toBe(before)
})

test('a pane waiting for a surface is not shown, so the timer waits until the desktop places it', async ($, on) => {
  let isAttached = false
  const { argv } = project(on, { surfaces: [], open: () => (isAttached ? { value: { isPlaced: true } } : { value: { isPlaced: false, reason: 'no-surface' } }) })
  const clock = await started($, on)
  expect(count(argv, 'issue', 'list')).toBe(1)
  await tick(clock, 2)
  expect(count(argv, 'issue', 'list')).toBe(1)

  // The attach opens the pane again, which now places it: the attach refresh lists, and so does the next tick.
  isAttached = true
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  await clock.advance(1_000)
  expect(count(argv, 'issue', 'list')).toBe(2)
  await tick(clock)
  expect(count(argv, 'issue', 'list')).toBe(3)
})

test('a click reads the mapping from the store: one another pane wrote is opened, one it released is started afresh', async ($, on) => {
  const { store, mcp } = project(on)
  await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // Another pane started a session for #42 after this pane's last refresh.
  store.set(`session:${ROW_42}`, MAPPED[`session:${ROW_42}`])
  await ui.press({ key: `work:${ROW_42}` })
  expect(mcp.find(call => call.tool === 'start_session')).toBeUndefined()
  expect(mcp.find(call => call.tool === 'open_session_in')?.args['session_id']).toBe('local_abc123')

  // Another pane released it again: the click starts a session instead of opening the stale one.
  store.delete(`session:${ROW_42}`)
  await ui.press({ key: `work:${ROW_42}` })
  expect(mcp.filter(call => call.tool === 'start_session')).toHaveLength(1)
  await ui.unmount()
})

test('a session whose mapping the store refused is opened on the next press, never started twice, and stored once the store takes it', async ($, on) => {
  let isFull = true
  const { store, mcp } = project(on, { storeRefuses: key => isFull && key.startsWith('session:') })
  const clock = await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: `work:${ROW_42}` })
  expect(store.get(`session:${ROW_42}`)).toBeUndefined()
  await ui.press({ key: `work:${ROW_42}` })
  expect(mcp.filter(call => call.tool === 'start_session')).toHaveLength(1)
  expect(mcp.filter(call => call.tool === 'open_session_in')).toHaveLength(1)

  // A refresh keeps it while the store still refuses, and writes it once the store takes it again.
  await ui.press({ key: 'refresh' })
  await clock.advance(1_000)
  expect(String((await ui.find({ key: `work:${ROW_42}` }))?.props['label'])).toBe('Zur Session')
  isFull = false
  await ui.press({ key: 'refresh' })
  await clock.advance(1_000)
  expect(store.get(`session:${ROW_42}`)).toMatchObject({ sessionId: 'local_abc123', startedFrom: 'local_pane', detached: true })
  await ui.press({ key: `work:${ROW_42}` })
  expect(mcp.filter(call => call.tool === 'start_session')).toHaveLength(1)
  expect(mcp.filter(call => call.tool === 'open_session_in')).toHaveLength(2)
  await ui.unmount()
})

test('a refresh reads the mappings from the store, and every open of the pane uses the one composed title', async ($, on) => {
  const { store, titles } = project(on, { surfaces: [], open: () => ({ value: { isPlaced: false, reason: 'no-surface' } }) })
  const clock = await started($, on)
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  await clock.advance(1_000)
  await command($, 'issue-radar')
  await clock.advance(1_000)
  // The start, the attach and /issue-radar. The composed title equals the bare one until E5 adds its count, so this
  // pins the three opens only; E5's test asserts the count in each of them.
  expect(titles).toEqual(['Issues', 'Issues', 'Issues'])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(String((await ui.find({ key: `work:${ROW_42}` }))?.props['label'])).toBe('Bearbeiten')

  store.set(`session:${ROW_42}`, MAPPED[`session:${ROW_42}`])
  await ui.press({ key: 'refresh' })
  await clock.advance(1_000)
  expect(String((await ui.find({ key: `work:${ROW_42}` }))?.props['label'])).toBe('Zur Session')
  await ui.unmount()
})

// What the pane draws ----------------------------------------------------

test('a missing scope shows its own state with the command that grants it, on desktop and terminal', async ($, on) => {
  project(on, { gh: args => (args[0] === 'issue' && args[1] === 'list' ? ran('', 1, SCOPE_WALL) : undefined) })
  await started($, on)

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Code', text: 'gh auth refresh -s read:project' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: DE.scopeEnv('github.com', 'read:project') })).toBeDefined()
    expect(await ui.find({ text: /GH_ENTERPRISE_TOKEN/ })).toBeUndefined()
    expect(await ui.find({ key: `retry:${SECTION}` })).toBeDefined()
    expect(await ui.find({ key: `work:${ROW_42}` })).toBeUndefined()
    await ui.unmount()
  }
})

test('on GitHub Enterprise Server the missing-scope state names the host and GH_ENTERPRISE_TOKEN, on desktop and terminal', async ($, on) => {
  const ghe = 'ghe.example.com/acme/widgets'
  project(on, {
    repo: () => ran(REPO.replace('https://github.com/acme/widgets', 'https://ghe.example.com/acme/widgets')),
    gh: args => (args[0] === 'issue' && args[1] === 'list' ? ran('', 1, SCOPE_WALL) : undefined),
  })
  await started($, on)

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Code', text: 'gh auth refresh -h ghe.example.com -s read:project' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: DE.scopeEnv('ghe.example.com', 'read:project') })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /GH_ENTERPRISE_TOKEN/ })).toBeDefined()
    expect(await ui.find({ text: /\bGH_TOKEN\b/ })).toBeUndefined()
    expect(await ui.find({ key: `retry:${ghe}` })).toBeDefined()
    await ui.unmount()
  }
  // A GHE.com tenancy reads GH_TOKEN, as github.com does.
  expect(strings('en').scopeEnv('octo.ghe.com', 'read:project')).toBe('If the token comes from GH_TOKEN, that token needs the scope read:project.')
  expect(strings('en').scopeEnv('ghe.example.com', 'read:project')).toBe('If the token comes from GH_ENTERPRISE_TOKEN, that token needs the scope read:project.')
})

test('control characters from GitHub never reach the drawing, on desktop and terminal', async ($, on) => {
  const issues = (JSON.parse(ISSUES) as Array<Record<string, unknown>>).map(issue =>
    issue['number'] === 42 ? { ...issue, title: 'Export\u001b[31m fails\u0007 for empty folders', labels: [{ name: 'bu\u0000g', color: 'd73a4a' }] } : issue,
  )
  project(on, {
    gh: args => {
      if (args[0] === 'issue' && args[1] === 'list') return ran(JSON.stringify(issues))
      if (args[0] === 'issue' && args[1] === 'view' && args[2] === '42') {
        return ran(
          issueView(42, 'OPEN', {
            body: 'Line one\r\nline two\u001b[0m\u0085 end',
            comments: [{ author: { login: 'main\u0008tainer' }, createdAt: '2026-11-04T08:00:00Z', body: 'Can\u000b reproduce.' }],
          }),
        )
      }

      return undefined
    },
  })
  await started($, on)

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: `row-title:${ROW_42}` })
    expect(await ui.find({ key: `row-title:${ROW_42}` })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\[31m fails for empty folders/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Line one line two\[0m end/ })).toBeDefined()
    expect(await ui.find({ text: CONTROL })).toBeUndefined()
    await ui.press({ key: `row-title:${ROW_42}` })
    await ui.unmount()
  }
})

test('image-cell characters from GitHub never get the pane refused, on desktop and terminal', async ($, on) => {
  // The kitty placeholder in a title, a title and a label that open with a kitty diacritic (U+0305), U+2800 before
  // one in the body's excerpt, and a body whose fold and trim bare a leading diacritic in the opened row.
  const issues = (JSON.parse(ISSUES) as Array<Record<string, unknown>>).map(issue =>
    issue['number'] === 42
      ? { ...issue, title: 'Export \u{10EEEE}fails for empty folders', labels: [{ name: '\u0305bug', color: 'd73a4a' }] }
      : { ...issue, title: '\u0305Dark mode for the settings page' },
  )
  project(on, {
    gh: args => {
      if (args[0] === 'issue' && args[1] === 'list') return ran(JSON.stringify(issues))
      if (args[0] === 'issue' && args[1] === 'view' && args[2] === '42') {
        return ran(issueView(42, 'OPEN', { body: ' \u0305Look: \u2800\u0305 here', comments: [{ author: { login: '\u0305maintainer' }, createdAt: '2026-11-04T08:00:00Z', body: '\u2800\u0305 Can reproduce.' }] }))
      }

      return undefined
    },
  })
  await started($, on)

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.drawn()).toMatchObject({ type: 'Box' })
    expect(await ui.find({ type: 'Text', text: /^Export fails for empty folders$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Dark mode for the settings page$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Look: \u2800 here/ })).toBeDefined()
    await ui.press({ key: `row-title:${ROW_42}` })
    expect(await ui.drawn()).toMatchObject({ type: 'Box' })
    expect(await ui.find({ type: 'Text', text: /^Look: \u2800 here$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\u2800 Can reproduce\./ })).toBeDefined()
    expect(await ui.find({ text: /\u{10EEEE}|\u2800\p{M}/u })).toBeUndefined()
    await ui.press({ key: `row-title:${ROW_42}` })
    await ui.unmount()
  }
})

test("the opened row names a linked pull request '#n', never '#n ()', on desktop and terminal", async ($, on) => {
  project(on, {
    gh: args =>
      args[0] === 'issue' && args[1] === 'view' && args[2] === '42'
        ? ran(
            issueView(42, 'OPEN', {
              closedByPullRequestsReferences: [{ id: 'PR_kw1', number: 57, repository: { id: 'R_1', name: 'widgets', owner: { id: 'O_1', login: 'acme' } }, url: 'https://github.com/acme/widgets/pull/57' }],
            }),
          )
        : undefined,
  })
  await started($, on)

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: `row-title:${ROW_42}` })
    expect(await ui.find({ type: 'Link', text: /^#57$/ })).toBeDefined()
    expect(await ui.find({ text: /#57 \(/ })).toBeUndefined()
    await ui.press({ key: `row-title:${ROW_42}` })
    await ui.unmount()
  }
})

// Pure helpers -------------------------------------------------------------

test('clean keeps tab and newline and drops every other control character', () => {
  expect(clean('a\u001b[31mb\u0007c\r\nd\re\tf\u0085g\u007fh\u0000')).toBe('a[31mbc\nd\ne\tfgh')
  expect(clean('plain text, ümlauts and emoji 🚀')).toBe('plain text, ümlauts and emoji 🚀')
})

test('clean drops what image cells use: the placeholder, marks after U+2800 and leading marks, in an order that leaves no pair behind', () => {
  expect(clean('Export \u{10EEEE}fails')).toBe('Export fails')
  expect(clean('\u0305Export fails')).toBe('Export fails')
  expect(clean('\u0300\u0305Export')).toBe('Export')
  expect(clean('Look: \u2800\u0305\u030D here')).toBe('Look: \u2800 here')
  expect(clean('\u2800\u0007\u0305 and \u2800\u{10EEEE}\u0305')).toBe('\u2800 and \u2800')
  expect(clean('\u0007\u0305x')).toBe('x')
  expect(clean('\u{10EEEE}\u0305')).toBe('')
  // Marks after a base character are ordinary text, as is U+2800 on its own.
  expect(clean('Café e\u0301 \u2800 ⠁')).toBe('Café e\u0301 \u2800 ⠁')
  expect(cleanLine(' \u0305Look:\r\n\t\u2800\u0305  here ')).toBe('Look: \u2800 here')
  expect(cleanLine(' \u0007 x')).toBe('x')
})

test('only an answer that says the session asked about is gone counts as gone', () => {
  for (const gone of [
    'Session local_abc123 not found.',
    'session not found',
    'No such session: local_abc123',
    'Unknown session id local_abc123',
    'No session with id local_abc123',
    "Session 'local_abc123' does not exist.",
    'The session with id local_abc123 could not be found.',
    'local_abc123 does not exist',
    'Could not find session local_abc123',
    'Session local_abc123 was deleted.',
  ]) {
    expect({ text: gone, isGone: saysSessionGone(gone, 'local_abc123') }).toEqual({ text: gone, isGone: true })
  }
  for (const kept of [
    'An unknown error occurred while reading the session list. Try again.',
    'Unknown error',
    'Not found.',
    'Session list not found',
    'Session local_abc123 is not on screen.',
    'Refused: the cursor is in a text field; nothing changed.',
    'Session local_other1 not found.',
  ]) {
    expect({ text: kept, isGone: saysSessionGone(kept, 'local_abc123') }).toEqual({ text: kept, isGone: false })
  }
})

test('a GitHub Enterprise brief closes the issue as owner/name#n, the marker keeps the host', () => {
  const ghe = { host: 'ghe.example.com', owner: 'acme', name: 'reports', url: '', defaultBranch: 'main', isPrivate: true, hasIssues: true, isArchived: false, isFork: false }
  const row = { number: 12, title: 'Export', url: '', createdAt: '', updatedAt: '', author: 'a', labels: [], assignees: [], milestone: null, isPinned: false }
  const brief = renderBrief({
    issueRepo: ghe,
    codeRepo: ghe,
    row,
    details: { updatedAt: '', state: 'OPEN', commentCount: 0, comments: [], excerpt: '', body: '', linkedPrs: [], fetchedAt: 0 },
    fetchedAt: '2026-11-06T12:00:00.000Z',
  })
  expect(brief).toContain('Closes acme/reports#12')
  expect(brief).not.toContain('Closes ghe.example.com/')
  expect(brief.startsWith('Issue Radar hand-off: ghe.example.com/acme/reports#12')).toBe(true)
  expect(brief).toContain('gh issue view 12 -R ghe.example.com/acme/reports')
})

test('a linked pull request reads #n, and its state, once known, is words of its own, never in brackets', () => {
  const open = { number: 57, url: 'https://github.com/acme/widgets/pull/57', repo: 'acme/widgets', state: 'OPEN', isDraft: false, review: null, checks: null, fromSession: false } as const
  expect(prRefOf(open, 'acme/widgets', false)).toBe('#57')
  expect(prLine({ ...open, state: null }, undefined, DE)).toBe('')
  expect(prLine(open, undefined, DE)).toBe(DE.prOpen)
})

test('transport failures are told from answers of the app', () => {
  expect(isTransportText('unknown server ccd_session')).toBe(true)
  expect(isTransportText('MCP server "ccd_pr" is not connected')).toBe(true)
  expect(isTransportText('MCP server ccd_window disconnected')).toBe(true)
  expect(isTransportText('No such tool: mcp__ccd_window__open_session_in')).toBe(true)
  expect(isTransportText('Remote Control is disconnected for this session.')).toBe(false)
  expect(isTransportText('Session local_abc123 not found.')).toBe(false)
  expect(isTransportText('Refused: the cursor is in a text field; nothing changed.')).toBe(false)
  expect(isTransportText('Invalid argument: effort must not exceed the caller')).toBe(false)
})

test('one toast per refresh: the highest rank wins, the first of equals stays, a take clears', () => {
  expect(takeToast()).toBeNull()
  offerToast('arrival', '2 new issues')
  offerToast('failure', 'GitHub cannot be reached')
  offerToast('proposal', 'Proposal ready')
  offerToast('failure', 'a second failure')
  expect(takeToast()).toEqual({ rank: 'failure', text: 'GitHub cannot be reached' })
  expect(takeToast()).toBeNull()
  offerToast('arrival', 'one', 6_000)
  offerToast('arrival', 'two')
  expect(takeToast()).toEqual({ rank: 'arrival', text: 'one', timeoutMs: 6_000 })
})

test('scope walls classify as missing-scope from either wording', () => {
  expect(classify(1, SCOPE_WALL, 'github.com', 'a/b')).toEqual({ kind: 'missing-scope', host: 'github.com', detail: 'read:project' })
  expect(classify(1, 'error: your authentication token is missing required scopes [read:project]\nTo request it, run:  gh auth refresh -s read:project', 'ghe.example.com', 'a/b')).toEqual({
    kind: 'missing-scope',
    host: 'ghe.example.com',
    detail: 'read:project',
  })
  expect(scopeIn('nothing about scopes')).toBeNull()
})

test('graphqlArgs names the host, sends strings raw and types integers and booleans', () => {
  const args = graphqlArgs('ghe.example.com', 'query IssueRadarProbe($owner: String!) { viewer { login } }', { owner: '@x', name: 'widgets', first: 3, closed: false })
  expect(args.slice(0, 4)).toEqual(['api', 'graphql', '--hostname', 'ghe.example.com'])
  expect(args).toContain('query=query IssueRadarProbe($owner: String!) { viewer { login } }')
  const pairs = args.slice(4).reduce<string[]>((all, arg, index, list) => (index % 2 === 0 ? [...all, `${arg} ${list[index + 1] ?? ''}`] : all), [])
  expect(pairs).toContain('-f owner=@x')
  expect(pairs).toContain('-f name=widgets')
  expect(pairs).toContain('-F first=3')
  expect(pairs).toContain('-F closed=false')
  expect(pairs.some(pair => pair.startsWith('-F owner') || pair.startsWith('-F name'))).toBe(false)
  expect(graphqlArgs('github.com', '{ viewer { login } }').slice(0, 4)).toEqual(['api', 'graphql', '--hostname', 'github.com'])
  expect(() => graphqlArgs('github.com', '{ x }', { 'bad name': 'x' })).toThrow()
  expect(operationOf('query IssueRadarRows($owner: String!) { x }')).toBe('IssueRadarRows')
  expect(operationOf('{ viewer { login } }')).toBeNull()
})

test('classifyGraph names repository-wide errors and leaves alias misses and validation errors to the caller', () => {
  const at = (type: string, path: string[], message = '') => ({ type, path, message })
  expect(classifyGraph([at('NOT_FOUND', ['repository'], 'Could not resolve to a Repository')], 'github.com', 'acme/widgets')).toEqual({ kind: 'no-access', host: 'github.com', detail: 'acme/widgets' })
  expect(classifyGraph([at('FORBIDDEN', [])], 'github.com', 'acme/widgets')?.kind).toBe('no-access')
  expect(classifyGraph([at('RATE_LIMITED', [], 'API rate limit exceeded for user ID 1.')], 'github.com', 'a/b')).toEqual({ kind: 'rate-limited', host: 'github.com' })
  expect(classifyGraph([at('INSUFFICIENT_SCOPES', [], "… one of the following scopes: ['read:project'], …")], 'github.com', 'a/b')).toEqual({ kind: 'missing-scope', host: 'github.com', detail: 'read:project' })
  expect(classifyGraph([at('NOT_FOUND', ['repository', 'm9'])], 'github.com', 'a/b')).toBeNull()
  expect(classifyGraph([at('', ['query', 'repository', 'issue', 'subIssuesSummaryX'], "Field 'subIssuesSummaryX' doesn't exist on type 'Issue'")], 'github.com', 'a/b')).toBeNull()
  expect(graphErrors({ errors: [{ type: 'NOT_FOUND', path: ['repository', 'm9', 0], message: 'x' }, 'junk'] })).toEqual([{ type: 'NOT_FOUND', path: ['repository', 'm9', '0'], message: 'x' }])
  expect(graphErrors('not json')).toEqual([])
})

test('readGraph keeps partial data on exit 1, and names every other failure', () => {
  const failed = (stdout: string, exitCode: number, kind: 'error' | 'signed-out' = 'error'): GhResult => ({ ok: false, state: { kind, host: 'github.com', detail: 'gh said so' }, stdout, exitCode })
  const partial = readGraph(
    failed(JSON.stringify({ data: { repository: { m5: { number: 5, state: 'CLOSED' }, m9: null }, rateLimit: { cost: 1 } }, errors: [{ type: 'NOT_FOUND', path: ['repository', 'm9'], message: 'Could not resolve to an Issue' }] }), 1),
    'github.com',
    'acme/widgets',
  )
  expect(partial.ok).toBe(true)
  if (partial.ok) {
    expect(partial.cost).toBe(1)
    expect(partial.errors).toHaveLength(1)
    expect((partial.data['repository'] as Record<string, unknown>)['m9']).toBeNull()
  }
  const invalid = readGraph(failed(JSON.stringify({ errors: [{ path: ['query', 'repository', 'issue', 'x'], extensions: { code: 'undefinedField' }, message: "Field 'x' doesn't exist" }] }), 1), 'github.com', 'a/b')
  expect(invalid).toEqual({ ok: false, state: { kind: 'error', host: 'github.com', detail: 'gh said so' } })
  expect(readGraph(failed(JSON.stringify({ errors: [{ type: 'INSUFFICIENT_SCOPES', message: "['read:project']" }] }), 1), 'github.com', 'a/b')).toEqual({
    ok: false,
    state: { kind: 'missing-scope', host: 'github.com', detail: 'read:project' },
  })
  expect(readGraph(failed('', 4, 'signed-out'), 'github.com', 'a/b')).toEqual({ ok: false, state: { kind: 'signed-out', host: 'github.com', detail: 'gh said so' } })
  expect(readGraph({ ok: true, stdout: JSON.stringify({ data: { viewer: { login: 'me' } } }) }, 'github.com', 'a/b')).toEqual({ ok: true, data: { viewer: { login: 'me' } }, errors: [], cost: null })
  expect(readGraph({ ok: true, stdout: '' }, 'github.com', 'a/b')).toEqual({ ok: false, state: { kind: 'error', host: 'github.com', detail: 'gh api graphql answered no data' } })
})
