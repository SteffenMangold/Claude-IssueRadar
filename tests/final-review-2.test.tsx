// The final review's findings, part 2: the labels editor against a list that
// caught up with it, the store's bounds (the line about a full store, the sweep
// of what no session touched for 90 days), the probe's turns over the mapped
// issues, the records of sessions a row knows as others, the permission prompt
// in an issue session, and the reads a gh read, an attach or a collapsed
// section no longer cause. Asserted on keys, argv and the store.
import { expect, test } from 'claude-code/testing'

import { strings } from '../hooks/i18n'
import type { Mapping, PhaseRecord } from '../types'
import type { Ran } from './harness'
import { ISSUES, NOW, PANE, ROW_42, ROW_7, SECTION, TICK_MS, count, graphAnswer, graphQuery, op, ops, project, ran, started, tick } from './harness'

const DE = strings('de')
const SETTINGS = `settings:${SECTION}`
const DAY = 24 * 60 * 60_000
const LIMIT = { cost: 1, remaining: 4990, resetAt: '2026-11-06T13:00:00Z' }
const PRS_OK: Ran = graphAnswer({
  repository: {
    i42: { number: 42, closedByPullRequestsReferences: { totalCount: 0, nodes: [] } },
    i7: { number: 7, closedByPullRequestsReferences: { totalCount: 0, nodes: [] } },
  },
  viewer: { login: 'steffen' },
  rateLimit: LIMIT,
})

/** gh answers per GraphQL operation; everything else as the harness answers it. */
function graph(answers: Record<string, (argv: readonly string[]) => Ran>): (args: readonly string[]) => Ran | undefined {
  return args => {
    if (args[0] !== 'api') return undefined
    const name = op(args)

    return name === null ? undefined : answers[name]?.(args)
  }
}

function mapping(sessionId: string, title: string, startedAt: number): Mapping {
  return { sessionId, title, startedAt, startedFrom: 'local_other', detached: true }
}

function phase(extra: Partial<PhaseRecord>): PhaseRecord {
  return { v: 1, sessionId: 'local_abc123', activity: 'waiting', ask: 'none', at: NOW, turns: 1, ...extra }
}

// F-RUNTIME-2: the labels editor and a list that caught up --------------------------------

test('a pending label the list now carries is one chip, and Review sends nothing GitHub already has (F-RUNTIME-2)', async ($, on) => {
  let isLabelled = false
  const { runs } = project(on, {
    gh: args => {
      if (args[0] === 'label' && args[1] === 'list') return ran(JSON.stringify([{ name: 'bug', color: 'd73a4a' }, { name: 'enhancement', color: 'a2eeef' }]))
      if (args[0] === 'api' && args[1] === 'user') return ran('steffen\n')
      if (args[0] === 'issue' && args[1] === 'list' && isLabelled) {
        const rows = (JSON.parse(ISSUES) as Array<Record<string, unknown>>).map(row => (row['number'] === 7 ? { ...row, labels: [{ name: 'bug', color: 'd73a4a' }], updatedAt: '2026-11-06T12:05:00Z' } : row))

        return ran(JSON.stringify(rows))
      }

      return undefined
    },
  })
  const clock = await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `row-title:${ROW_7}` })
  await ui.press({ key: `act-labels:${ROW_7}` })
  await ui.select({ key: `lbl-add:${ROW_7}`, value: 'bug' })
  expect(await ui.findAll({ key: `lbl-x:${ROW_7}:bug` })).toHaveLength(1)

  // Someone adds 'bug' on GitHub; the timed refreshes run once the editor's hold is over.
  isLabelled = true
  for (let period = 0; period < 6; period++) await clock.advance(TICK_MS)
  expect(await ui.findAll({ key: `lbl-x:${ROW_7}:bug` })).toHaveLength(1)
  await ui.press({ key: `editor-review:${ROW_7}` })
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  expect((await ui.find({ key: `row:${ROW_7}` }))?.text).toContain(DE.labelsUnchanged)

  // Its ✕ now takes the label off, as the chip shows it on the issue.
  await ui.press({ key: `lbl-x:${ROW_7}:bug` })
  await ui.press({ key: `editor-review:${ROW_7}` })
  expect(String((await ui.find({ type: 'Code' }))?.props['source'])).toContain('--remove-label bug')
  expect(runs.filter(run => run.argv[1] === 'issue' && run.argv[2] === 'edit')).toHaveLength(0)
  await ui.unmount()
})

