// Batch 5, session state: E12's issue-session identity, its own record and its
// status line; E10's proposal badge and toast from that record (the store only,
// no session messages); E1's session state on the row from the app's listing,
// the re-entry ladder (open, reopen, start afresh after a confirmation) with the
// earlier attempts named in the brief, the adoption of a start without an id,
// and E22-b's session line on a closed row. Asserted on keys and argv.
import type { RenderSurface } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { GO_LINE, renderBackground, renderBrief, spikeBrief } from '../hooks/brief'
import { strings } from '../hooks/i18n'
import { askOf, parseMarker, phaseFor, phaseKind, proposalsDue, readPhase, statusText, toastRef } from '../hooks/phase'
import { entryOf, parseSessions, pressConsent, readOpenAnswer } from '../hooks/session'
import { asAttempts, rowBadge, stateFamily, withAttempt } from '../hooks/tracking'
import type { IssueRow, Mapping, PhaseRecord, PreviousAttempt, RepoInfo, SeenRecord, SessionLive } from '../types'
import type { Engine, McpAnswer, McpCall } from './harness'
import { ISSUES, NOW, PANE, ROW_42, ROW_7, SECTION, command, mcpText, project, ran, started, tick } from './harness'

const DE = strings('de')
const ROWS = JSON.parse(ISSUES) as Array<Record<string, unknown>>
const SETTINGS = 'settings:github.com/acme/widgets'
const TITLE_42 = '#42 Export fails for empty folders'
/** A session this pane started for #42 two hours ago. */
const MAPPED: Mapping = { sessionId: 'local_abc123', title: TITLE_42, startedAt: NOW - 2 * 3_600_000, startedFrom: 'local_pane', detached: true }
/** This session as #42's issue session, started by another pane. */
const OWN: Mapping = { sessionId: 'local_pane', title: TITLE_42, startedAt: NOW - 60_000, startedFrom: 'local_other', detached: true }
const BRIEF_42 = 'Issue Radar hand-off: acme/widgets#42 (from local_other)\n\nWork on GitHub issue #42 of `acme/widgets`.'
const WIDGETS: RepoInfo = { host: 'github.com', owner: 'acme', name: 'widgets', url: 'https://github.com/acme/widgets', defaultBranch: 'main', isPrivate: false, hasIssues: true, isArchived: false, isFork: false }

/** A record an issue session wrote. */
function record(extra: Partial<PhaseRecord> = {}): PhaseRecord {
  return { v: 1, sessionId: 'local_abc123', activity: 'waiting', ask: 'none', at: NOW, turns: 1, ...extra }
}

type Desktop = {
  /** list_sessions' entries, or a whole answer. */
  list?: () => Array<Record<string, unknown>> | McpAnswer
  /** get_session of an id other than self; undefined: found, titled as #42's session. */
  get?: (id: string) => McpAnswer | undefined
  /** What the desktop calls this session (get_session self). */
  selfId?: string
  /** Any other call; undefined: as the harness answers it (start_session names local_new456). */
  other?: (call: McpCall) => McpAnswer | undefined
}

/** The desktop app's answers to the session tools. */
function desktop(given: Desktop = {}): (call: McpCall) => McpAnswer {
  return call => {
    const id = String(call.args['session_id'] ?? '')
    if (call.tool === 'list_sessions') {
      const answer = given.list?.() ?? []

      return Array.isArray(answer) ? mcpText(JSON.stringify(answer)) : answer
    }
    if (call.tool === 'get_session') {
      if (id === 'self') return mcpText(JSON.stringify({ sessionId: given.selfId ?? 'local_pane', title: 'Pane' }))

      return given.get?.(id) ?? mcpText(JSON.stringify({ sessionId: id, title: TITLE_42 }))
    }
    const own = given.other?.(call)
    if (own !== undefined) return own
    if (call.tool === 'start_session') return mcpText('Started session local_new456 ("#42 Export fails for empty folders").')

    return mcpText('ok')
  }
}

/** A list entry of the app for a session. */
function entry(sessionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { sessionId, title: TITLE_42, ...extra }
}

type Found = { text?: string; props: Record<string, unknown> }
type Drawing = { find: (query: { key?: string; type?: string; text?: string | RegExp }) => Promise<Found | undefined> }

async function badgeOf(ui: Drawing, rowKey: string): Promise<string | undefined> {
  return (await ui.find({ key: `badge:${rowKey}` }))?.text
}

async function labelOf(ui: Drawing, key: string): Promise<string> {
  return String((await ui.find({ key }))?.props['label'])
}

/** The calls of one desktop tool, in order. */
function calls(mcp: readonly McpCall[], tool: string): McpCall[] {
  return mcp.filter(call => call.tool === tool)
}

/** One main-loop turn of the session (or a subagent's, with `agentId`), ended with `answer` for `reason`. */
async function turn($: Engine, id: string, answer: string, reason: 'answer' | 'aborted' | 'error' = 'answer', agentId?: string): Promise<void> {
  const loop = agentId === undefined ? {} : { agentId }
  await $.turn.start({ text: '', turnId: id, ...loop })
  await $.turn.complete({ answer, durationMs: 900, isAborted: reason === 'aborted', turnId: id, reason, ...loop })
}

// E12: identity, record, status line -----------------------------------------------