// F-STATE-1, F-STATE-4: the store's bounds ------------------------------------------------

test('a store that refuses writes is named in the pane until a refresh writes again (F-STATE-1)', async ($, on) => {
  let isFull = true
  project(on, { storeRefuses: () => isFull })
  const clock = await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'store-full' }))?.text).toContain(DE.storeFull)

  isFull = false
  await tick(clock)
  expect(await ui.find({ key: 'store-full' })).toBeUndefined()
  await ui.unmount()
})

test("what no session touched for 90 days leaves the store at a start; what it still uses stays (F-STATE-1, F-STATE-4)", async ($, on) => {
  const OLD = 'github.com/acme/legacy'
  const old = NOW - 100 * DAY
  const fresh = NOW - 2 * DAY
  const attempt = (at: number) => [{ sessionId: 'local_old', title: '#9 x', startedAt: at - DAY, endedAs: 'gone', at }]
  const { store } = project(on, {
    stored: {
      // A repository no session lists any more: its list, recaps, pull requests, closed list and seen record.
      [`cache:${OLD}`]: { fetchedAt: old, rows: [], meta: { '9': { updatedAt: '', commentCount: 0, excerpt: '', linkedPrs: [], seenAt: old } } },
      [`recaps:${OLD}`]: { '9': { updatedAt: '', text: 'x', model: 'haiku', at: old } },
      [`prs:${OLD}`]: { v: 1, fetchedAt: old, asOf: '', rows: {}, total: {} },
      [`seen:${OLD}`]: { v: 1, at: old, newest: '', rows: {} },
      [`closed:${OLD}`]: { v: 1, fetchedAt: old, since: '2026-07-01', rows: [], count: 0 },
      // A repository whose list is old but whose seen record another session wrote lately stays whole.
      'cache:github.com/acme/kept': { fetchedAt: old, rows: [], meta: {} },
      'seen:github.com/acme/kept': { v: 1, at: fresh, newest: '', rows: {} },
      // Earlier attempts: without a mapping and old, they go; with a mapping, or recent, they stay (both rows listed).
      [`attempts:${OLD}#9`]: attempt(old),
      [`attempts:${ROW_42}`]: attempt(fresh),
      [`attempts:${ROW_7}`]: attempt(old),
      [`session:${ROW_7}`]: mapping('local_seven', '#7 x', old),
    },
  })
  await started($, on)
  for (const prefix of ['cache:', 'recaps:', 'prs:', 'seen:', 'closed:']) expect(store.has(`${prefix}${OLD}`)).toBe(false)
  expect(store.has('cache:github.com/acme/kept')).toBe(true)
  expect(store.has('seen:github.com/acme/kept')).toBe(true)
  expect(store.has(`attempts:${OLD}#9`)).toBe(false)
  expect(store.has(`attempts:${ROW_42}`)).toBe(true)
  expect(store.has(`attempts:${ROW_7}`)).toBe(true)
  expect(store.has(`cache:${SECTION}`)).toBe(true)
})

// F-STATE-3, F-STATE-4: the probe's turns over the mapped issues ---------------------------

test('the probe skips the mapped issues its window shows and takes the rest in turns: a newer one that closed is released (F-STATE-3)', { options: { maxIssues: 2 } }, async ($, on) => {
  const stored: Record<string, unknown> = { [`session:${ROW_42}`]: mapping('local_s42', '#42 x', NOW - 200 * DAY) }
  for (let number = 100; number < 112; number++) stored[`session:${SECTION}#${number}`] = mapping(`local_s${number}`, `#${number} x`, NOW - (150 - number + 100) * DAY)
  stored[`session:${SECTION}#200`] = mapping('local_s200', '#200 x', NOW - DAY)
  stored[`attempts:${SECTION}#200`] = [{ sessionId: 'local_first', title: '#200 x', startedAt: NOW - 3 * DAY, endedAs: 'gone', at: NOW - 2 * DAY }]
  const probe = (argv: readonly string[]): Ran => {
    const asked = [...graphQuery(argv).matchAll(/\bm(\d+)\s*:/g)].map(found => Number(found[1]))
    const aliases = Object.fromEntries(asked.map(number => [`m${number}`, { number, state: number === 200 ? 'CLOSED' : 'OPEN' }]))

    return graphAnswer({ repository: { issues: { totalCount: 412, nodes: [{ number: 42, updatedAt: '2026-11-05T09:00:00Z', comments: { totalCount: 1 } }, { number: 7, updatedAt: '2026-11-01T09:00:00Z', comments: { totalCount: 1 } }] }, ...aliases }, rateLimit: LIMIT })
  }
  const { argv, store } = project(on, { stored, gh: graph({ IssueRadarProbe: probe, IssueRadarPrs: () => PRS_OK }) })
  const clock = await started($, on)
  const asked = () => ops(argv, 'IssueRadarProbe').map(call => [...graphQuery(call).matchAll(/\bm(\d+)\s*:/g)].map(found => found[1]))

  await tick(clock)
  expect(asked()[0]).toEqual(['100', '101', '102', '103', '104', '105', '106', '107', '108', '109'])
  await tick(clock)
  const second = asked()[1] ?? []
  expect(second).toContain('200')
  expect(second).toHaveLength(10)
  expect(asked().flat()).not.toContain('42')
  // #200 closed: its mapping is retired to its closed row's session, and its earlier attempts go with it (F-STATE-4).
  expect(store.has(`session:${SECTION}#200`)).toBe(false)
  expect(store.has(`done:${SECTION}#200`)).toBe(true)
  expect(store.has(`attempts:${SECTION}#200`)).toBe(false)
  expect(store.has(`session:${SECTION}#100`)).toBe(true)
})

// F-STATE-5: the records of sessions a row knows as others ---------------------------------

test("an old session used again does not speak for the row's new one; the new one's record does (F-STATE-5)", async ($, on) => {
  const current = mapping('local_new', '#42 Export fails for empty folders', NOW - 10 * 60_000)
  const { store, toasts } = project(on, {
    stored: {
      [`session:${ROW_42}`]: current,
      [`attempts:${ROW_42}`]: [{ sessionId: 'local_A', title: '#42 x', startedAt: NOW - DAY, endedAs: 'archived', at: NOW - 3_600_000 }],
      [`phase:${ROW_42}`]: phase({ sessionId: 'local_A', ask: 'proposal', at: NOW - 60_000 }),
    },
  })
  const clock = await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: `badge:${ROW_42}` }))?.text ?? '').not.toContain(DE.badges.proposal)
  expect(toasts.some(text => text.includes('#42'))).toBe(false)

  // The new session (it knows only its engine id) writes its own record: that one is drawn.
  store.set(`phase:${ROW_42}`, phase({ sessionId: 'local_engine_new', ask: 'proposal', at: NOW + 1_000 }))
  await clock.advance(16_000)
  expect((await ui.find({ key: `badge:${ROW_42}` }))?.text).toContain(DE.badges.proposal)
  await ui.unmount()
})

// F-CONFORMANCE-2: a permission prompt in an issue session --------------------------------