test('an issue session known by its mapping shows its issue in the status line and writes only its own record', async ($, on) => {
  const { store, argv, statuses } = project(on, { stored: { [`session:${ROW_42}`]: OWN } })
  const clock = await started($, on)
  expect(statuses.at(-1)).toBe('Issue #42 · acme/widgets')
  const before = new Map(store)

  await $.turn.start({ text: '', turnId: 't1' })
  await clock.settle()
  expect(store.get(`phase:${ROW_42}`)).toMatchObject({ v: 1, sessionId: 'local_pane', activity: 'working', ask: 'none', turns: 0 })
  await $.turn.complete({ answer: 'Summary …\n\nWhich archive format do you expect?', durationMs: 900, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect(store.get(`phase:${ROW_42}`)).toMatchObject({ activity: 'waiting', ask: 'question', turns: 1 })

  // A subagent's turn is not the session's.
  await turn($, 's1', 'Go?', 'answer', 'sub')
  await clock.settle()
  expect(store.get(`phase:${ROW_42}`)).toMatchObject({ activity: 'waiting', ask: 'question', turns: 1 })

  // The closing Go? of the brief's phase 4, in markdown, is the proposal; the line says so.
  await turn($, 't2', 'Approach …\n\n**Go?**')
  await clock.settle()
  expect(store.get(`phase:${ROW_42}`)).toMatchObject({ activity: 'waiting', ask: 'proposal', turns: 2 })
  expect(statuses.at(-1)).toBe(`Issue #42 · acme/widgets${DE.statusProposal}`)
  // An API error ends the turn stopped.
  await turn($, 't3', '', 'error')
  await clock.settle()
  expect(store.get(`phase:${ROW_42}`)).toMatchObject({ activity: 'error', ask: 'none', turns: 3 })
  expect(statuses.at(-1)).toBe('Issue #42 · acme/widgets')

  // One store key changed, the session's own; no gh call, no pane.
  const changed = [...new Set([...before.keys(), ...store.keys()])].filter(key => JSON.stringify(before.get(key)) !== JSON.stringify(store.get(key)))
  expect(changed).toEqual([`phase:${ROW_42}`])
  expect(argv.filter(call => call[0] === 'gh')).toHaveLength(0)
})

test('an issue session known by its brief as its first message stands down and records its turns', async ($, on) => {
  const { store, opened, closed, statuses } = project(on)
  const clock = await started($, on)
  expect(opened).toContain('issue-radar')

  await $.prompt.submit({ text: BRIEF_42, wait: false, origin: { kind: 'sdk' } })
  await clock.settle()
  expect(closed).toContain('issue-radar')
  expect(statuses.at(-1)).toBe('Issue #42 · acme/widgets')
  await turn($, 't1', 'Phase 4 …\n\n> "Go?"')
  await clock.settle()
  expect(store.get(`phase:${ROW_42}`)).toMatchObject({ sessionId: 'local_pane', activity: 'waiting', ask: 'proposal' })
  expect(statuses.at(-1)).toContain(DE.statusProposal)
})

test('a hot reload of an issue session found by its brief starts nothing: no gh, no pane, the line again (B-E12-2)', async ($, on) => {
  const { argv, opened, statuses } = project(on)
  const clock = await started($, on)
  await $.prompt.submit({ text: BRIEF_42, wait: false, origin: { kind: 'sdk' } })
  await clock.settle()
  const ghBefore = argv.filter(call => call[0] === 'gh').length
  const opens = opened.length

  await $.session.start({ cwd: 'D:\\proj', surface: 'desktop', isInteractive: true })
  await tick(clock)
  expect(argv.filter(call => call[0] === 'gh')).toHaveLength(ghBefore)
  expect(opened).toHaveLength(opens)
  expect(statuses.at(-1)).toBe('Issue #42 · acme/widgets')
})

test('a marker in a later prompt only stands the session down: no status line and no record (A-F5)', async ($, on) => {
  const { store, closed, statuses, setMessages } = project(on)
  const clock = await started($, on)
  setMessages([{ role: 'user', text: 'What is open here?' }])

  await $.prompt.submit({ text: BRIEF_42, wait: false, origin: { kind: 'composer' } })
  await turn($, 't1', 'Go?')
  await clock.settle()
  expect(closed).toContain('issue-radar')
  expect(statuses).toHaveLength(0)
  expect(store.has(`phase:${ROW_42}`)).toBe(false)
})

test("a brief naming this session in its marker is the pane's own, even after a reload forgot its fills (B-E12-3)", async ($, on) => {
  const { store, closed, statuses } = project(on)
  const clock = await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await $.prompt.submit({ text: BRIEF_42.replace('(from local_other)', '(from local_pane)'), wait: false, origin: { kind: 'composer' } })
  await turn($, 't1', 'Go?')
  await clock.settle()
  expect(closed).toHaveLength(0)
  expect(statuses).toHaveLength(0)
  expect(store.has(`phase:${ROW_42}`)).toBe(false)
  expect(await ui.find({ key: `work:${ROW_42}` })).toBeDefined()
  await ui.unmount()
})

test('a question dialog or a plan approval marks the issue session waiting while it is open', async ($, on) => {
  const inside: unknown[] = []
  let held: Map<string, unknown> | undefined
  const { store } = project(on, {
    stored: { [`session:${ROW_42}`]: OWN },
    toolCall: () => {
      inside.push(held?.get(`phase:${ROW_42}`))

      return { result: 'answered' }
    },
  })
  held = store
  const clock = await started($, on)
  await $.turn.start({ text: '', turnId: 't1' })
  await clock.settle()

  // One valid question (B-E12-6): the tool takes 1-4.
  const question = { question: 'Which archive format?', header: 'Format', options: [{ label: 'zip', description: 'A zip' }, { label: 'tar', description: 'A tar' }], multiSelect: false }
  await $.tool.call({ tool: 'AskUserQuestion', questions: [question] } as Parameters<Engine['tool']['call']>[0])
  expect(inside[0]).toMatchObject({ activity: 'waiting', ask: 'question' })
  expect(store.get(`phase:${ROW_42}`)).toMatchObject({ activity: 'working', ask: 'none' })
  await $.tool.call({ tool: 'ExitPlanMode' } as Parameters<Engine['tool']['call']>[0])
  expect(inside[1]).toMatchObject({ activity: 'waiting', ask: 'proposal' })
})

test('a session whose desktop id a mapping names is an issue session before its first refresh: no pane, no gh (B-E12-1, S4)', async ($, on) => {
  // The pane started the issue session as local_xyz; the engine of that session calls itself local_pane (S4), and the
  // app answers a detached session's shape: its id, its parent, no name (B-E12-6).
  // The app answers two seconds late: the start refresh (at 600 ms) waits for the answer before it decides.
  const clock = mock.clock(on, { now: NOW })
  const answer = desktop({ selfId: 'local_xyz' })
  const { opened, argv, statuses, store } = project(on, {
    stored: { [`session:${ROW_42}`]: { ...OWN, sessionId: 'local_xyz' } },
    mcp: async call => {
      if (call.tool === 'get_session' && call.args['session_id'] === 'self') await clock.sleep(2_000)

      return answer(call)
    },
  })
  await $.session.start({ cwd: 'D:\\proj', surface: 'desktop', isInteractive: true })
  await clock.advance(3_000)
  expect(opened).toHaveLength(0)
  expect(argv.filter(call => call[0] === 'gh')).toHaveLength(0)
  expect(statuses.at(-1)).toBe('Issue #42 · acme/widgets')

  // Its record carries the desktop's id, which the mapping names, and the engine's beside it.
  await turn($, 't1', 'Done.')
  await clock.settle()
  expect(store.get(`phase:${ROW_42}`)).toMatchObject({ sessionId: 'local_xyz', engineId: 'local_pane', activity: 'waiting', ask: 'none' })
})

test("the pane opened inside an issue session draws that session's row as this session, with nothing to press", async ($, on) => {
  const { mcp } = project(on, { stored: { [`session:${ROW_42}`]: OWN }, mcp: desktop() })
  const clock = await started($, on)
  await command($, 'issue-radar')
  await clock.advance(1_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await badgeOf(ui, ROW_42)).toBe(DE.badges.self)
  expect(await labelOf(ui, `work:${ROW_42}`)).toBe(DE.thisSession)
  await ui.press({ key: `work:${ROW_42}` })
  expect(calls(mcp, 'open_session_in')).toHaveLength(0)
  expect(calls(mcp, 'start_session')).toHaveLength(0)
  await ui.unmount()
})

test('a pane whose own mappings are the only ones never asks the desktop who it is', async ($, on) => {
  const { mcp } = project(on, { stored: { [`session:${ROW_42}`]: MAPPED } })
  const clock = await started($, on)
  await turn($, 't1', 'ok')
  await clock.settle()
  expect(mcp.some(call => call.tool === 'get_session' && call.args['session_id'] === 'self')).toBe(false)
})

test('no status line on a surface that draws no pane (B-E12-5)', async ($, on) => {
  const { statuses, store } = project(on, { stored: { [`session:${ROW_42}`]: OWN }, surfaces: ['vscode'] })
  const clock = await started($, on, 'vscode')
  await turn($, 't1', 'Go?')
  await clock.settle()
  expect(statuses.filter(text => text !== undefined)).toHaveLength(0)
  // The record is written all the same: the panes read it.
  expect(store.get(`phase:${ROW_42}`)).toMatchObject({ ask: 'proposal' })
})

test("the spike's brief names the pane and the spike session shows its own line without a record", async ($, on) => {
  const { mcp, statuses, store } = project(on, { mcp: desktop({ list: () => [entry('local_abc123', { state: 'running' })] }) })
  const clock = await started($, on)
  const text = await command($, 'issue-radar', 'spike')
  const start = calls(mcp, 'start_session')[0]
  expect(String(start?.args['prompt']).split('\n')[0]).toBe('Issue Radar hand-off: spike (from local_pane)')
  expect(text).toContain('list_sessions (quiet, via mcp): 1 active; keys sessionId, title, state; state words running')
  expect(text).toContain('session ids: engine local_pane, desktop local_pane')

  // The spike's own session (another engine) takes the brief as its first message.
  await $.prompt.submit({ text: spikeBrief('local_other').prompt, wait: false, origin: { kind: 'sdk' } })
  await turn($, 't1', 'Issue Radar spike: started.')
  await clock.settle()
  expect(statuses.at(-1)).toBe(DE.statusSpike)
  expect([...store.keys()].filter(key => key.startsWith('phase:'))).toHaveLength(0)
})

// E10: the proposal on the row, from the store -------------------------------------

test('a proposal shows on the row and is toasted once, from the store alone, while the pane is shown', async ($, on) => {
  const { store, toasts, setShown, mcp } = project(on, { stored: { [`session:${ROW_42}`]: MAPPED } })
  const clock = await started($, on)
  const proposals = () => toasts.filter(text => text === DE.proposalToast('#42'))

  // The issue session writes its record after this session began; the next store sync (15 s) reads it.
  store.set(`phase:${ROW_42}`, record({ ask: 'proposal', at: NOW + 2_000 }))
  await clock.advance(15_000)
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await badgeOf(ui, ROW_42)).toContain(DE.badges.proposal)
    await ui.unmount()
  }
  expect(proposals()).toHaveLength(1)
  await clock.advance(30_000)
  expect(proposals()).toHaveLength(1)
  // No session message was sent: the store is the only channel (plan section 3).
  expect(mcp.some(call => call.tool === 'send_message')).toBe(false)

  // A newer proposal behind another tab waits for the pane to be shown (the owner's ↻ reads it there, but toasts
  // nothing), then is toasted once.
  setShown(false)
  store.set(`phase:${ROW_42}`, record({ ask: 'proposal', at: NOW + 60_000, turns: 3 }))
  await clock.advance(30_000)
  const hidden = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await hidden.press({ key: 'refresh' })
  await clock.advance(1_000)
  await hidden.unmount()
  expect(proposals()).toHaveLength(1)
  setShown(true)
  await clock.advance(15_000)
  expect(proposals()).toHaveLength(2)
})