test('a permission prompt marks the issue session waiting until its call ran; a subagent or a dialog tool does not (F-CONFORMANCE-2)', async ($, on) => {
  const own = mapping('local_pane', '#42 Export fails for empty folders', NOW - 60_000)
  const { store } = project(on, { stored: { [`session:${ROW_42}`]: own }, check: () => 'allow', toolCall: () => ({ result: 'ok' }) })
  // Beneath the plugin: no settings hook decides; the person's dialog would.
  on('classic.PermissionRequest', () => ({}))
  const clock = await started($, on)
  const record = () => store.get(`phase:${ROW_42}`) as PhaseRecord | undefined
  await $.turn.start({ text: '', turnId: 't1' })
  await clock.settle()
  expect(record()).toMatchObject({ activity: 'working', ask: 'none' })

  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm test' } })
  await clock.settle()
  expect(record()).toMatchObject({ activity: 'waiting', ask: 'question' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await clock.settle()
  expect(record()).toMatchObject({ activity: 'working', ask: 'none' })

  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' }, agent_id: 'a1' })
  await $.classic.PermissionRequest({ tool_name: 'ExitPlanMode', tool_input: {} })
  await clock.settle()
  expect(record()).toMatchObject({ activity: 'working', ask: 'none' })

  // The turn ends while a prompt was open (refused, aborted): the turn's end stands, and the next turn starts clean.
  await $.classic.PermissionRequest({ tool_name: 'Edit', tool_input: { file_path: 'a.ts' } })
  await $.turn.complete({ answer: 'Stopped.', durationMs: 900, isAborted: true, turnId: 't1', reason: 'aborted' })
  await clock.settle()
  expect(record()).toMatchObject({ activity: 'waiting', ask: 'none' })
  await $.tool.call({ tool: 'Edit', file_path: 'a.ts', old_string: 'a', new_string: 'b' })
  await clock.settle()
  expect(record()).toMatchObject({ activity: 'waiting', ask: 'none' })
})

// F-BUDGET-2, F-BUDGET-3: the reads a gh read, an attach or a collapsed section cause --------

test('a gh read and a desktop attach refresh the list but leave the pull-request states to their interval; a change re-reads them (F-BUDGET-2)', async ($, on) => {
  const { argv } = project(on, { gh: graph({ IssueRadarPrs: () => PRS_OK }) })
  const clock = await started($, on)
  const lists = () => count(argv, 'issue', 'list')
  const prReads = () => ops(argv, 'IssueRadarPrs').length
  expect(prReads()).toBe(1)

  await clock.advance(40_000)
  const listed = lists()
  await $.tool.call({ tool: 'Bash', command: 'gh issue view 7 --comments' })
  await clock.advance(3_000)
  expect(lists()).toBe(listed + 1)
  expect(prReads()).toBe(1)

  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  await clock.advance(1_000)
  expect(lists()).toBe(listed + 2)
  expect(prReads()).toBe(1)

  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
  await clock.advance(3_000)
  expect(lists()).toBe(listed + 3)
  expect(prReads()).toBe(2)
})

test("a collapsed section's pull requests are not read once a record names the account; expanded, they are (F-BUDGET-3)", async ($, on) => {
  const record = { v: 1, fetchedAt: NOW - 3_600_000, asOf: '2026-11-05T09:00:00Z', rows: {}, total: {}, viewer: 'steffen' }
  const { argv } = project(on, { stored: { [SETTINGS]: { watch: [], consent: {}, collapsed: { [SECTION]: true } }, [`prs:${SECTION}`]: record }, gh: graph({ IssueRadarPrs: () => PRS_OK }) })
  const clock = await started($, on)
  const prReads = () => ops(argv, 'IssueRadarPrs').length
  expect(prReads()).toBe(0)
  await clock.advance(40_000)
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
  await clock.advance(3_000)
  await tick(clock, 4)
  expect(prReads()).toBe(0)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `section:${SECTION}` })
  await tick(clock)
  expect(prReads()).toBe(1)
  await ui.unmount()
})

test('a collapsed section without a stored record still has it read once: the account it names is needed (F-BUDGET-3)', async ($, on) => {
  const { argv } = project(on, { stored: { [SETTINGS]: { watch: [], consent: {}, collapsed: { [SECTION]: true } } }, gh: graph({ IssueRadarPrs: () => PRS_OK }) })
  const clock = await started($, on)
  expect(ops(argv, 'IssueRadarPrs')).toHaveLength(1)
  await tick(clock, 4)
  expect(ops(argv, 'IssueRadarPrs')).toHaveLength(1)
})