test("a proposal made before this session began is drawn but not toasted, and a question reads 'fragt dich'", async ($, on) => {
  const { toasts } = project(on, {
    stored: { [`session:${ROW_42}`]: MAPPED, [`phase:${ROW_42}`]: record({ ask: 'proposal', at: NOW - 60_000 }), [`session:${ROW_7}`]: { ...MAPPED, sessionId: 'local_s7' }, [`phase:${ROW_7}`]: record({ sessionId: 'local_s7', ask: 'question' }) },
  })
  await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await badgeOf(ui, ROW_42)).toBe(DE.badges.proposal)
  expect(await badgeOf(ui, ROW_7)).toBe(DE.badges.question)
  expect(toasts.filter(text => text.includes(DE.badges.proposal) || text.includes('Vorschl'))).toHaveLength(0)
  await ui.unmount()
})

test("another pane's session gets its badge at this pane's next refresh and is never started twice (B-E10-3)", async ($, on) => {
  const { store, mcp, toasts } = project(on, { mcp: desktop({ list: () => [entry('local_seven', { title: '#7 Dark mode' })], get: id => mcpText(JSON.stringify(entry(id, { title: '#7 Dark mode' }))) }) })
  const clock = await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  store.set(`session:${ROW_7}`, { sessionId: 'local_seven', title: '#7 Dark mode', startedAt: NOW, startedFrom: 'local_other', detached: true })
  store.set(`phase:${ROW_7}`, record({ sessionId: 'local_seven', activity: 'working', at: NOW + 5_000 }))
  await ui.press({ key: 'refresh' })
  await clock.advance(1_000)
  expect(await badgeOf(ui, ROW_7)).toBe(DE.badges.working)
  expect(await labelOf(ui, `work:${ROW_7}`)).toBe(DE.openSession)

  // This pane did not start it: no open_session_in (the app would refuse), no start; the toast says where it is.
  await ui.press({ key: `work:${ROW_7}` })
  expect(calls(mcp, 'start_session')).toHaveLength(0)
  expect(calls(mcp, 'open_session_in')).toHaveLength(0)
  expect(toasts.at(-1)).toBe(DE.openElsewhere('#7 Dark mode'))
  await ui.unmount()
})

test("an earlier session's record never speaks for the row's current session", async ($, on) => {
  const current = { ...MAPPED, sessionId: 'local_new', startedAt: NOW - 10 * 60_000 }
  project(on, { stored: { [`session:${ROW_42}`]: current, [`phase:${ROW_42}`]: record({ sessionId: 'local_old', ask: 'proposal', at: NOW - 3_600_000 }) } })
  await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await badgeOf(ui, ROW_42)).toBeUndefined()
  await ui.unmount()
})

// E1: the listing, the badge and the ladder ----------------------------------------

test('a mapped row shows its session state from one quiet listing per refresh, on desktop and terminal', async ($, on) => {
  const { mcp, store, toolCalls } = project(on, {
    stored: { [`session:${ROW_42}`]: MAPPED },
    mcp: desktop({ list: () => [entry('local_abc123', { state: 'running' }), { sessionId: 'local_zzz', title: 'Unrelated private work' }] }),
  })
  const clock = await started($, on)

  expect(calls(mcp, 'list_sessions').map(call => call.args)).toEqual([{ limit: 50 }])
  expect(calls(mcp, 'get_session').filter(call => call.args['session_id'] === 'local_abc123')).toHaveLength(0)
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await badgeOf(ui, ROW_42)).toContain(DE.badges.working)
    expect(await ui.find({ key: `session-row:${ROW_42}` })).toBeDefined()
    expect(await labelOf(ui, `work:${ROW_42}`)).toBe(DE.openSession)
    await ui.unmount()
  }
  // Nothing of the listing reaches the store but counts and keys; never a card.
  expect(JSON.stringify([...store.values()])).not.toContain('Unrelated private work')
  expect(toolCalls).toHaveLength(0)
  await tick(clock)
  expect(calls(mcp, 'list_sessions')).toHaveLength(2)
})

test('no listing while no row is mapped or the pane is not shown', async ($, on) => {
  const first = project(on, { mcp: desktop() })
  const clock = await started($, on)
  await tick(clock)
  expect(calls(first.mcp, 'list_sessions')).toHaveLength(0)

  // Mapped, but behind another tab: a timer refresh does not run, the owner's ↻ lists GitHub, and nothing asks the app.
  first.store.set(`session:${ROW_42}`, MAPPED)
  first.setShown(false)
  await tick(clock, 2)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  await clock.advance(1_000)
  expect(String((await ui.find({ key: `work:${ROW_42}` }))?.props['label'])).toBe(DE.openSession)
  expect(calls(first.mcp, 'list_sessions')).toHaveLength(0)
  await ui.unmount()
})

test('an archived session offers Wieder öffnen and Neu starten; Wieder öffnen unarchives and opens it', async ($, on) => {
  const { mcp, store } = project(on, { stored: { [`session:${ROW_42}`]: MAPPED }, mcp: desktop() })
  await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // A complete listing without it, and the app still finds it: archived (A-F3).
  expect(await badgeOf(ui, ROW_42)).toBe(DE.badges.archived)
  expect(await labelOf(ui, `work:${ROW_42}`)).toBe(DE.reopen)
  expect(await ui.find({ key: `fresh:${ROW_42}` })).toBeDefined()

  const before = mcp.length
  await ui.press({ key: `work:${ROW_42}` })
  const after = mcp.slice(before).map(call => `${call.tool}:${String(call.args['session_id'] ?? '')}`)
  expect(after.filter(name => !name.startsWith('list_sessions') && !name.startsWith('get_status'))).toEqual(['get_session:local_abc123', 'unarchive_session:local_abc123', 'open_session_in:local_abc123'])
  expect(calls(mcp, 'open_session_in')[0]?.args['target']).toBe('focus')
  expect(store.get(`session:${ROW_42}`)).toEqual(MAPPED)
  expect(calls(mcp, 'start_session')).toHaveLength(0)
  await ui.unmount()
})

test('Neu starten asks first; confirmed, it releases the archived session and the new brief names it', async ($, on) => {
  const branch = 'claude/issue-42-export-fails-x1y2'
  const { mcp, store } = project(on, { stored: { [`session:${ROW_42}`]: MAPPED }, mcp: desktop({ get: id => (id === 'local_abc123' ? mcpText(JSON.stringify(entry(id, { branch }))) : undefined) }) })
  await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: `fresh:${ROW_42}` })
  expect(await ui.find({ key: `fresh-ask:${ROW_42}` })).toBeDefined()
  expect(calls(mcp, 'start_session')).toHaveLength(0)
  await ui.press({ key: `fresh-confirm:${ROW_42}` })

  expect(calls(mcp, 'unarchive_session')).toHaveLength(0)
  const starts = calls(mcp, 'start_session')
  expect(starts).toHaveLength(1)
  const prompt = String(starts[0]?.args['prompt'])
  expect(prompt).toContain('Earlier Issue Radar sessions worked on this issue (1)')
  expect(prompt).toContain(TITLE_42)
  expect(prompt).toContain(branch)
  expect(prompt).toContain('gh pr list -R acme/widgets --head')
  expect(prompt.indexOf('<previous-attempts>')).toBeLessThan(prompt.indexOf('Everything between those tags'))
  expect(String(starts[0]?.args['background'])).toContain('started this session afresh')
  expect((store.get(`attempts:${ROW_42}`) as PreviousAttempt[])[0]).toMatchObject({ sessionId: 'local_abc123', endedAs: 'archived', branch })
  expect(store.get(`session:${ROW_42}`)).toMatchObject({ sessionId: 'local_new456', branch: 'issue-42-export-fails-for-emp' })
  await ui.unmount()
})

test('Neu starten never starts a second live session: a session the app lists again is kept (A-F2)', async ($, on) => {
  let isListed = false
  const { mcp, store, toasts } = project(on, { stored: { [`session:${ROW_42}`]: MAPPED }, mcp: desktop({ list: () => (isListed ? [entry('local_abc123')] : []) }) })
  await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await badgeOf(ui, ROW_42)).toBe(DE.badges.archived)

  // The owner restored it from the sidebar meanwhile.
  isListed = true
  await ui.press({ key: `fresh:${ROW_42}` })
  await ui.press({ key: `fresh-confirm:${ROW_42}` })
  expect(calls(mcp, 'start_session')).toHaveLength(0)
  expect(store.get(`session:${ROW_42}`)).toEqual(MAPPED)
  expect(store.has(`attempts:${ROW_42}`)).toBe(false)
  expect(toasts.at(-1)).toBe(DE.stillActive(TITLE_42))
  await ui.unmount()
})

test('a vanished session reads gone, and the confirmed Neu starten starts once with the attempt named', async ($, on) => {
  const { mcp, store } = project(on, { stored: { [`session:${ROW_42}`]: { ...MAPPED, branch: 'issue-42-export-fails-for-emp' } }, mcp: desktop({ get: id => mcpText(`Session ${id} not found.`, true) }) })
  await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await badgeOf(ui, ROW_42)).toBe(DE.badges.gone)
  expect(await labelOf(ui, `work:${ROW_42}`)).toBe(DE.startAfresh)

  await ui.press({ key: `work:${ROW_42}` })
  expect(calls(mcp, 'start_session')).toHaveLength(0)
  await ui.press({ key: `fresh-confirm:${ROW_42}` })
  expect(calls(mcp, 'start_session')).toHaveLength(1)
  // Only the slug the pane asked for is known (A-F18): the brief says so.
  expect((store.get(`attempts:${ROW_42}`) as PreviousAttempt[])[0]).toMatchObject({ sessionId: 'local_abc123', endedAs: 'gone', branch: 'issue-42-export-fails-for-emp', isSlug: true })
  expect(String(calls(mcp, 'start_session')[0]?.args['prompt'])).toContain('branch slug')
  await ui.unmount()
})

test('a desktop that cannot be reached never reads gone, and the row stays as V1 drew it', async ($, on) => {
  const { mcp, store } = project(on, {
    stored: { [`session:${ROW_42}`]: MAPPED },
    mcp: () => mcpText('unknown server ccd_session_mgmt', true),
    toolCall: () => ({ deny: 'no such tool' }),
  })
  await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await badgeOf(ui, ROW_42)).toBeUndefined()
  expect(await labelOf(ui, `work:${ROW_42}`)).toBe(DE.openSession)
  await ui.press({ key: `work:${ROW_42}` })
  expect(calls(mcp, 'start_session')).toHaveLength(0)
  expect(store.get(`session:${ROW_42}`)).toEqual(MAPPED)
  await ui.unmount()
})

test('the polling never raises a card: the typed route only where the permission check allows it', async ($, on) => {
  let decision: 'ask' | 'allow' = 'ask'
  const { toolCalls } = project(on, {
    stored: { [`session:${ROW_42}`]: MAPPED },
    mcp: () => mcpText('unknown server ccd_session_mgmt', true),
    check: () => decision,
    toolCall: () => ({ deny: 'no such tool' }),
  })
  const clock = await started($, on)
  await tick(clock, 2)
  const listed = () => toolCalls.filter(call => call['tool'] === 'mcp__ccd_session_mgmt__list_sessions')
  expect(listed()).toHaveLength(0)

  decision = 'allow'
  await tick(clock)
  expect(listed()).toHaveLength(1)
  expect(listed()[0]?.['consent']).toBeUndefined()
})

test('a start whose answer carried no id is never started twice and is adopted by its name (A-F12)', async ($, on) => {
  let isListed = false
  const { mcp, store, toasts } = project(on, {
    mcp: desktop({
      list: () =>
        isListed ? [entry('local_old', { name: 'issue-42-widgets', startedBy: 'local_other' }), entry('local_xyz', { name: 'issue-42-widgets', state: 'running', startedBy: 'local_pane' })] : [],
      other: call => (call.tool === 'start_session' ? mcpText('Started.') : undefined),
    }),
  })
  const clock = await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: `work:${ROW_42}` })
  expect(toasts).toContain(DE.noIdParsed)
  await ui.press({ key: `work:${ROW_42}` })
  expect(calls(mcp, 'start_session')).toHaveLength(1)
  expect(toasts.at(-1)).toBe(DE.startPending(42))

  // The next listing names it, started by this session; an older one of the same name another session started is not it.
  isListed = true
  await clock.advance(8_000)
  expect(store.get(`session:${ROW_42}`)).toMatchObject({ sessionId: 'local_xyz', startedFrom: 'local_pane', detached: true })
  expect(calls(mcp, 'detach_session').map(call => call.args['session_id'])).toContain('local_xyz')
  expect(toasts).toContain(DE.adopted(TITLE_42))
  await ui.press({ key: `work:${ROW_42}` })
  expect(calls(mcp, 'start_session')).toHaveLength(1)
  await ui.unmount()
})

test("E3's session pull request is read only for a session whose list row may name one", async ($, on) => {
  const { mcp } = project(on, {
    stored: { [`session:${ROW_42}`]: MAPPED, [`session:${ROW_7}`]: { ...MAPPED, sessionId: 'local_s7' } },
    mcp: desktop({ list: () => [entry('local_abc123', { pr: null }), entry('local_s7')] }),
  })
  await started($, on)
  expect(calls(mcp, 'get_status').map(call => call.args['session_id'])).toEqual(['local_s7'])
})

// E22-b: a closed issue's session ------------------------------------------------

test("an issue that closes keeps its session on its closed row, and the pane that started it opens it there", async ($, on) => {
  const closedList = JSON.stringify([{ number: 7, title: 'Dark mode for the settings page', url: 'https://github.com/acme/widgets/issues/7', closedAt: '2026-11-06T11:00:00Z', stateReason: 'COMPLETED', closedByPullRequestsReferences: [] }])
  const { mcp, store } = project(on, {
    stored: {
      [`session:${ROW_7}`]: { ...MAPPED, sessionId: 'local_seven', title: '#7 Dark mode' },
      [`phase:${ROW_7}`]: record({ sessionId: 'local_seven' }),
      [SETTINGS]: { watch: [], consent: {}, collapsed: {}, showClosed: { [SECTION]: true } },
    },
    gh: args => (args[0] === 'issue' && args[1] === 'list' ? ran(args.includes('closed') ? closedList : JSON.stringify([ROWS[0]])) : undefined),
    mcp: desktop({ list: () => [entry('local_seven')] }),
  })
  await started($, on)

  // A complete list without #7: the mapping and the session's record go, the closed issue's session stays.
  expect(store.has(`session:${ROW_7}`)).toBe(false)
  expect(store.has(`phase:${ROW_7}`)).toBe(false)
  expect(store.get(`done:${ROW_7}`)).toMatchObject({ sessionId: 'local_seven', startedFrom: 'local_pane' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: `closed-session:${ROW_7}` })).toBeDefined()
  await ui.press({ key: `closed-session:${ROW_7}` })
  expect(calls(mcp, 'open_session_in').map(call => call.args['session_id'])).toEqual(['local_seven'])
  await ui.unmount()
})

test('/issue-radar reset clears the records, the attempts and the closed issues sessions', async ($, on) => {
  const { store } = project(on, {
    stored: { [`phase:${ROW_42}`]: record(), [`attempts:${ROW_42}`]: [{ sessionId: 'local_old', title: 'x', startedAt: 1, endedAs: 'gone', at: 2 }], [`done:${ROW_7}`]: { v: 1, sessionId: 'local_s7', title: 'x', startedAt: 1, startedFrom: 'local_pane', closedAt: NOW } },
  })
  await started($, on)
  await command($, 'issue-radar', 'reset')
  expect([...store.keys()].filter(key => /^(phase|attempts|done):/.test(key))).toEqual([])
})

// Review fixes (batch 5) ---------------------------------------------------------

/** The last visit (E5): #7 seen at an older update, #42 never, so both rows carry a mark. */
const LAST_VISIT: SeenRecord = { v: 1, at: 1, newest: '2026-10-15T00:00:00Z', rows: { '7': '2026-10-20T00:00:00Z' } }
const CLOSED_7 = JSON.stringify([{ number: 7, title: 'Dark mode for the settings page', url: 'https://github.com/acme/widgets/issues/7', closedAt: '2026-11-06T11:00:00Z', stateReason: 'COMPLETED', closedByPullRequestsReferences: [] }])

/** gh calls among the recorded argv. */
function ghCalls(argv: readonly string[][]): number {
  return argv.filter(call => call[0] === 'gh').length
}

test('a desktop that attaches while the start still reads the desktop id waits for that read: no pane, no gh (R5-RT-1)', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const answer = desktop({ selfId: 'local_xyz' })
  const { opened, argv, statuses, mcp } = project(on, {
    stored: { [`session:${ROW_42}`]: { ...OWN, sessionId: 'local_xyz' } },
    mcp: async call => {
      if (call.tool === 'get_session' && call.args['session_id'] === 'self') await clock.sleep(1_200)

      return answer(call)
    },
  })
  await $.session.start({ cwd: 'D:\\proj', surface: 'desktop', isInteractive: true })
  // The desktop attaches at once, while the start's read of the desktop id is still out.
  const attaching = $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  await clock.advance(3_000)
  await attaching
  expect(opened).toHaveLength(0)
  expect(ghCalls(argv)).toBe(0)
  expect(statuses.at(-1)).toBe('Issue #42 · acme/widgets')
  // One read of the desktop's id, which the start and the attach share.
  expect(mcp.filter(call => call.tool === 'get_session' && call.args['session_id'] === 'self')).toHaveLength(1)
})

test('a slow desktop holds the first refresh back a moment only; an answer that comes later still stands the session down (B5-BEH-1)', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const answer = desktop({ selfId: 'local_xyz' })
  const { opened, closed, argv, statuses } = project(on, {
    stored: { [`session:${ROW_42}`]: { ...OWN, sessionId: 'local_xyz' } },
    mcp: async call => {
      if (call.tool === 'get_session' && call.args['session_id'] === 'self') await clock.sleep(4_000)

      return answer(call)
    },
  })
  await $.session.start({ cwd: 'D:\\proj', surface: 'desktop', isInteractive: true })
  // Plan 4.2: no desktop call blocks the GitHub part; the refresh at 600 ms waits 1.5 s at most.
  await clock.advance(2_200)
  expect(ghCalls(argv)).toBeGreaterThan(0)
  expect(opened).toContain('issue-radar')
  await clock.advance(2_500)
  expect(closed).toContain('issue-radar')
  expect(statuses.at(-1)).toBe('Issue #42 · acme/widgets')
  // Stood down: no timer, no refresh.
  const gh = ghCalls(argv)
  await tick(clock)
  expect(ghCalls(argv)).toBe(gh)
})

test("a turn that starts before the last one's end was written still reads working (R5-RT-2)", async ($, on) => {
  const { store } = project(on, { stored: { [`session:${ROW_42}`]: OWN } })
  const clock = await started($, on)
  await $.turn.start({ text: '', turnId: 't1' })
  await clock.settle()
  // t1 ends on the proposal and the owner's queued "go" starts t2 at once.
  await $.turn.complete({ answer: 'Plan …\n\nGo?', durationMs: 900, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.turn.start({ text: 'go', turnId: 't2' })
  await clock.settle()
  expect(store.get(`phase:${ROW_42}`)).toMatchObject({ activity: 'working', ask: 'none', turns: 1 })
})

test("where the mod's own route cannot reach the app, the click asks with the press's words and releases a deleted session (R5-INT-1)", async ($, on) => {
  const { store, toolCalls, toasts } = project(on, {
    stored: { [`session:${ROW_42}`]: MAPPED },
    mcp: () => {
      throw new Error('MCP server "ccd_session_mgmt" is not connected')
    },
    toolCall: input => {
      if (String(input['tool']).endsWith('__get_session')) {
        const text = `Session ${String(input['session_id'])} not found.`

        return { result: { content: [{ type: 'text', text }], isError: true }, text, isError: true }
      }

      return { deny: 'no such tool' }
    },
  })
  await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // The polling raised nothing (the typed route would ask); the row looks as V1 drew it.
  expect(toolCalls).toHaveLength(0)
  expect(await labelOf(ui, `work:${ROW_42}`)).toBe(DE.openSession)

  await ui.press({ key: `work:${ROW_42}` })
  const typed = toolCalls.filter(call => String(call['tool']).startsWith('mcp__ccd_'))
  expect(typed.map(call => call['tool'])).toEqual(['mcp__ccd_session_mgmt__get_session'])
  expect(typed[0]?.['consent']).toBe(pressConsent(DE.openSession, `issue ${ROW_42}`))
  expect(store.has(`session:${ROW_42}`)).toBe(false)
  expect((store.get(`attempts:${ROW_42}`) as PreviousAttempt[])[0]).toMatchObject({ sessionId: 'local_abc123', endedAs: 'gone' })
  expect(toasts.at(-1)).toBe(DE.released(42))
  expect(await labelOf(ui, `work:${ROW_42}`)).toBe(DE.workOnIt)
  await ui.unmount()
})

test('Wieder öffnen on a session the owner restored meanwhile opens it without unarchiving, and the listing is read again 3 s later (R5-RT-3)', async ($, on) => {
  let isArchived = true
  const { mcp, toasts } = project(on, {
    stored: { [`session:${ROW_42}`]: MAPPED },
    mcp: desktop({
      list: () => (isArchived ? [] : [entry('local_abc123')]),
      other: call => (call.tool === 'unarchive_session' && !isArchived ? mcpText('Session local_abc123 is not archived.', true) : undefined),
    }),
  })
  const clock = await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await labelOf(ui, `work:${ROW_42}`)).toBe(DE.reopen)

  // Restored from the app's sidebar; no pass has run since.
  isArchived = false
  await ui.press({ key: `work:${ROW_42}` })
  expect(calls(mcp, 'unarchive_session')).toHaveLength(0)
  expect(calls(mcp, 'open_session_in').map(call => call.args['session_id'])).toEqual(['local_abc123'])
  expect(toasts.some(text => text.startsWith(DE.reopenFailed('').slice(0, 10)))).toBe(false)
  expect(await labelOf(ui, `work:${ROW_42}`)).toBe(DE.openSession)
  const listed = calls(mcp, 'list_sessions').length
  await clock.advance(3_000)
  expect(calls(mcp, 'list_sessions')).toHaveLength(listed + 1)
  await ui.unmount()
})

test('a pass in flight neither undoes what Wieder öffnen found nor swallows its re-read (R5-RT-3)', async ($, on) => {
  let isArchived = true
  let delay = 0
  const answer = desktop({ list: () => (isArchived ? [] : [entry('local_abc123')]) })
  const clock = mock.clock(on, { now: NOW })
  const { mcp } = project(on, {
    stored: { [`session:${ROW_42}`]: MAPPED },
    mcp: async call => {
      // What the app says as it stands when asked, however long the answer takes.
      const said = answer(call)
      if (call.tool === 'list_sessions' && delay > 0) await clock.sleep(delay)

      return said
    },
  })
  await $.session.start({ cwd: 'D:\\proj', surface: 'desktop', isInteractive: true })
  await clock.advance(1_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await badgeOf(ui, ROW_42)).toBe(DE.badges.archived)

  // ↻ starts a pass whose listing takes 4.9 s; meanwhile the owner restores the session in the sidebar and presses
  // Wieder öffnen, whose own listing (1 s) finds it listed.
  delay = 4_900
  const refreshing = ui.press({ key: 'refresh' })
  await clock.advance(100)
  const listed = calls(mcp, 'list_sessions').length
  isArchived = false
  delay = 1_000
  const pressing = ui.press({ key: `work:${ROW_42}` })
  await clock.advance(1_500)
  await pressing
  expect(calls(mcp, 'unarchive_session')).toHaveLength(0)
  // The pass ends after the press: its older word does not undo the press's; the 3 s re-read, due while the pass ran,
  // runs once it ends.
  await clock.advance(3_500)
  expect(await badgeOf(ui, ROW_42)).not.toBe(DE.badges.archived)
  expect(await labelOf(ui, `work:${ROW_42}`)).toBe(DE.openSession)
  await clock.advance(1_000)
  await refreshing
  expect(calls(mcp, 'list_sessions')).toHaveLength(listed + 2)
  expect(await labelOf(ui, `work:${ROW_42}`)).toBe(DE.openSession)
  await ui.unmount()
})

test('a refused unarchive opens the session where only the listing said archived, and stops where the app itself says so (R5-RT-3)', async ($, on) => {
  let isFlagged = false
  const { mcp, toasts } = project(on, {
    stored: { [`session:${ROW_42}`]: MAPPED },
    mcp: desktop({
      get: id => mcpText(JSON.stringify(entry(id, isFlagged ? { archived: true } : {}))),
      other: call => (call.tool === 'unarchive_session' ? mcpText('Refused: the session is busy.', true) : undefined),
    }),
  })
  await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await labelOf(ui, `work:${ROW_42}`)).toBe(DE.reopen)
  await ui.press({ key: `work:${ROW_42}` })
  expect(calls(mcp, 'unarchive_session')).toHaveLength(1)
  expect(calls(mcp, 'open_session_in')).toHaveLength(1)

  isFlagged = true
  await ui.press({ key: `work:${ROW_42}` })
  expect(calls(mcp, 'unarchive_session')).toHaveLength(2)
  expect(calls(mcp, 'open_session_in')).toHaveLength(1)
  expect(toasts.at(-1)).toBe(DE.reopenFailed('Refused: the session is busy.'))
  await ui.unmount()
})

test('Wieder öffnen and a confirmed Neu starten acknowledge their row, as Work on it does (R5-INT-2)', async ($, on) => {
  const { mcp } = project(on, {
    stored: { [`seen:${SECTION}`]: LAST_VISIT, [`session:${ROW_42}`]: MAPPED, [`session:${ROW_7}`]: { ...MAPPED, sessionId: 'local_s7', title: '#7 Dark mode' } },
    mcp: desktop({ get: id => (id === 'local_s7' ? mcpText(`Session ${id} not found.`, true) : undefined) }),
  })
  await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await badgeOf(ui, ROW_42)).toBe(DE.badges.archived)
  expect(await badgeOf(ui, ROW_7)).toBe(DE.badges.gone)
  expect(await ui.find({ key: `mark:${ROW_42}` })).toBeDefined()
  expect(await ui.find({ key: `mark:${ROW_7}` })).toBeDefined()

  await ui.press({ key: `work:${ROW_42}` })
  expect(calls(mcp, 'unarchive_session')).toHaveLength(1)
  expect(await ui.find({ key: `mark:${ROW_42}` })).toBeUndefined()

  await ui.press({ key: `work:${ROW_7}` })
  // B5-BEH-3: the confirmation says the earlier session no longer exists, in a sentence of its own.
  expect((await ui.find({ key: `fresh-ask:${ROW_7}` }))?.text).toContain(DE.freshAsk(7, true))
  expect(await ui.find({ key: `mark:${ROW_7}` })).toBeDefined()
  await ui.press({ key: `fresh-confirm:${ROW_7}` })
  expect(calls(mcp, 'start_session')).toHaveLength(1)
  expect(await ui.find({ key: `mark:${ROW_7}` })).toBeUndefined()
  await ui.unmount()
})

test("a closed issue's archived session is restored before it is opened, never called running (B5-BEH-2)", async ($, on) => {
  const { mcp, toasts } = project(on, {
    stored: {
      [`done:${ROW_7}`]: { v: 1, sessionId: 'local_seven', title: '#7 Dark mode', startedAt: NOW - 3_600_000, startedFrom: 'local_pane', closedAt: NOW - 60_000 },
      [SETTINGS]: { watch: [], consent: {}, collapsed: {}, showClosed: { [SECTION]: true } },
    },
    gh: args => (args[0] === 'issue' && args[1] === 'list' ? ran(args.includes('closed') ? CLOSED_7 : JSON.stringify([ROWS[0]])) : undefined),
    // Archived: absent from a complete listing, found by get_session.
    mcp: desktop({ get: id => mcpText(JSON.stringify(entry(id, { title: '#7 Dark mode' }))) }),
  })
  await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const before = mcp.length
  await ui.press({ key: `closed-session:${ROW_7}` })
  const after = mcp.slice(before).map(call => `${call.tool}:${String(call.args['session_id'] ?? '')}`)
  expect(after.filter(name => !name.startsWith('list_sessions') && !name.startsWith('get_status'))).toEqual(['get_session:local_seven', 'unarchive_session:local_seven', 'open_session_in:local_seven'])
  expect(toasts).toContain(DE.reopened('#7 Dark mode'))
  expect(toasts).not.toContain(DE.openElsewhere('#7 Dark mode'))
  await ui.unmount()
})

test("a turn of the pane's own session reads its rows' records at once, before the 15 s sync", async ($, on) => {
  const { store } = project(on, { stored: { [`session:${ROW_42}`]: MAPPED }, mcp: desktop({ list: () => [entry('local_abc123')] }) })
  const clock = await started($, on)
  store.set(`phase:${ROW_42}`, record({ ask: 'proposal', at: NOW + 500 }))
  await turn($, 't1', 'ok')
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await badgeOf(ui, ROW_42)).toBe(DE.badges.proposal)
  await ui.unmount()
})

test("a pane's start sweeps stale records: unmapped ones a day old, unreadable ones, and closed issues' sessions after two weeks", async ($, on) => {
  const day = 24 * 3_600_000
  const { store } = project(on, {
    stored: {
      [`session:${ROW_42}`]: MAPPED,
      [`phase:${ROW_42}`]: record({ at: NOW - 2 * day }),
      [`phase:${ROW_7}`]: record({ sessionId: 'local_s7', at: NOW - day - 3_600_000 }),
      [`phase:${SECTION}#9`]: { v: 2 },
      [`phase:${SECTION}#11`]: record({ sessionId: 'local_s11', at: NOW - 3_600_000 }),
      [`done:${SECTION}#8`]: { v: 1, sessionId: 'local_s8', title: 'x', startedAt: 1, startedFrom: 'local_pane', closedAt: NOW - 15 * day },
      [`done:${SECTION}#12`]: { v: 1, sessionId: 'local_s12', title: 'x', startedAt: 1, startedFrom: 'local_pane', closedAt: NOW - day },
    },
  })
  await started($, on)
  expect([...store.keys()].filter(key => /^(phase|done):/.test(key)).sort()).toEqual([`done:${SECTION}#12`, `phase:${SECTION}#11`, `phase:${ROW_42}`])
})

test('the listing is read again 8 s after a start', async ($, on) => {
  const { mcp } = project(on, { mcp: desktop({ list: () => [entry('local_new456')] }) })
  const clock = await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `work:${ROW_42}` })
  const listed = calls(mcp, 'list_sessions').length
  await clock.advance(7_900)
  expect(calls(mcp, 'list_sessions')).toHaveLength(listed)
  await clock.advance(200)
  expect(calls(mcp, 'list_sessions')).toHaveLength(listed + 1)
  await ui.unmount()
})

test('Zur Session on a session the app calls archived keeps the mapping and offers Wieder öffnen (V1 released it)', async ($, on) => {
  const { mcp, store, toasts } = project(on, {
    stored: { [`session:${ROW_42}`]: MAPPED },
    mcp: desktop({ list: () => [entry('local_abc123')], get: id => mcpText(JSON.stringify(entry(id, { archived: true }))) }),
  })
  await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await labelOf(ui, `work:${ROW_42}`)).toBe(DE.openSession)
  await ui.press({ key: `work:${ROW_42}` })
  expect(store.get(`session:${ROW_42}`)).toEqual(MAPPED)
  expect(toasts.at(-1)).toBe(DE.archivedChoose(42))
  expect(await labelOf(ui, `work:${ROW_42}`)).toBe(DE.reopen)
  expect(calls(mcp, 'open_session_in')).toHaveLength(0)
  await ui.unmount()
})

test("a badge resting on the app's word is drawn subdued once the listing has failed for more than ten minutes", async ($, on) => {
  let isDown = false
  const answer = desktop({ list: () => [entry('local_abc123', { state: 'running' })] })
  project(on, { stored: { [`session:${ROW_42}`]: MAPPED }, mcp: call => (isDown && call.tool === 'list_sessions' ? mcpText('unknown server ccd_session_mgmt', true) : answer(call)) })
  const clock = await started($, on)
  const inkOf = async (): Promise<unknown> => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const badge = (await ui.find({ key: `badge:${ROW_42}` })) as { children?: Array<{ props?: Record<string, unknown> }> } | undefined
    await ui.unmount()

    return badge?.children?.[0]?.props?.['color']
  }
  const fresh = await inkOf()
  expect(fresh).toBeDefined()
  isDown = true
  await tick(clock, 3)
  expect(await inkOf()).toBe(fresh)
  await tick(clock, 1)
  expect(await inkOf()).not.toBe(fresh)
})

test("a press from the terminal never opens the starter's session in the desktop window", async ($, on) => {
  const { mcp, toasts } = project(on, { stored: { [`session:${ROW_42}`]: MAPPED }, mcp: desktop({ list: () => [entry('local_abc123')] }) })
  await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `work:${ROW_42}` })
  expect(calls(mcp, 'open_session_in')).toHaveLength(0)
  expect(toasts.at(-1)).toBe(DE.openElsewhere(TITLE_42))
  await ui.unmount()
})

test("an issue's earlier attempts go when a complete list no longer holds it", async ($, on) => {
  const { store } = project(on, {
    stored: { [`attempts:${ROW_7}`]: [{ sessionId: 'local_old', title: '#7 Dark mode', startedAt: 1, endedAs: 'gone', at: NOW - 60_000 }], [`attempts:${ROW_42}`]: [{ sessionId: 'local_o42', title: TITLE_42, startedAt: 1, endedAs: 'gone', at: NOW - 60_000 }] },
    gh: args => (args[0] === 'issue' && args[1] === 'list' && !args.includes('closed') ? ran(JSON.stringify([ROWS[0]])) : undefined),
  })
  await started($, on)
  expect(store.has(`attempts:${ROW_7}`)).toBe(false)
  expect(store.has(`attempts:${ROW_42}`)).toBe(true)
})

test('an issue session shows its line again when a desktop attaches after it began where no pane is drawn', async ($, on) => {
  const surfaces: RenderSurface[] = ['vscode']
  const { statuses } = project(on, { stored: { [`session:${ROW_42}`]: OWN }, surfaces })
  await started($, on, 'vscode')
  expect(statuses.filter(text => text !== undefined)).toHaveLength(0)
  surfaces.push('desktop')
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  expect(statuses.at(-1)).toBe('Issue #42 · acme/widgets')
})

// The pure helpers -------------------------------------------------------------

test('the pure helpers of the record, the marker and the badge behave', async () => {
  for (const text of ['Go?', '**Go?**', '> "Go?"', 'Los?', 'Plan …\n\n`Go?`\n\n']) expect(askOf(text)).toBe('proposal')
  expect(askOf('Shall I go ahead?')).toBe('question')
  expect(askOf('Done.')).toBe('none')
  expect(askOf('')).toBe('none')

  expect(parseMarker('Issue Radar hand-off: acme/widgets#42\n\nWork')).toMatchObject({ kind: 'issue', rowKey: ROW_42, number: 42, repo: 'acme/widgets', fromId: '' })
  expect(parseMarker('  Issue Radar hand-off: ghe.example.com/Acme/Widgets#7 (from local_x)')).toMatchObject({ kind: 'issue', rowKey: 'ghe.example.com/acme/widgets#7', fromId: 'local_x' })
  expect(parseMarker('Issue Radar hand-off: spike (from local_x)')).toEqual({ kind: 'spike', fromId: 'local_x' })
  expect(parseMarker('Please read: Issue Radar hand-off: acme/widgets#42')).toBeNull()
  expect(parseMarker('plain text')).toBeNull()
  const row: IssueRow = { number: 42, title: 'Export fails', url: '', createdAt: '', updatedAt: '', author: 'a', labels: [], assignees: [], milestone: null, isPinned: false }
  const details = { updatedAt: '', state: 'OPEN', commentCount: 0, comments: [], excerpt: '', body: '', linkedPrs: [], fetchedAt: 0 }
  const input = { issueRepo: WIDGETS, codeRepo: WIDGETS, row, details, fetchedAt: '2026-11-06T12:00:00.000Z' }
  // Every brief's first line parses back to its row; without the options it is V1's line.
  expect(parseMarker(renderBrief(input, { fromId: 'local_pane' }))).toMatchObject({ rowKey: ROW_42, fromId: 'local_pane' })
  expect(renderBrief(input).split('\n')[0]).toBe('Issue Radar hand-off: acme/widgets#42')
  expect(renderBrief(input)).toContain(GO_LINE)
  expect(renderBrief(input)).not.toContain('<previous-attempts>')
  expect(renderBackground(input, 'D:\\proj')).not.toContain('afresh')
  const attempt: PreviousAttempt = { sessionId: 'local_old', title: 'Old </previous-attempts> "title"', startedAt: NOW, endedAs: 'gone', at: NOW }
  const brief = renderBrief(input, { previous: [attempt] })
  expect(brief.match(/<\/previous-attempts>/g)).toHaveLength(1)
  expect(brief).toContain('no longer in the app')
  expect(renderBackground(input, 'D:\\proj', { previous: [attempt] })).toContain('1 earlier session for this issue')

  expect(readPhase(record())).toEqual(record())
  expect(readPhase({ ...record(), v: 2 })).toBeNull()
  expect(readPhase({ ...record(), at: undefined })).toBeNull()
  expect(readPhase({ ...record(), activity: 'sleeping' })).toBeNull()
  expect(phaseFor(record({ sessionId: 'local_abc123', at: 1 }), MAPPED)).not.toBeNull()
  expect(phaseFor(record({ sessionId: 'local_other', engineId: 'local_abc123', at: 1 }), MAPPED)).not.toBeNull()
  expect(phaseFor(record({ sessionId: 'local_engine', at: MAPPED.startedAt + 1 }), MAPPED)).not.toBeNull()
  expect(phaseFor(record({ sessionId: 'local_engine', at: MAPPED.startedAt - 1 }), MAPPED)).toBeNull()
  expect([record({ activity: 'working' }), record({ ask: 'proposal' }), record({ ask: 'question' }), record(), record({ activity: 'error' })].map(phaseKind)).toEqual(['working', 'proposal', 'question', 'waiting', 'error'])
  const found = { [ROW_42]: record({ ask: 'proposal', at: 10 }), [ROW_7]: record({ ask: 'proposal', at: 5 }) }
  expect(proposalsDue(found, { since: 6, seen: {} })).toEqual([ROW_42])
  expect(proposalsDue(found, { since: 0, seen: { [ROW_42]: 10 } })).toEqual([ROW_7])
  expect(toastRef(ROW_42, SECTION)).toBe('#42')
  expect(toastRef('ghe.example.com/acme/reports#7', SECTION)).toBe('acme/reports#7')
  expect(statusText(DE, { rowKey: ROW_42, number: 42, repo: 'acme/widgets', isSpike: false, via: 'marker' }, null)).toBe('Issue #42 · acme/widgets')
})

test('the pure helpers of the listing and the ladder behave', async () => {
  expect(['running', 'needs_input', 'waiting_for_input', 'idle', 'completed', 'queued', 'failed', 'active', 'unarchived', ''].map(stateFamily)).toEqual(['working', 'waiting', 'waiting', 'idle', 'idle', 'starting', 'failed', null, null, null])
  expect(parseSessions(undefined, '[{"sessionId":"a"},{"id":"b"}]')?.map(found => found.id)).toEqual(['a', 'b'])
  expect(parseSessions({ sessions: [{ sessionId: 'a' }] }, '')?.map(found => found.id)).toEqual(['a'])
  expect(parseSessions(undefined, 'Your sessions:\n[{"sessionId":"a"}]')?.map(found => found.id)).toEqual(['a'])
  expect(parseSessions(undefined, 'ok')).toBeNull()
  expect(entryOf({ sessionId: 'a' })).toMatchObject({ archived: null, pr: 'unknown', parentSessionId: null })
  expect(entryOf({ sessionId: 'a', archived: true, pr: null, parentSessionId: 'p' })).toMatchObject({ archived: true, pr: 'no', parentSessionId: 'p' })
  expect(entryOf({ sessionId: 'a', prNumber: 12 })?.pr).toBe('yes')
  expect(entryOf({ title: 'no id' })).toBeNull()

  const live = (extra: Partial<SessionLive>): SessionLive => ({ sessionId: 'local_abc123', presence: 'active', state: null, raw: '', link: null, branch: null, pr: 'unknown', at: NOW, ...extra })
  const badge = (input: Partial<Parameters<typeof rowBadge>[0]>) => rowBadge({ mapping: MAPPED, live: undefined, record: undefined, isSelf: false, now: NOW, staleMs: 600_000, ...input })?.kind ?? null
  expect(badge({ isSelf: true, live: live({ presence: 'gone' }) })).toBe('self')
  expect(badge({ live: live({ presence: 'gone' }), record: record({ ask: 'proposal' }) })).toBe('gone')
  expect(badge({ live: live({ presence: 'archived' }) })).toBe('archived')
  expect(badge({ live: live({ presence: 'archived', sessionId: 'local_other' }) })).toBeNull()
  expect(badge({ live: live({ state: 'working', at: NOW }), record: record({ at: NOW - 1 }) })).toBe('working')
  expect(badge({ live: live({ state: 'idle', at: NOW }), record: record({ ask: 'proposal', at: NOW - 1 }) })).toBe('proposal')
  // F-CONFORMANCE-1: a finished turn is idle to the app; the record that waits for the owner stands against it.
  expect(badge({ live: live({ state: 'idle', at: NOW }), record: record({ ask: 'question', at: NOW - 1 }) })).toBe('question')
  expect(badge({ live: live({ state: 'idle', at: NOW }), record: record({ activity: 'error', at: NOW - 1 }) })).toBe('error')
  expect(badge({ live: live({ state: 'idle', at: NOW }), record: record({ at: NOW - 1 }) })).toBe('waiting')
  expect(badge({ live: live({ state: 'waiting', at: NOW }), record: record({ ask: 'question', at: NOW - 1 }) })).toBe('question')
  // A record left at working (a session that ended without its turn's end) yields to a newer idle; failed wins too.
  expect(badge({ live: live({ state: 'idle', at: NOW }), record: record({ activity: 'working', at: NOW - 1 }) })).toBe('idle')
  expect(badge({ live: live({ state: 'failed', at: NOW }), record: record({ ask: 'question', at: NOW - 1 }) })).toBe('error')
  expect(badge({ live: live({ state: 'idle', at: NOW - 1 }), record: record({ ask: 'question', at: NOW }) })).toBe('question')
  expect(badge({ live: live({}), record: record({ activity: 'error' }) })).toBe('error')
  expect(badge({ mapping: { ...MAPPED, startedAt: NOW - 60_000 }, live: live({}) })).toBe('starting')
  expect(badge({ live: live({}) })).toBe('active')
  expect(badge({})).toBeNull()
  // The app's word older than the stale age is drawn subdued; a record of the session's own never is.
  const stale = (at: number) => rowBadge({ mapping: MAPPED, live: live({ state: 'working', at }), record: undefined, isSelf: false, now: NOW, staleMs: 600_000 })?.isStale
  expect([stale(NOW - 600_001), stale(NOW - 600_000)]).toEqual([true, false])

  expect(readOpenAnswer({ ok: false, reason: 'Refused: the cursor is in a text field', text: '', via: 'mcp', isTransport: false }).outcome).toBe('refused')
  expect(readOpenAnswer({ ok: true, text: 'Already visible.', structured: undefined, via: 'mcp' }).outcome).toBe('already')
  expect(readOpenAnswer({ ok: true, text: 'Nothing changed: the user is looking at another session.', structured: undefined, via: 'mcp' }).outcome).toBe('refused')
  expect(readOpenAnswer({ ok: true, text: 'Opened in the main pane.', structured: undefined, via: 'mcp' }).outcome).toBe('shown')

  const tries = asAttempts([{ sessionId: 'a', title: 't', startedAt: 1, endedAs: 'gone', at: 2 }, { sessionId: 'b', title: 't', startedAt: 1, endedAs: 'lost', at: 2 }, 'x'])
  expect(tries.map(found => found.sessionId)).toEqual(['a'])
  const next = withAttempt([...tries, { sessionId: 'c', title: 't', startedAt: 1, endedAs: 'archived', at: 2 }, { sessionId: 'd', title: 't', startedAt: 1, endedAs: 'archived', at: 2 }], { sessionId: 'a', title: 'new', startedAt: 3, endedAs: 'archived', at: 4 })
  expect(next.map(found => `${found.sessionId}:${found.title}`)).toEqual(['a:new', 'c:t', 'd:t'])
})
