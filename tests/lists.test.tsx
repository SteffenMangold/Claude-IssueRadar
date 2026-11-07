// Batch 2, the lists: E14's filter, search, saved views, sort and grouping
// (and E17-4's sub-issue search), E18's board status, E11's "assigned to me"
// section and E22's recently closed part. Asserted on keys and argv.
import { expect, mock, test } from 'claude-code/testing'

import { boardItemFor, boardOptions, boardValue, matchesBoard, parseBoardItems } from '../hooks/boards'
import { CLOSED_FIELDS, asClosedCache, closedCountLabel, closedRecord, isClosedDue, parseClosed, sinceDate } from '../hooks/closed'
import {
  DEFAULT_FILTER,
  SEARCH_URL_MAX,
  asSavedViews,
  cleanViewName,
  effectiveQuery,
  facetsOf,
  filterKey,
  groupRows,
  matchesUrl,
  retainMeta,
  sanitizeQuery,
  viewIdOf,
  viewQuery,
} from '../hooks/filter'
import { boardsQuery } from '../hooks/graph'
import { strings } from '../hooks/i18n'
import { asInboxCache, failedInbox, inboxPeriod, isInboxDue, parseInbox, searchArgs } from '../hooks/inbox'
import type { ClosedCache, Filter, InboxCache, IssueMeta, IssueRow } from '../types'
import type { Ran } from './harness'
import { ISSUES, NOW, PANE, ROW_42, ROW_7, SECTION, count, graphAnswer, graphQuery, issueView, op, ops, pairs, project, ran, started, tick } from './harness'

const DE = strings('de')
const SETTINGS = 'settings:github.com/acme/widgets'
const MAPPED_42 = { sessionId: 'local_abc123', title: '#42 Export fails', startedAt: 1, startedFrom: 'local_pane', detached: true }
const CHANGED = '2026-11-06T11:00:00Z'
const ROWS = JSON.parse(ISSUES) as Array<Record<string, unknown>>
const LIMIT = { cost: 1, remaining: 4990, resetAt: '2026-11-06T13:00:00Z' }

/** The fixture issues `numbers`, in that order, with `state` (a filtered list asks it); `extra` overrides fields. */
function listOf(numbers: readonly number[], extra: Record<number, Record<string, unknown>> = {}): string {
  return JSON.stringify(numbers.map(number => ({ ...(ROWS.find(row => row['number'] === number) ?? {}), state: 'OPEN', ...(extra[number] ?? {}) })))
}

/** The `--search=` value of an issue list argv (E14's single-argument form); null for V1's two-argument list. */
function searchOf(args: readonly string[]): string | null {
  return args.find(arg => arg.startsWith('--search='))?.slice('--search='.length) ?? null
}

/** The recorded `gh issue list` calls of the OPEN lists (not E22's closed ones), in order. */
function openLists(argv: readonly (readonly string[])[]): string[][] {
  return argv.filter(call => call[0] === 'gh' && call[1] === 'issue' && call[2] === 'list' && !pairs(call).includes('--state closed')).map(call => [...call])
}

function closedLists(argv: readonly (readonly string[])[]): string[][] {
  return argv.filter(call => call[0] === 'gh' && call[1] === 'issue' && call[2] === 'list' && pairs(call).includes('--state closed')).map(call => [...call])
}

function isList(args: readonly string[]): boolean {
  return args[0] === 'issue' && args[1] === 'list'
}

/** What the helpers need of a mounted drawing, on any surface. */
type Drawing = {
  find: (query: { type?: string; key?: string; text?: string | RegExp }) => Promise<{ type: string; key: string | undefined } | undefined>
  findAll: (query: { type?: string; key?: string; text?: string | RegExp }) => Promise<Array<{ key: string | undefined }>>
  press: (target: { key: string }) => Promise<unknown>
}

/** Opens the filter panel unless it is open (the panel's state outlives a mount). */
async function openFilter(ui: Drawing): Promise<void> {
  if ((await ui.find({ key: 'filter-view' })) === undefined) await ui.press({ key: 'filter' })
}

/** The row-title keys in the order drawn. */
async function drawnRows(ui: Drawing): Promise<string[]> {
  return (await ui.findAll({ type: 'Button' })).map(found => found.key ?? '').filter(key => key.startsWith('row-title:'))
}

// E14: filter, search, saved views ------------------------------------------

test("a view narrows every section through gh's search, and clearing it restores V1's list", async ($, on) => {
  const { argv } = project(on, { gh: args => (isList(args) && (searchOf(args) ?? '').includes('assignee:@me') ? ran(listOf([7])) : undefined) })
  const clock = await started($, on)

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await openFilter(ui)
    expect((await ui.find({ key: 'filter-view' }))?.type).toBe('Select')
    await ui.select({ key: 'filter-view', value: 'mine' })
    await clock.advance(1_000)

    const filtered = openLists(argv).at(-1) ?? []
    expect(filtered).toContain('--search=assignee:@me sort:updated-desc')
    expect(pairs(filtered)).toContain('--state open')
    expect(filtered[filtered.indexOf('--json') + 1]?.endsWith(',state')).toBe(true)
    expect(await ui.find({ key: `row-title:${ROW_7}` })).toBeDefined()
    expect(await ui.find({ key: `row-title:${ROW_42}` })).toBeUndefined()
    expect((await ui.find({ key: 'filter-line' }))?.text).toContain(DE.viewNames.mine)
    expect(await ui.find({ type: 'Text', text: new RegExp(DE.matches(1)) })).toBeDefined()

    await ui.press({ key: 'filter-clear' })
    await clock.advance(1_000)
    const restored = openLists(argv).at(-1) ?? []
    expect(pairs(restored)).toContain('--search sort:updated-desc')
    expect(searchOf(restored)).toBeNull()
    expect(await ui.find({ key: `row-title:${ROW_42}` })).toBeDefined()
    expect(await ui.find({ key: 'filter-line' })).toBeUndefined()
    await ui.unmount()
  }
})

test('the search composes, strips what would leave the repository, and goes as one argument', async ($, on) => {
  const { argv } = project(on, { gh: args => (isList(args) && searchOf(args) !== null ? ran(listOf([42])) : undefined) })
  const clock = await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openFilter(ui)

  await ui.input({ key: 'filter-search:0', text: 'export repo:evil/x is:closed is:pr' })
  await clock.advance(1_000)
  expect(openLists(argv).at(-1)).toContain('--search=export sort:updated-desc')
  expect((await ui.find({ key: 'filter-line' }))?.text).toContain(DE.filterIgnored('repo:evil/x is:closed is:pr'))
  expect((await ui.find({ key: 'filter-line' }))?.text).toContain('"export"')

  // A leading dash stays inside the one argument: gh never reads it as a flag.
  await ui.input({ key: 'filter-search:0', text: '-label:wontfix' })
  await clock.advance(1_000)
  expect(openLists(argv).at(-1)).toContain('--search=-label:wontfix sort:updated-desc')
  expect(argv.flat()).not.toContain('-label:wontfix')

  // A dangling operator left by a dropped token is dropped too (E14-3).
  await ui.input({ key: 'filter-search:0', text: 'label:bug OR (is:closed)' })
  await clock.advance(1_000)
  expect(openLists(argv).at(-1)).toContain('--search=label:bug sort:updated-desc')
  expect((await ui.find({ key: 'filter-line' }))?.text).toContain(DE.filterIgnored('(is:closed) OR'))
  await ui.unmount()
})

test('a filtered list never rewrites the default list, and keeps its issues known for the next time (E14-1)', { options: { maxIssues: 1 } }, async ($, on) => {
  let isChanged = false
  const { argv, store, prompts } = project(on, {
    stored: { [SETTINGS]: { watch: [], consent: { [SECTION]: true }, collapsed: {} }, [`session:${ROW_42}`]: MAPPED_42 },
    gh: args => {
      if (isList(args)) {
        if (searchOf(args) !== null) return ran(listOf([7]))

        // The default list is capped at one issue: #42, the most recently updated.
        return ran(listOf([42], isChanged ? { 42: { updatedAt: CHANGED } } : {}))
      }
      if (args[0] === 'issue' && args[1] === 'view' && args[2] === '42' && isChanged) return ran(issueView(42, 'OPEN', { updatedAt: CHANGED }))

      return undefined
    },
  })
  const clock = await started($, on)
  const before = store.get(`cache:${SECTION}`) as { fetchedAt: number; rows: Array<{ number: number }> }
  expect(before.rows.map(item => item.number)).toEqual([42])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openFilter(ui)

  await ui.select({ key: 'filter-view', value: 'mine' })
  await clock.advance(1_000)
  expect(await ui.find({ key: `row-title:${ROW_7}` })).toBeDefined()
  const cache = store.get(`cache:${SECTION}`) as { fetchedAt: number; rows: Array<{ number: number }>; meta: Record<string, IssueMeta> }
  expect(cache.rows.map(item => item.number)).toEqual([42])
  expect(cache.fetchedAt).toBe(before.fetchedAt)
  expect(Object.keys(cache.meta).sort()).toEqual(['42', '7'])
  expect(Object.keys(store.get(`recaps:${SECTION}`) as Record<string, unknown>).sort()).toEqual(['42', '7'])
  expect(store.get(`session:${ROW_42}`)).toBeDefined()

  // Back to the default list, where #42 changed: its meta and recap are renewed, #7's are kept within the bound.
  isChanged = true
  await ui.press({ key: 'filter-clear' })
  await clock.advance(1_000)
  expect(Object.keys((store.get(`cache:${SECTION}`) as { meta: Record<string, IssueMeta> }).meta).sort()).toEqual(['42', '7'])
  expect(Object.keys(store.get(`recaps:${SECTION}`) as Record<string, unknown>).sort()).toEqual(['42', '7'])

  // The same filter again: #7 is unchanged, so it costs no second read and no second recap.
  await ui.select({ key: 'filter-view', value: 'mine' })
  await clock.advance(1_000)
  expect(await ui.find({ key: `row-title:${ROW_7}` })).toBeDefined()
  expect(count(argv, 'issue', 'view', '7')).toBe(1)
  expect(count(argv, 'issue', 'view', '42')).toBe(2)
  const recapped = prompts.map(prompt => /Titel: (.*)/.exec(prompt)?.[1] ?? '?')
  expect(recapped.filter(title => title.startsWith('Dark mode'))).toHaveLength(1)
  expect(recapped.filter(title => title.startsWith('Export fails'))).toHaveLength(2)
  expect(store.get(`session:${ROW_42}`)).toBeDefined()
  await ui.unmount()
})

test('a filter shown again marks its issues shown though none needed a read, so the bound keeps them (B2-BEH-1)', { options: { maxIssues: 1 } }, async ($, on) => {
  let window = 42
  const { argv, store, prompts } = project(on, {
    stored: { [SETTINGS]: { watch: [], consent: { [SECTION]: true }, collapsed: {} } },
    gh: args => {
      if (!isList(args)) return undefined
      if (searchOf(args) !== null) return ran(listOf([7]))
      if (window === 42) return ran(listOf([42]))

      // The default list's one-row window moves on to issues the filter never shows.
      return ran(JSON.stringify([{ ...(ROWS[1] ?? {}), number: window, title: `Issue ${window}`, url: `https://github.com/acme/widgets/issues/${window}` }]))
    },
  })
  const clock = await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openFilter(ui)

  // #7 is read and recapped once; the default list then shows #42; the filter shows #7 twice more with nothing to read.
  await ui.select({ key: 'filter-view', value: 'mine' })
  await clock.advance(1_000)
  await ui.press({ key: 'filter-clear' })
  await clock.advance(1_000)
  await ui.select({ key: 'filter-view', value: 'mine' })
  await clock.advance(1_000)
  await ui.press({ key: 'refresh' })
  await clock.advance(1_000)
  // The default window moves twice: of four issues, the store keeps three (3 x maxIssues), and #42 was shown last.
  window = 43
  await ui.press({ key: 'filter-clear' })
  await clock.advance(1_000)
  window = 44
  await ui.press({ key: 'refresh' })
  await clock.advance(1_000)
  expect(Object.keys((store.get(`cache:${SECTION}`) as { meta: Record<string, IssueMeta> }).meta).sort()).toEqual(['43', '44', '7'])

  await ui.select({ key: 'filter-view', value: 'mine' })
  await clock.advance(1_000)
  expect(await ui.find({ key: `row-title:${ROW_7}` })).toBeDefined()
  expect(count(argv, 'issue', 'view', '7')).toBe(1)
  const recapped = prompts.map(prompt => /Titel: (.*)/.exec(prompt)?.[1] ?? '?')
  expect(recapped.filter(title => title.startsWith('Dark mode'))).toHaveLength(1)
  await ui.unmount()
})

test("sort and facets compose, GitHub's order is kept, and grouping draws without a fetch", async ($, on) => {
  const { argv } = project(on, {
    gh: args => {
      const search = isList(args) ? searchOf(args) : null
      if (search === null) return undefined

      // GitHub's answer for the oldest first: #7, then #42, though #42 was updated last.
      return ran(search.includes('label:"bug"') ? listOf([42]) : listOf([7, 42]))
    },
  })
  const clock = await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openFilter(ui)

  await ui.select({ key: 'filter-sort', value: 'oldest' })
  await clock.advance(1_000)
  expect(openLists(argv).at(-1)).toContain('--search=sort:created-asc')
  expect(await drawnRows(ui)).toEqual([`row-title:${ROW_7}`, `row-title:${ROW_42}`])

  // The label picker offers what the default list holds, 'any' as '*'.
  expect((await ui.find({ key: 'filter-label' }))?.props['options']).toEqual([
    { value: '*', label: DE.filterAny },
    { value: 'bug', label: 'bug' },
  ])
  await ui.select({ key: 'filter-label', value: 'bug' })
  await clock.advance(1_000)
  expect(openLists(argv).at(-1)).toContain('--search=label:"bug" sort:created-asc')
  await ui.select({ key: 'filter-label', value: '*' })
  await clock.advance(1_000)
  expect(openLists(argv).at(-1)).toContain('--search=sort:created-asc')

  const lists = openLists(argv).length
  await ui.select({ key: 'filter-group', value: 'label' })
  await clock.advance(1_000)
  expect(openLists(argv)).toHaveLength(lists)
  expect(await ui.find({ type: 'Text', text: /^bug · 1$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: new RegExp(`^${DE.groupEmpty.label} · 1$`) })).toBeDefined()
  expect(await ui.find({ key: `group:${SECTION}:bug` })).toBeDefined()
  expect(await ui.find({ key: `group:${SECTION}:-` })).toBeDefined()
  expect((await ui.find({ key: 'filter-line' }))?.text).toContain(DE.groupNames.label)
  await ui.unmount()
})

test('a saved view persists per repository, is offered in the picker, and can be removed', async ($, on) => {
  const { argv, store } = project(on, { gh: args => (isList(args) && searchOf(args) !== null ? ran(listOf([42])) : undefined) })
  const clock = await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openFilter(ui)
  expect(await ui.find({ key: 'filter-save:0' })).toBeUndefined()

  await ui.input({ key: 'filter-search:0', text: 'label:bug' })
  await clock.advance(1_000)
  const lists = openLists(argv).length
  await ui.input({ key: 'filter-save:0', text: 'Bugs' })
  await clock.advance(1_000)
  const id = viewIdOf('Bugs')
  expect((store.get(SETTINGS) as { views?: unknown }).views).toEqual([{ id, name: 'Bugs', query: 'label:bug' }])
  // The view asks what the search asked: no second list; the search field is drawn afresh (E14-4).
  expect(openLists(argv)).toHaveLength(lists)
  const picker = await ui.find({ key: 'filter-view' })
  expect(picker?.props['value']).toBe(id)
  expect(picker?.props['options']).toContainEqual({ value: id, label: 'Bugs' })
  expect(await ui.find({ key: 'filter-search:1' })).toBeDefined()
  expect(await ui.find({ key: 'filter-search:0' })).toBeUndefined()
  expect((await ui.find({ key: 'filter-line' }))?.text).toContain('Bugs')

  await ui.press({ key: 'settings' })
  expect(await ui.find({ key: `view:${id}` })).toBeDefined()
  await ui.press({ key: `view-remove:${id}` })
  await clock.advance(1_000)
  expect((store.get(SETTINGS) as { views?: unknown }).views).toBeUndefined()
  expect((await ui.find({ key: 'filter-view' }))?.props['value']).toBe('open')
  expect(searchOf(openLists(argv).at(-1) ?? [])).toBeNull()
  await ui.unmount()
})

test('an empty filtered list says so and links the same search on GitHub', async ($, on) => {
  project(on, { gh: args => (isList(args) && searchOf(args) !== null ? ran('[]') : undefined) })
  const clock = await started($, on)

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await openFilter(ui)
    await ui.select({ key: 'filter-view', value: 'mine' })
    await clock.advance(1_000)
    expect(await ui.find({ type: 'Text', text: /Keine Treffer in acme\/widgets/ })).toBeDefined()
    const link = await ui.find({ type: 'Link', text: DE.allMatches })
    expect(String(link?.props['href']).startsWith('https://github.com/acme/widgets/issues?q=is%3Aissue%20is%3Aopen%20assignee%3A%40me')).toBe(true)
    expect(await ui.find({ type: 'Text', text: new RegExp(DE.matches(0)) })).toBeDefined()
    await ui.press({ key: 'filter-clear' })
    await clock.advance(1_000)
    await ui.unmount()
  }
})

test("while a new filter's list is on its way, the section draws as loading, never the old rows (E14-5)", async ($, on) => {
  project(on, { gh: args => (isList(args) && searchOf(args) !== null ? ran(listOf([7])) : undefined) })
  const clock = await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openFilter(ui)

  await ui.select({ key: 'filter-view', value: 'mine' })
  // The refresh waits on the clock: the default list's rows are not drawn under the new filter line.
  expect(await ui.find({ key: `row-title:${ROW_42}` })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: DE.loading('acme/widgets') })).toBeDefined()
  expect((await ui.find({ key: `count:${SECTION}` }))?.text).toBe('…')
  await clock.advance(1_000)
  expect(await ui.find({ key: `row-title:${ROW_7}` })).toBeDefined()
  expect((await ui.find({ key: `count:${SECTION}` }))?.text).toBe('1')
  await ui.unmount()
})

test('a surface without Select picks a view with chips instead', async ($, on) => {
  project(on, { gh: args => (isList(args) && (searchOf(args) ?? '').includes('assignee:@me') ? ran(listOf([7])) : undefined) })
  const clock = await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  await ui.press({ key: 'filter' })
  expect((await ui.find({ key: 'filter-view' }))?.type).toBe('Box')
  expect(await ui.find({ type: 'Select' })).toBeUndefined()

  await ui.press({ key: 'filter-view:mine' })
  await clock.advance(1_000)
  expect(await ui.find({ key: `row-title:${ROW_7}` })).toBeDefined()
  expect(await ui.find({ key: `row-title:${ROW_42}` })).toBeUndefined()
  expect((await ui.find({ key: 'filter-view:mine' }))?.props['label']).toBe(`[${DE.viewNames.mine}]`)
  await ui.unmount()
})

test("an epic's open sub-issues are listed through the search, and the filter line says whose (E17-4)", async ($, on) => {
  const { argv } = project(on, {
    gh: args => {
      if (!isList(args)) return undefined
      if (searchOf(args) !== null) return ran(listOf([7]))

      return ran(listOf([42, 7], { 42: { subIssuesSummary: { completed: 1, total: 3, percentCompleted: 33 } } }))
    },
  })
  const clock = await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `row-title:${ROW_42}` })
  expect(await ui.find({ key: `sub-issues:${ROW_7}` })).toBeUndefined()

  await ui.press({ key: `sub-issues:${ROW_42}` })
  await clock.advance(1_000)
  expect(openLists(argv).at(-1)).toContain('--search=parent-issue:acme/widgets#42 sort:updated-desc')
  expect((await ui.find({ key: 'filter-line' }))?.text).toContain(DE.subIssuesOf('acme/widgets#42'))
  expect(await ui.find({ key: `row-title:${ROW_7}` })).toBeDefined()
  await ui.unmount()
})

test('a filtered section reads its own rows\' pull requests and leaves the stored record alone', async ($, on) => {
  const recorded = { v: 1, fetchedAt: NOW - 60_000, asOf: '2026-11-05T09:00:00Z', rows: {}, total: {} }
  const { argv, store } = project(on, {
    stored: { [`prs:${SECTION}`]: recorded },
    gh: args => {
      if (isList(args) && searchOf(args) !== null) return ran(listOf([7]))
      if (args[0] === 'api' && op(args) === 'IssueRadarPrs') {
        return graphAnswer({ repository: { i7: { number: 7, closedByPullRequestsReferences: { totalCount: 1, nodes: [{ number: 71, url: 'https://github.com/acme/widgets/pull/71', state: 'OPEN', isDraft: true, reviewDecision: null, repository: { nameWithOwner: 'acme/widgets' }, commits: { nodes: [] } }] } } }, rateLimit: LIMIT })
      }

      return undefined
    },
  })
  const clock = await started($, on)
  expect(ops(argv, 'IssueRadarPrs')).toHaveLength(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openFilter(ui)
  await ui.select({ key: 'filter-view', value: 'mine' })
  await clock.advance(1_000)
  expect(ops(argv, 'IssueRadarPrs')).toHaveLength(1)
  expect(await ui.find({ key: `pr:${ROW_7}:acme/widgets#71` })).toBeDefined()
  expect(store.get(`prs:${SECTION}`)).toEqual(recorded)
  await ui.unmount()
})

test('a filtered list is not the open set: it never releases a mapping', async ($, on) => {
  const { store } = project(on, { stored: { [`session:${ROW_42}`]: MAPPED_42 }, gh: args => (isList(args) && searchOf(args) !== null ? ran(listOf([7])) : undefined) })
  const clock = await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openFilter(ui)
  await ui.select({ key: 'filter-view', value: 'mine' })
  await clock.advance(1_000)
  // One row under a cap of 30 would read as a complete list; a filtered one says nothing about what closed.
  expect(await ui.find({ key: `row-title:${ROW_42}` })).toBeUndefined()
  expect(store.get(`session:${ROW_42}`)).toBeDefined()
  await ui.unmount()
})

test('the pure filter: sanitizing, the query, the views, groups, facets, the link and the bound', () => {
  expect(sanitizeQuery('label:"help wanted" -label:bug')).toEqual({ query: 'label:"help wanted" -label:bug', dropped: [] })
  expect(sanitizeQuery('export repo:x org:y -is:closed is:draft type:pr type:Bug linked:pr')).toEqual({ query: 'export type:Bug linked:pr', dropped: ['repo:x', 'org:y', '-is:closed', 'is:draft', 'type:pr'] })
  // Operators left dangling, leading or doubled go; parentheses that no longer pair up go, quoted ones stay.
  expect(sanitizeQuery('OR label:bug AND OR (repo:x) NOT').query).toBe('label:bug')
  expect(sanitizeQuery('(label:bug OR repo:x)').query).toBe('label:bug')
  expect(sanitizeQuery('(label:bug OR label:ux) label:"a (b"').query).toBe('(label:bug OR label:ux) label:"a (b"')
  expect(sanitizeQuery(`x\u0007y ${'z'.repeat(300)}`).query.length).toBeLessThanOrEqual(200)

  const now = Date.parse('2026-11-06T12:00:00Z')
  const f = (patch: Partial<Filter>): Filter => ({ ...DEFAULT_FILTER, ...patch })
  expect(effectiveQuery(DEFAULT_FILTER, [], now)).toBeNull()
  expect(effectiveQuery(f({ search: 'repo:x' }), [], now)).toBeNull()
  expect(effectiveQuery(f({ view: 'mine' }), [], now)).toBe('assignee:@me sort:updated-desc')
  expect(effectiveQuery(f({ search: 'sort:comments-desc', sort: 'oldest' }), [], now)).toBe('sort:comments-desc')
  expect(effectiveQuery(f({ label: 'help "wanted"', milestone: 'v2', sort: 'reactions' }), [], now)).toBe('label:"help wanted" milestone:"v2" sort:reactions-+1-desc')
  expect(viewQuery('recent', [], now)).toBe('updated:>=2026-10-30')
  expect(viewQuery('epics', [], now)).toBe('has:sub-issue')
  expect(viewQuery('custom:gone-123456', [], now)).toBe('')
  // The key of a filter ignores the day, and a search equals the view saved from it.
  expect(filterKey(f({ view: 'recent' }), [])).toBe(filterKey(f({ view: 'recent' }), []))
  const saved = [{ id: 'custom:bugs-abcdef', name: 'Bugs', query: 'label:bug repo:x' }]
  expect(filterKey(f({ view: 'custom:bugs-abcdef' }), saved)).toBe(filterKey(f({ search: 'label:bug' }), saved))
  expect(filterKey(DEFAULT_FILTER, saved)).toBeUndefined()

  // E14-2: a long search of four-byte characters (12 encoded characters each) would pass the Link's 2,048: the link
  // leaves the free text out.
  const long = f({ view: 'mine', search: '😀'.repeat(200) })
  const href = matchesUrl('https://github.com/acme/widgets', long, [], now)
  expect(href).toBe('https://github.com/acme/widgets/issues?q=is%3Aissue%20is%3Aopen%20assignee%3A%40me%20sort%3Aupdated-desc')
  expect((matchesUrl('https://github.com/acme/widgets', f({ search: 'export' }), [], now) ?? '').length).toBeLessThanOrEqual(SEARCH_URL_MAX)

  // E14-6: names without Latin letters, or that slug alike, get ids of their own; the same name is the same view.
  expect(viewIdOf('バグ')).not.toBe(viewIdOf('機能'))
  expect(viewIdOf('Bugs!')).not.toBe(viewIdOf('Bugs?'))
  expect(viewIdOf('Bugs')).toBe(viewIdOf(' bugs '))
  expect(viewIdOf('Bugs')).toMatch(/^custom:bugs-[0-9a-f]{6}$/)
  expect(cleanViewName('  a\u0007 name that is far too long to keep  ')).toBe('a name that is far too l')
  expect(cleanViewName('   ')).toBeNull()
  expect(asSavedViews([{ id: 'custom:a-1', name: 'A', query: 'x' }, { id: 'evil', name: 'B', query: 'y' }, { id: 'custom:a-1', name: 'C', query: 'z' }, 'junk'])).toEqual([{ id: 'custom:a-1', name: 'A', query: 'x' }])

  const row = (number: number, labels: string[], milestone: string | null = null): IssueRow => ({ number, title: '', url: '', createdAt: '', updatedAt: '', author: 'a', labels: labels.map(name => ({ name, color: '' })), assignees: [], milestone, isPinned: false })
  const grouped = groupRows([row(1, []), row(2, ['ux']), row(3, ['bug']), row(4, ['bug', 'ux'])], 'label')
  expect(grouped.map(group => [group.id, group.rows.map(item => item.number)])).toEqual([
    ['bug', [3, 4]],
    ['ux', [2]],
    ['', [1]],
  ])
  expect(groupRows([row(1, [])], 'none')).toEqual([{ id: '', rows: [row(1, [])] }])
  expect(facetsOf([[row(1, ['ux'], 'v1'), row(2, ['bug', 'ux'], 'v2')], [row(3, ['bug', 'ux', '*'], 'v2')]])).toEqual({ labels: ['ux', 'bug'], milestones: ['v2', 'v1'] })

  // E14-1's bound: the listed are kept and marked seen; the rest by recency, unless the list is complete.
  const meta = (seenAt?: number): IssueMeta => ({ updatedAt: '', commentCount: 0, excerpt: '', linkedPrs: [], ...(seenAt === undefined ? {} : { seenAt }) })
  const kept = retainMeta({ '1': meta(5), '2': meta(1), '3': meta(9), '4': meta() }, new Set(['4']), false, 3, 100)
  expect(Object.keys(kept).sort()).toEqual(['1', '3', '4'])
  expect(kept['4']?.seenAt).toBe(100)
  expect(Object.keys(retainMeta({ '1': meta(5), '2': meta(1) }, new Set(['2']), true, 3, 100))).toEqual(['2'])
})

// E18: board status ------------------------------------------------------------

const SCOPE_TEXT = "Your token has not been granted the required scopes to execute this query. The 'title' field requires one of the following scopes: ['read:project'], but your token has only been granted the: ['gist', 'read:org', 'repo', 'workflow'] scopes."
const NO_SCOPE: Ran = ran(JSON.stringify({ errors: [{ type: 'INSUFFICIENT_SCOPES', locations: [{ line: 1, column: 120 }], message: SCOPE_TEXT }] }), 1, `gh: ${SCOPE_TEXT}`)
const BOARDS_ON = { [SETTINGS]: { watch: [], consent: {}, collapsed: {}, boards: true } }

function item(status: string | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { project: { number: 3, title: 'Roadmap', closed: false, owner: { login: 'acme' }, ...extra }, status: status === null ? null : { name: status } }
}

const ON_BOARDS = graphAnswer({ repository: { i42: { projectItems: { nodes: [item('In Progress')] } }, i7: { projectItems: { nodes: [item('Todo')] } } }, rateLimit: LIMIT })

/** Answers IssueRadarBoards with `answer`; any other gh call goes to the harness. */
function boardsWith(answer: () => Ran): (args: readonly string[]) => Ran | undefined {
  return args => (args[0] === 'api' && op(args) === 'IssueRadarBoards' ? answer() : undefined)
}

test('without read:project the board status explains the command instead of failing, and asks again only when told', async ($, on) => {
  const { argv } = project(on, { stored: BOARDS_ON, gh: boardsWith(() => NO_SCOPE) })
  const clock = await started($, on)
  expect(ops(argv, 'IssueRadarBoards')).toHaveLength(1)

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: `work:${ROW_42}` })).toBeDefined()
    expect(await ui.find({ key: `retry:${SECTION}` })).toBeUndefined()
    if ((await ui.find({ key: 'boards-toggle' })) === undefined) await ui.press({ key: 'settings' })
    expect(await ui.find({ type: 'Code', text: 'gh auth refresh -s read:project' })).toBeDefined()
    expect(await ui.find({ key: 'boards-retry:github.com' })).toBeDefined()
    // The facet waits for the scope: one muted line instead of the picker.
    await openFilter(ui)
    expect(await ui.find({ key: 'filter-board' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: DE.boardScopeLine })).toBeDefined()
    await ui.unmount()
  }

  await tick(clock)
  expect(ops(argv, 'IssueRadarBoards')).toHaveLength(1)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'boards-retry:github.com' })
  expect(ops(argv, 'IssueRadarBoards')).toHaveLength(2)
  expect(argv.flat()).not.toContain('--show-token')
  await ui.unmount()
})

test('with the scope, rows carry their board status, and the facet filters without a fetch', async ($, on) => {
  const { argv } = project(on, { stored: BOARDS_ON, gh: boardsWith(() => ON_BOARDS) })
  const clock = await started($, on)
  const query = ops(argv, 'IssueRadarBoards')[0] ?? []
  expect(pairs(query)).toContain('-f owner=acme')
  expect(argv.flat()).not.toContain('--show-token')

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ key: `board:${ROW_42}` }))?.text).toBe(DE.boardChip('In Progress'))
    expect((await ui.find({ key: `board:${ROW_7}` }))?.text).toBe(DE.boardChip('Todo'))
    await openFilter(ui)
    const before = argv.length
    await ui.select({ key: 'filter-board', value: 'acme/3:In Progress' })
    await clock.advance(1_000)
    expect(argv.length).toBe(before)
    expect(await ui.find({ key: `row-title:${ROW_7}` })).toBeUndefined()
    expect(await ui.find({ key: `row-title:${ROW_42}` })).toBeDefined()
    expect((await ui.find({ key: 'filter-line' }))?.text).toContain(DE.boardAmong(2))
    expect((await ui.find({ key: `count:${SECTION}` }))?.text).toBe('1')
    expect(await ui.find({ type: 'Text', text: new RegExp(DE.shownOf(1, 2)) })).toBeDefined()
    await ui.select({ key: 'filter-board', value: '*' })
    expect(await ui.find({ key: `row-title:${ROW_7}` })).toBeDefined()
    await ui.unmount()
  }
})

test('a control character in a board status reaches no picker value, so the panel draws on every surface (R2-RT-1)', async ($, on) => {
  const odd = graphAnswer({ repository: { i42: { projectItems: { nodes: [item('Done\u0085')] } }, i7: { projectItems: { nodes: [item('Todo')] } } }, rateLimit: LIMIT })
  project(on, { stored: BOARDS_ON, gh: boardsWith(() => odd) })
  const clock = await started($, on)

  // The panel stays open from one mount to the next, as it does across a reload: a refused tree would close the pane
  // on every later draw.
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await openFilter(ui)
    expect(await ui.drawn()).toMatchObject({ type: 'Box' })
    expect((await ui.find({ key: 'filter-board' }))?.props['options']).toContainEqual({ value: 'acme/3:Done', label: DE.boardOption('Roadmap', 'Done') })
    expect((await ui.find({ key: `board:${ROW_42}` }))?.text).toBe(DE.boardChip('Done'))
    await ui.select({ key: 'filter-board', value: 'acme/3:Done' })
    await clock.advance(1_000)
    expect((await ui.find({ key: 'filter-board' }))?.props['value']).toBe('acme/3:Done')
    expect(await ui.find({ key: `row-title:${ROW_42}` })).toBeDefined()
    expect(await ui.find({ key: `row-title:${ROW_7}` })).toBeUndefined()
    await ui.select({ key: 'filter-board', value: '*' })
    await ui.unmount()
  }
  for (const surface of ['vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.drawn()).toMatchObject({ type: 'Box' })
    if (surface === 'mobile') expect(await ui.find({ key: 'filter-board:acme/3:Done' })).toBeDefined()
    await ui.unmount()
  }
})

test('more than 100 rows read their board status in more than one request (R2-RT-3)', { options: { maxIssues: 150 } }, async ($, on) => {
  const many = Array.from({ length: 120 }, (_, index) => ({ ...(ROWS[1] ?? {}), number: 1000 - index, title: `Issue ${1000 - index}`, url: `https://github.com/acme/widgets/issues/${1000 - index}` }))
  const asked: number[] = []
  const { argv } = project(on, {
    stored: BOARDS_ON,
    gh: args => {
      if (isList(args)) return ran(JSON.stringify(many))
      if (args[0] !== 'api' || op(args) !== 'IssueRadarBoards') return undefined
      const numbers = [...graphQuery(args).matchAll(/ i(\d+): issue/g)].map(match => Number(match[1]))
      asked.push(...numbers)

      return graphAnswer({ repository: Object.fromEntries(numbers.map(number => [`i${number}`, { projectItems: { nodes: [item('Todo')] } }])), rateLimit: LIMIT })
    },
  })
  await started($, on)
  expect(ops(argv, 'IssueRadarBoards')).toHaveLength(2)
  expect(new Set(asked).size).toBe(120)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // The 111th row has its status too, and the facet keeps every row on the board.
  expect((await ui.find({ key: `board:${SECTION}#890` }))?.text).toBe(DE.boardChip('Todo'))
  await openFilter(ui)
  await ui.select({ key: 'filter-board', value: 'acme/3:Todo' })
  expect((await ui.find({ key: `count:${SECTION}` }))?.text).toBe('120')
  await ui.unmount()
})

test('boards off: no board request and no board facet', async ($, on) => {
  const { argv } = project(on, { gh: boardsWith(() => ON_BOARDS) })
  const clock = await started($, on)
  await tick(clock)
  expect(ops(argv, 'IssueRadarBoards')).toHaveLength(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openFilter(ui)
  expect(await ui.find({ key: 'filter-board' })).toBeUndefined()
  expect(await ui.find({ key: `board:${ROW_42}` })).toBeUndefined()
  await ui.unmount()
})

test('the switch reads the board status at once, and off forgets it', async ($, on) => {
  const { argv, store } = project(on, { gh: boardsWith(() => ON_BOARDS) })
  const clock = await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'settings' })

  await ui.press({ key: 'boards-toggle' })
  expect(ops(argv, 'IssueRadarBoards')).toHaveLength(1)
  expect((store.get(SETTINGS) as { boards?: boolean }).boards).toBe(true)
  expect(await ui.find({ key: `board:${ROW_42}` })).toBeDefined()

  await ui.press({ key: 'boards-toggle' })
  expect((store.get(SETTINGS) as { boards?: boolean }).boards).toBeUndefined()
  expect(await ui.find({ key: `board:${ROW_42}` })).toBeUndefined()
  await tick(clock)
  expect(ops(argv, 'IssueRadarBoards')).toHaveLength(1)
  await ui.unmount()
})

test('a collapsed section reads no board status, and the timer asks the same rows at most once a minute (E18-2)', async ($, on) => {
  const { argv } = project(on, { stored: { [SETTINGS]: { watch: [], consent: {}, collapsed: { [SECTION]: true }, boards: true } }, gh: boardsWith(() => ON_BOARDS) })
  const clock = await started($, on)
  await tick(clock)
  expect(ops(argv, 'IssueRadarBoards')).toHaveLength(0)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `section:${SECTION}` })
  await ui.press({ key: 'refresh' })
  await clock.advance(1_000)
  expect(ops(argv, 'IssueRadarBoards')).toHaveLength(1)
  // A tool refresh right after asks nothing new for the same rows; the next tick does.
  await $.tool.call({ tool: 'Bash', command: 'gh issue list' })
  await clock.advance(5_000)
  expect(ops(argv, 'IssueRadarBoards')).toHaveLength(1)
  await tick(clock)
  expect(ops(argv, 'IssueRadarBoards')).toHaveLength(2)
  await ui.unmount()
})

test('a board failure other than the scope is named in the settings, and the rows stay as they were', async ($, on) => {
  project(on, { stored: BOARDS_ON, gh: boardsWith(() => ran('', 1, 'gh: HTTP 502: Bad Gateway (https://api.github.com/graphql)')) })
  await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: `work:${ROW_42}` })).toBeDefined()
  await ui.press({ key: 'settings' })
  expect(await ui.find({ type: 'Text', text: DE.boardUnavailable('gh: HTTP 502: Bad Gateway (https://api.github.com/graphql)') })).toBeDefined()
  expect(await ui.find({ key: 'boards-retry:github.com' })).toBeUndefined()
  await ui.unmount()
})

test('the pure boards: items, the facet, the pill and the query', () => {
  const items = parseBoardItems({ nodes: [item('In Progress'), item('Done', { closed: true, number: 4 }), item(null, { number: 5, title: 'Triage', owner: { login: 'me' } }), null, { project: null }] })
  expect(items).toEqual([
    { owner: 'acme', project: 3, title: 'Roadmap', status: 'In Progress' },
    { owner: 'me', project: 5, title: 'Triage', status: null },
  ])
  expect(boardValue({ owner: 'me', project: 5, status: null })).toBe('me/5:')
  // A picker value never holds a control character (R2-RT-1); the row still matches the value it is offered under.
  expect(boardValue({ owner: 'acme', project: 3, status: 'Done\u0085\u0007' })).toBe('acme/3:Done')
  expect(matchesBoard([{ owner: 'acme', project: 3, title: 'Roadmap', status: 'Done\u0085' }], 'acme/3:Done')).toBe(true)
  expect(matchesBoard(items, 'me/5:')).toBe(true)
  expect(matchesBoard(items, 'acme/3:Todo')).toBe(false)
  expect(matchesBoard(undefined, '')).toBe(true)
  expect(boardOptions([items, [items[0] ?? { owner: '', project: 0, title: '', status: null }]]).map(option => option.value)).toEqual(['acme/3:In Progress', 'me/5:'])
  expect(boardItemFor(items, 'me/5:')?.title).toBe('Triage')
  expect(boardItemFor(items, '')?.status).toBe('In Progress')
  expect(boardItemFor([], '')).toBeNull()
  const query = boardsQuery([42, 7, 42, 0, -1])
  expect(query.startsWith('query IssueRadarBoards(')).toBe(true)
  expect(query).toContain('i42: issue(number: 42) { ...Board }')
  expect(query).toContain('i7: issue(number: 7) { ...Board }')
  expect(query).not.toContain('i0:')
  expect(query).toContain('fieldValueByName(name: "Status")')
  expect(query).not.toContain('mutation')
})

// E11: assigned to me ------------------------------------------------------------

const ME = { options: { assignedToMe: true } }
const OTHER = JSON.stringify({ nameWithOwner: 'other/thing', isPrivate: false, hasIssuesEnabled: true, isArchived: false, isFork: false, url: 'https://github.com/other/thing', defaultBranchRef: { name: 'main' } })
const OTHER_ROW_3 = 'github.com/other/thing#3'
const SEARCH = JSON.stringify([
  { repository: { name: 'widgets', nameWithOwner: 'acme/widgets' }, number: 7, title: 'Dark mode for the settings page', url: 'https://github.com/acme/widgets/issues/7', updatedAt: '2026-11-01T09:00:00Z', createdAt: '2026-10-01T10:00:00Z', commentsCount: 2, labels: [], isPullRequest: false },
  { repository: { name: 'thing', nameWithOwner: 'other/thing' }, number: 3, title: 'Crash on start', url: 'https://github.com/other/thing/issues/3', updatedAt: '2026-11-05T09:00:00Z', createdAt: '2026-11-01T10:00:00Z', commentsCount: 0, labels: [{ name: 'bug', color: 'd73a4a' }], isPullRequest: false },
  { repository: { name: 'thing', nameWithOwner: 'other/thing' }, number: 4, title: 'A pull request', url: 'https://github.com/other/thing/pull/4', updatedAt: '2026-11-05T09:00:00Z', createdAt: '2026-11-01T10:00:00Z', commentsCount: 0, labels: [], isPullRequest: true },
])

function searches(argv: readonly (readonly string[])[]): number {
  return count(argv, 'search', 'issues')
}

/** Answers gh search with `answer` (SEARCH by default), `repo view … -- other/thing` with other/thing and its one issue. */
function searchWith(answer: () => Ran = () => ran(SEARCH)): (args: readonly string[]) => Ran | undefined {
  return args => {
    if (args[0] === 'search' && args[1] === 'issues') return answer()
    if (args[0] === 'repo' && args.at(-1) === 'other/thing') return ran(OTHER)
    if (isList(args) && args.includes('other/thing')) return ran(JSON.stringify([{ ...(ROWS[0] ?? {}), number: 3, title: 'Crash on start', url: 'https://github.com/other/thing/issues/3' }]))

    return undefined
  }
}

test('the inbox lists my assigned issues across repositories, collapsed until opened', ME, async ($, on) => {
  const { argv, store } = project(on, { gh: searchWith() })
  await started($, on)
  expect(searches(argv)).toBe(1)
  const search = argv.find(call => call[1] === 'search') ?? []
  expect(pairs(search)).toContain('--assignee @me')
  expect(pairs(search)).toContain('--state open')
  expect(search).toContain('--archived=false')

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'section:inbox' })).toBeDefined()
    expect((await ui.find({ key: 'count:inbox' }))?.text).toBe('2')
    expect((await ui.findAll({ type: 'Box' })).some(found => (found.key ?? '').startsWith('inbox-row:'))).toBe(false)

    await ui.press({ key: 'section:inbox' })
    expect(await ui.find({ key: `inbox-row:${OTHER_ROW_3}` })).toBeDefined()
    expect(await ui.find({ key: `inbox-watch:${OTHER_ROW_3}` })).toBeDefined()
    expect(await ui.find({ key: `inbox-show:${ROW_7}` })).toBeDefined()
    expect(await ui.find({ key: `inbox-watch:${ROW_7}` })).toBeUndefined()
    expect(await ui.find({ key: 'inbox-row:github.com/other/thing#4' })).toBeUndefined()
    expect((store.get(SETTINGS) as { collapsed: Record<string, boolean> }).collapsed['inbox']).toBe(false)
    await ui.press({ key: 'section:inbox' })
    await ui.unmount()
  }
  const stored = store.get('inbox:github.com') as InboxCache
  expect(stored.rows.map(row => `${row.repo}#${row.number}`)).toEqual(['acme/widgets#7', 'other/thing#3'])
  expect(JSON.stringify(stored)).not.toContain('body')
})

type Drawn = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

/** A drawn element's element children (its strings left out). */
function elementsIn(node: unknown): Drawn[] {
  const children = (node as Drawn | undefined)?.children ?? []

  return children.filter((child): child is Drawn => typeof child === 'object' && child !== null)
}

/** The cells a drawn part takes on the terminal: its strings and a Button's or Link's label, one cell a character. */
function cellsOf(node: unknown): number {
  if (typeof node === 'string' || typeof node === 'number') return [...String(node)].length
  if (typeof node !== 'object' || node === null) return 0
  const element = node as Drawn
  const label = element.type === 'Button' || element.type === 'Link' ? [...String(element.props?.['label'] ?? '')].length : 0

  return label + (element.children ?? []).reduce((sum: number, child) => sum + cellsOf(child), 0)
}

test('an inbox row keeps to two lines at 46 columns: only the title and the repository give way (F-CONFORMANCE-4)', ME, async ($, on) => {
  project(on, { gh: searchWith() })
  await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'section:inbox' })
  // acme/widgets#7 carries ↓ Zeigen, other/thing#3 the wider + Beobachten.
  for (const key of [ROW_7, OTHER_ROW_3]) {
    const row = await ui.find({ key: `inbox-row:${key}` })
    const inside = 46 - 2 * Number(row?.props['paddingX'] ?? 0)
    const lines = elementsIn(row)
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      // A line never wraps: one Box at minWidth 0 holds the text that is cut, every other part keeps its width.
      expect(line.type).toBe('Box')
      expect(line.props?.['flexDirection']).toBe('row')
      expect(line.props?.['flexWrap']).toBeUndefined()
      const parts = elementsIn(line)
      const giving = parts.filter(part => part.props?.['flexShrink'] !== 0)
      expect(giving).toHaveLength(1)
      expect(giving[0]?.props).toMatchObject({ flexShrink: 1, minWidth: 0 })
      const kept = parts.filter(part => part.props?.['flexShrink'] === 0).reduce((sum, part) => sum + cellsOf(part), 0)
      const gaps = (parts.length - 1) * Number(line.props?.['columnGap'] ?? 0)
      expect(inside - kept - gaps).toBeGreaterThanOrEqual(10)
    }
    // GitHub ↗ beside the title, the action beside the age and the comments.
    expect(typesOf(lines[0])).toContain('Link')
    expect(typesOf(lines[1])).not.toContain('Link')
    expect(typesOf(lines[1])).toContain('Button')
  }
  await ui.unmount()
})

/** Every element type beneath a drawn element. */
function typesOf(node: unknown): string[] {
  return elementsIn(node).flatMap(child => [...(child.type === undefined ? [] : [child.type]), ...typesOf(child)])
}

test('the search is rare and shared: by age, a minute apart for ↻ only, never for the mod\'s own re-runs (E11-2)', ME, async ($, on) => {
  const { argv } = project(on, { gh: searchWith() })
  const clock = await started($, on)
  expect(searches(argv)).toBe(1)
  // At 900 s the stored search is 899.4 s old: not yet due.
  await tick(clock, 5)
  expect(searches(argv)).toBe(1)
  await tick(clock)
  expect(searches(argv)).toBe(2)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await clock.advance(10_000)
  await ui.press({ key: 'refresh' })
  await clock.advance(1_000)
  expect(searches(argv)).toBe(2)
  await clock.advance(60_000)
  // A consent re-runs the refresh as 'manual': that is no press, so the age gate holds.
  await ui.press({ key: `consent-on:${SECTION}` })
  await clock.advance(1_000)
  expect(searches(argv)).toBe(2)
  await ui.press({ key: 'refresh' })
  await clock.advance(1_000)
  expect(searches(argv)).toBe(3)
  await ui.unmount()
})

test('a search another pane made a moment ago is drawn, not made again', ME, async ($, on) => {
  const fresh: InboxCache = { v: 1, fetchedAt: NOW - 60_000, triedAt: NOW - 60_000, rows: [{ host: 'github.com', repo: 'other/thing', number: 3, title: 'Crash on start', url: 'https://github.com/other/thing/issues/3', createdAt: '', updatedAt: '2026-11-05T09:00:00Z', commentCount: 0, labels: [] }] }
  const { argv } = project(on, { stored: { 'inbox:github.com': fresh }, gh: searchWith() })
  await started($, on)
  expect(searches(argv)).toBe(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'count:inbox' }))?.text).toBe('1')
  await ui.unmount()
})

test('a pane placed only at the attach searches in the attach refresh (E11-1)', ME, async ($, on) => {
  let isAttached = false
  const { argv } = project(on, { surfaces: [], open: () => (isAttached ? { value: { isPlaced: true } } : { value: { isPlaced: false, reason: 'no-surface' } }), gh: searchWith() })
  const clock = await started($, on)
  expect(searches(argv)).toBe(0)
  isAttached = true
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  await clock.advance(1_000)
  expect(searches(argv)).toBe(1)
})

test('off by default: never a search, and the inbox keys of an earlier time are swept', async ($, on) => {
  const { argv, store } = project(on, { stored: { 'inbox:github.com': { v: 1, fetchedAt: NOW, rows: [] } }, gh: searchWith() })
  const clock = await started($, on)
  await tick(clock, 2)
  expect(searches(argv)).toBe(0)
  expect(store.has('inbox:github.com')).toBe(false)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'section:inbox' })).toBeUndefined()
  await ui.unmount()
})

test('a rate-limited search keeps the last inbox and holds even ↻ for ten minutes', ME, async ($, on) => {
  const old: InboxCache = { v: 1, fetchedAt: NOW - 3_600_000, rows: [{ host: 'github.com', repo: 'other/thing', number: 3, title: 'Crash on start', url: 'https://github.com/other/thing/issues/3', createdAt: '', updatedAt: '2026-11-05T09:00:00Z', commentCount: 0, labels: [] }] }
  const { argv, store } = project(on, { stored: { 'inbox:github.com': old }, gh: searchWith(() => ran('', 1, 'HTTP 403: API rate limit exceeded for user ID 1.')) })
  const clock = await started($, on)
  expect(searches(argv)).toBe(1)
  const held = store.get('inbox:github.com') as InboxCache
  expect(held.holdUntil).toBe(NOW + 600 + 600_000)
  expect(held.rows).toHaveLength(1)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'section:inbox' })
  expect(await ui.find({ key: `inbox-row:${OTHER_ROW_3}` })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /GitHub drosselt/ })).toBeDefined()
  await clock.advance(120_000)
  await ui.press({ key: 'refresh' })
  await clock.advance(1_000)
  expect(searches(argv)).toBe(1)
  await ui.unmount()
})

const BAD_GATEWAY = 'gh: HTTP 502: Bad Gateway'

test('a first search that fails marks the collapsed header instead of loading, and the store keeps what failed (B2-BEH-5)', ME, async ($, on) => {
  const { argv, store } = project(on, { gh: searchWith(() => ran('', 1, BAD_GATEWAY)) })
  await started($, on)
  expect(searches(argv)).toBe(1)
  expect((store.get('inbox:github.com') as InboxCache).failed).toEqual({ kind: 'error', host: 'github.com', detail: BAD_GATEWAY })

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ key: 'count:inbox' }))?.text).toBe('!')
    await ui.press({ key: 'section:inbox' })
    expect(await ui.find({ type: 'Text', text: DE.error(BAD_GATEWAY) })).toBeDefined()
    await ui.press({ key: 'section:inbox' })
    await ui.unmount()
  }
})

test("another pane's failed search is drawn as that failure and asks nothing until its back-off ends (R2-RT-4)", ME, async ($, on) => {
  const failed = failedInbox(undefined, { kind: 'error', host: 'github.com', detail: BAD_GATEWAY }, NOW - 120_000, inboxPeriod(3))
  const { argv } = project(on, { stored: { 'inbox:github.com': failed }, gh: searchWith() })
  const clock = await started($, on)
  expect(searches(argv)).toBe(0)

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ key: 'count:inbox' }))?.text).toBe('!')
    await ui.press({ key: 'section:inbox' })
    expect(await ui.find({ type: 'Text', text: DE.error(BAD_GATEWAY) })).toBeDefined()
    await ui.press({ key: 'section:inbox' })
    await ui.unmount()
  }
  // The other pane's try was two minutes ago: the 15-minute back-off ends at the fifth tick, and that search answers.
  await tick(clock, 4)
  expect(searches(argv)).toBe(0)
  await tick(clock)
  expect(searches(argv)).toBe(1)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'count:inbox' }))?.text).toBe('2')
  await ui.unmount()
})

test('+ Beobachten watches the repository; ↓ Zeigen opens the row, also in a collapsed section, and scrolls to it', ME, async ($, on) => {
  const { store, logs } = project(on, { gh: searchWith() })
  const clock = await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'section:inbox' })

  await ui.press({ key: `inbox-watch:${OTHER_ROW_3}` })
  await clock.advance(1_000)
  expect((store.get(SETTINGS) as { watch: string[] }).watch).toEqual(['other/thing'])
  expect(await ui.find({ key: 'sec:github.com/other/thing' })).toBeDefined()
  expect(await ui.find({ key: `inbox-show:${OTHER_ROW_3}` })).toBeDefined()
  expect(await ui.find({ key: `inbox-watch:${OTHER_ROW_3}` })).toBeUndefined()

  // E11-4: the row is listed though its section is collapsed; the press expands it.
  await ui.press({ key: `section:${SECTION}` })
  expect(await ui.find({ key: `row-title:${ROW_7}` })).toBeUndefined()
  await ui.press({ key: `inbox-show:${ROW_7}` })
  expect((store.get(SETTINGS) as { collapsed: Record<string, boolean> }).collapsed[SECTION]).toBeUndefined()
  expect(await ui.find({ key: `row-title:${ROW_7}` })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: DE.lastComments })).toBeDefined()
  // The scroll to the row's title is refused here (the kit implements no $.ui.scroll): it is tried once more a moment
  // later (E11-5), then left to the owner, with one debug line naming the target.
  const refused = () => logs.filter(line => line.includes(`scroll to row-title:${ROW_7} refused`))
  expect(refused()).toHaveLength(0)
  await clock.advance(1_000)
  expect(refused()).toHaveLength(1)
  await ui.unmount()
})

test('the pure inbox: the search, its rows, when it is due and how a failure waits', () => {
  expect(searchArgs('ghe.example.com', 30).env).toEqual({ GH_HOST: 'ghe.example.com' })
  expect(searchArgs('github.com', 30).env).toBeUndefined()
  expect(searchArgs('github.com', 12).args).toContain('12')
  const rows = parseInbox(SEARCH, 'github.com') ?? []
  expect(rows.map(row => [row.host, row.repo, row.number, row.commentCount])).toEqual([
    ['github.com', 'acme/widgets', 7, 2],
    ['github.com', 'other/thing', 3, 0],
  ])
  expect(parseInbox('nope', 'github.com')).toBeNull()

  const period = inboxPeriod(3)
  expect(period).toBe(900_000)
  expect(inboxPeriod(10)).toBe(3_000_000)
  const at = 1_000_000
  const done: InboxCache = { v: 1, fetchedAt: at, triedAt: at, rows: [] }
  expect(isInboxDue(undefined, 'timer', at, period)).toBe(true)
  expect(isInboxDue(done, 'timer', at + period - 1, period)).toBe(false)
  expect(isInboxDue(done, 'tool', at + period, period)).toBe(true)
  expect(isInboxDue(done, 'manual', at + 61_000, period)).toBe(false)
  expect(isInboxDue(done, 'press', at + 59_000, period)).toBe(false)
  expect(isInboxDue(done, 'press', at + 60_000, period)).toBe(true)

  // E11-6: a rate limit holds every search, no network waits two minutes, anything else a whole period.
  const limited = failedInbox(done, { kind: 'rate-limited' }, at + period, period)
  expect(isInboxDue(limited, 'press', at + period + 599_000, period)).toBe(false)
  expect(isInboxDue(limited, 'timer', at + period + 600_000, period)).toBe(true)
  const offline = failedInbox(done, { kind: 'offline' }, at + period, period)
  expect(isInboxDue(offline, 'timer', at + period + 119_000, period)).toBe(false)
  expect(isInboxDue(offline, 'timer', at + period + 120_000, period)).toBe(true)
  const broken = failedInbox(done, { kind: 'error', detail: 'boom' }, at + period, period)
  expect(isInboxDue(broken, 'timer', at + period + 180_000, period)).toBe(false)
  expect(isInboxDue(broken, 'timer', at + 2 * period, period)).toBe(true)
  expect(isInboxDue(broken, 'press', at + period + 60_000, period)).toBe(true)
  // R2-RT-4: the record says what failed, for every pane; an answered search clears it.
  expect(broken.failed).toEqual({ kind: 'error', detail: 'boom' })
  expect(asInboxCache(JSON.parse(JSON.stringify(broken)))?.failed).toEqual({ kind: 'error', detail: 'boom' })
  expect(asInboxCache({ v: 1, fetchedAt: 5, rows: [], failed: { kind: 'ok' } })?.failed).toBeUndefined()
  expect(asInboxCache({ v: 1, fetchedAt: 5, rows: [], failed: { kind: 'rate-limited', detail: 7 } })?.failed).toEqual({ kind: 'rate-limited' })
  expect(asInboxCache({ v: 1, fetchedAt: 5, rows: [{ repo: 'a/b', number: 1 }, { repo: 'nope', number: 2 }], retryAt: 9 })).toMatchObject({ fetchedAt: 5, retryAt: 9, rows: [{ repo: 'a/b', number: 1, host: 'github.com' }] })
  expect(asInboxCache({ v: 2, fetchedAt: 5, rows: [] })).toBeUndefined()
})

// E22: recently closed ---------------------------------------------------------

const CLOSED = JSON.stringify([
  { number: 38, title: 'Duplicate of the export bug', url: 'https://github.com/acme/widgets/issues/38', closedAt: '2026-11-01T08:00:00Z', stateReason: 'DUPLICATE', closedByPullRequestsReferences: [] },
  {
    number: 40,
    title: 'Export crashes on symlinks',
    url: 'https://github.com/acme/widgets/issues/40',
    closedAt: '2026-11-04T10:00:00Z',
    stateReason: 'COMPLETED',
    closedByPullRequestsReferences: [{ number: 57, url: 'https://github.com/acme/widgets/pull/57', repository: { name: 'widgets', owner: { login: 'acme' } } }],
  },
  { number: 39, title: 'Old theme request', url: 'https://github.com/acme/widgets/issues/39', closedAt: '2026-11-02T08:00:00Z', stateReason: 'NOT_PLANNED', closedByPullRequestsReferences: [] },
])
const EXPANDED = { [SETTINGS]: { watch: [], consent: {}, collapsed: {}, showClosed: { [SECTION]: true } } }

/** Answers the closed list with `answer` (CLOSED by default); `open` answers the open list when given. */
function closedWith(answer: () => Ran = () => ran(CLOSED), open?: () => Ran | undefined): (args: readonly string[]) => Ran | undefined {
  return args => {
    if (!isList(args)) return undefined

    return args.includes('closed') ? answer() : open?.()
  }
}

test('the recently closed part stays collapsed and costs nothing', async ($, on) => {
  const { argv } = project(on, { gh: closedWith() })
  const clock = await started($, on)
  await tick(clock)
  expect(closedLists(argv)).toHaveLength(0)

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ key: `closed-toggle:${SECTION}` }))?.text).toMatch(/Kürzlich geschlossen \(7 Tage\)/)
    expect((await ui.findAll({ type: 'Box' })).some(found => (found.key ?? '').startsWith('closed-row:'))).toBe(false)
    await ui.unmount()
  }
})

test('expanding fetches the last days once, with the reason and the closing pull request', async ($, on) => {
  const { argv, store } = project(on, { gh: closedWith() })
  await started($, on)

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    if ((await ui.find({ key: `closed-row:${SECTION}#40` })) === undefined) await ui.press({ key: `closed-toggle:${SECTION}` })
    expect(closedLists(argv)).toHaveLength(1)
    const call = closedLists(argv)[0] ?? []
    expect(pairs(call)).toContain('--limit 30')
    expect(pairs(call)).toContain('--search closed:>=2026-10-30 sort:updated-desc')
    expect(pairs(call)).toContain(`--json ${CLOSED_FIELDS}`)
    expect((await ui.find({ key: `closed-row:${SECTION}#40` }))?.text).toMatch(/#40.*Export crashes on symlinks/)
    expect((await ui.find({ key: `closed-row:${SECTION}#40` }))?.text).toMatch(/erledigt · 2d/)
    expect((await ui.find({ key: `closed-row:${SECTION}#39` }))?.text).toMatch(/nicht geplant/)
    expect((await ui.find({ key: `closed-row:${SECTION}#38` }))?.text).toMatch(/Duplikat/)
    expect((await ui.find({ type: 'Link', text: 'PR #57' }))?.props['href']).toBe('https://github.com/acme/widgets/pull/57')
    expect((await ui.find({ key: `closed-count:${SECTION}` }))?.text).toBe('3')
    await ui.unmount()
  }
  const stored = store.get(`closed:${SECTION}`) as ClosedCache
  expect(stored.rows.map(row => row.number)).toEqual([40, 39, 38])
  expect(JSON.stringify(stored)).not.toContain('body')
  expect((store.get(SETTINGS) as { showClosed: Record<string, boolean> }).showClosed[SECTION]).toBe(true)
})

test('an expanded list refreshes slowly: on the timer after 15 minutes, for ↻ after 30 s, never collapsed', async ($, on) => {
  const { argv } = project(on, { gh: closedWith() })
  const clock = await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `closed-toggle:${SECTION}` })
  expect(closedLists(argv)).toHaveLength(1)

  // The expand read at 1 s is 899 s old at the 900 s tick, so the 1,080 s tick reads it (E22-4).
  await tick(clock, 5)
  expect(closedLists(argv)).toHaveLength(1)
  await tick(clock)
  expect(closedLists(argv)).toHaveLength(2)
  await ui.press({ key: 'refresh' })
  await clock.advance(1_000)
  expect(closedLists(argv)).toHaveLength(2)
  await clock.advance(30_000)
  await ui.press({ key: 'refresh' })
  await clock.advance(1_000)
  expect(closedLists(argv)).toHaveLength(3)

  await ui.press({ key: `closed-toggle:${SECTION}` })
  await tick(clock, 10)
  expect(closedLists(argv)).toHaveLength(3)
  await ui.unmount()
})

test('an issue that leaves a complete open list reads the closed list again, younger than 15 minutes', async ($, on) => {
  let isGone = false
  const { argv } = project(on, { gh: closedWith(undefined, () => (isGone ? ran(listOf([42])) : undefined)) })
  const clock = await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `closed-toggle:${SECTION}` })
  expect(closedLists(argv)).toHaveLength(1)

  isGone = true
  await tick(clock)
  expect(await ui.find({ key: `row-title:${ROW_7}` })).toBeUndefined()
  expect(closedLists(argv)).toHaveLength(2)
  await tick(clock)
  expect(closedLists(argv)).toHaveLength(2)
  await ui.unmount()
})

test('a capped open list losing an issue says nothing about it closing (E22-2)', { options: { maxIssues: 2 } }, async ($, on) => {
  let isMoved = false
  const { argv } = project(on, { stored: EXPANDED, gh: closedWith(undefined, () => (isMoved ? ran(listOf([42, 99], { 99: { number: 99, url: 'https://github.com/acme/widgets/issues/99', updatedAt: CHANGED } })) : undefined)) })
  const clock = await started($, on)
  expect(closedLists(argv)).toHaveLength(1)
  // The timer's list loses #7 for a newer #99: no nudge, so the 3-minute-old closed list waits for its 15 minutes.
  isMoved = true
  await tick(clock)
  expect(openLists(argv).at(-1)).toBeDefined()
  expect(closedLists(argv)).toHaveLength(1)
})

test('a failed fetch keeps the last list under its state', async ($, on) => {
  let calls = 0
  const { argv } = project(on, {
    gh: closedWith(() => {
      calls += 1

      return calls === 1 ? ran(CLOSED) : ran('', 1, 'dial tcp: lookup api.github.com: no such host')
    }),
  })
  const clock = await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `closed-toggle:${SECTION}` })
  await clock.advance(31_000)
  await ui.press({ key: 'refresh' })
  await clock.advance(1_000)
  expect(closedLists(argv)).toHaveLength(2)
  expect(await ui.find({ type: 'Text', text: DE.offline })).toBeDefined()
  expect(await ui.find({ key: `closed-row:${SECTION}#40` })).toBeDefined()
  // No network: the next two minutes ask nothing.
  await clock.advance(31_000)
  await ui.press({ key: 'refresh' })
  await clock.advance(1_000)
  expect(closedLists(argv)).toHaveLength(2)
  await ui.unmount()
})

const SCHEMA_ERROR = "GraphQL: Field 'stateReason' doesn't exist on type 'Issue'"

test('a closed list that keeps failing waits as long between tries as a read one does (B2-BEH-2, E3-2)', async ($, on) => {
  const { argv } = project(on, { stored: EXPANDED, gh: closedWith(() => ran('', 1, SCHEMA_ERROR)) })
  const clock = await started($, on)
  expect(closedLists(argv)).toHaveLength(1)

  // Thirty minutes of ticks: tried at 0.6 s and once 15 minutes later (the 1,080 s tick), not on every tick.
  await tick(clock, 10)
  expect(closedLists(argv)).toHaveLength(2)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: DE.error(SCHEMA_ERROR) })).toBeDefined()
  // ↻ asks once the last try is 30 s old, and not again right after.
  await ui.press({ key: 'refresh' })
  await clock.advance(1_000)
  expect(closedLists(argv)).toHaveLength(3)
  await clock.advance(10_000)
  await ui.press({ key: 'refresh' })
  await clock.advance(1_000)
  expect(closedLists(argv)).toHaveLength(3)
  await ui.unmount()
})

for (const closedDays of [0, -1]) {
  test(`closedDays ${closedDays} hides the part and fetches nothing`, { options: { closedDays } }, async ($, on) => {
    const { argv } = project(on, { stored: EXPANDED, gh: closedWith() })
    const clock = await started($, on)
    await tick(clock)
    expect(closedLists(argv)).toHaveLength(0)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ key: `closed-toggle:${SECTION}` })).toBeUndefined()
    await ui.unmount()
  })
}

test('closedDays past 90 reaches back 90 days (B2-BEH-6)', { options: { closedDays: 200 } }, async ($, on) => {
  const { argv } = project(on, { stored: EXPANDED, gh: closedWith() })
  await started($, on)
  expect(pairs(closedLists(argv)[0] ?? [])).toContain('--search closed:>=2026-08-08 sort:updated-desc')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: `closed-toggle:${SECTION}` }))?.text).toMatch(/Kürzlich geschlossen \(90 Tage\)/)
  await ui.unmount()
})

test('a collapsed section, or a hidden pane, reads no closed list (E22-2, D X-1)', async ($, on) => {
  const { argv, setShown } = project(on, { stored: { [SETTINGS]: { watch: [], consent: {}, collapsed: { [SECTION]: true }, showClosed: { [SECTION]: true } } }, gh: closedWith() })
  const clock = await started($, on)
  await tick(clock, 6)
  expect(closedLists(argv)).toHaveLength(0)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `section:${SECTION}` })
  setShown(false)
  await $.tool.call({ tool: 'Bash', command: 'gh issue close 7' })
  await clock.advance(5_000)
  expect(closedLists(argv)).toHaveLength(0)
  setShown(true)
  await tick(clock)
  expect(closedLists(argv)).toHaveLength(1)
  await ui.unmount()
})

test('Work on it finding an issue closed meanwhile reads the closed list again at the next refresh', async ($, on) => {
  let isClosed = false
  const { argv } = project(on, { gh: args => (args[0] === 'issue' && args[1] === 'view' && args[2] === '7' && isClosed ? ran(issueView(7, 'CLOSED')) : closedWith()(args)) })
  const clock = await started($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `closed-toggle:${SECTION}` })
  expect(closedLists(argv)).toHaveLength(1)

  isClosed = true
  await ui.press({ key: `work:${ROW_7}` })
  expect(await ui.find({ key: `row-title:${ROW_7}` })).toBeUndefined()
  // The timer alone would wait 15 minutes; the issue that closed brings the list forward.
  await tick(clock)
  expect(closedLists(argv)).toHaveLength(2)
  await ui.unmount()
})

test('a closed list another pane read a moment ago is drawn, not read again', async ($, on) => {
  const stored = closedRecord(parseClosed(CLOSED) ?? [], '2026-10-30', NOW - 60_000)
  const { argv } = project(on, { stored: { ...EXPANDED, [`closed:${SECTION}`]: stored }, gh: closedWith() })
  await started($, on)
  expect(closedLists(argv)).toHaveLength(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: `closed-row:${SECTION}#40` })).toBeDefined()
  expect((await ui.find({ key: `closed-count:${SECTION}` }))?.text).toBe('3')
  await ui.unmount()
})

test("a pane behind another draws the store's closed list and inbox without a fetch (B2-BEH-4)", ME, async ($, on) => {
  const inboxRecord: InboxCache = { v: 1, fetchedAt: NOW - 60_000, triedAt: NOW - 60_000, rows: [{ host: 'github.com', repo: 'other/thing', number: 3, title: 'Crash on start', url: 'https://github.com/other/thing/issues/3', createdAt: '', updatedAt: '2026-11-05T09:00:00Z', commentCount: 0, labels: [] }] }
  const closedRecordStored = closedRecord(parseClosed(CLOSED) ?? [], '2026-10-30', NOW - 60_000)
  const { argv } = project(on, { isShown: false, stored: { ...EXPANDED, 'inbox:github.com': inboxRecord, [`closed:${SECTION}`]: closedRecordStored }, gh: (args: readonly string[]) => searchWith()(args) ?? closedWith()(args) })
  await started($, on)
  expect(searches(argv)).toBe(0)
  expect(closedLists(argv)).toHaveLength(0)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'count:inbox' }))?.text).toBe('1')
  expect(await ui.find({ key: `closed-row:${SECTION}#40` })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: DE.closedLoading })).toBeUndefined()
  await ui.unmount()
})

test('an expanded part with no list yet says one is coming, and the first shown refresh reads it (B2-BEH-4)', async ($, on) => {
  const { argv, setShown } = project(on, { isShown: false, stored: EXPANDED, gh: closedWith() })
  const clock = await started($, on)
  expect(closedLists(argv)).toHaveLength(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: DE.closedLoading })).toBeDefined()

  setShown(true)
  await tick(clock)
  expect(closedLists(argv)).toHaveLength(1)
  expect(await ui.find({ key: `closed-row:${SECTION}#40` })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: DE.closedLoading })).toBeUndefined()
  await ui.unmount()
})

test("an expand pressed while a refresh's closed step waits on the store starts no second list (B2-BEH-3, R2-RT-2)", async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { argv } = project(on, { stored: EXPANDED, storeDelay: key => (key === `closed:${SECTION}` ? clock.sleep(2_000) : undefined), gh: closedWith() })
  await $.session.start({ cwd: 'D:\\proj', surface: 'desktop', isInteractive: true })
  await clock.advance(1_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // The start refresh is reading the stored closed list; the owner collapses and expands the part meanwhile.
  await ui.press({ key: `closed-toggle:${SECTION}` })
  await ui.press({ key: `closed-toggle:${SECTION}` })
  await clock.advance(5_000)
  expect(closedLists(argv)).toHaveLength(1)
  expect(await ui.find({ key: `closed-row:${SECTION}#40` })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: DE.closedLoading })).toBeUndefined()
  await ui.unmount()
})

test('a closed list on its way shows its loading line, and a refresh meanwhile starts no second one (E22-1)', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { argv } = project(on, {
    gh: async args => {
      if (!isList(args) || !args.includes('closed')) return undefined
      await clock.sleep(5_000)

      return ran(CLOSED)
    },
  })
  await $.session.start({ cwd: 'D:\\proj', surface: 'desktop', isInteractive: true })
  await clock.advance(1_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `closed-toggle:${SECTION}` })
  expect(await ui.find({ type: 'Text', text: DE.closedLoading })).toBeDefined()

  await ui.press({ key: 'refresh' })
  await clock.advance(1_000)
  expect(closedLists(argv)).toHaveLength(1)
  await clock.advance(5_000)
  expect(await ui.find({ type: 'Text', text: DE.closedLoading })).toBeUndefined()
  expect(await ui.find({ key: `closed-row:${SECTION}#40` })).toBeDefined()
  expect(closedLists(argv)).toHaveLength(1)
  await ui.unmount()
})

test('the pure closed list: parsing, the window, when it is due, the count', () => {
  const rows = parseClosed(CLOSED) ?? []
  expect(rows.map(row => row.number)).toEqual([40, 39, 38])
  expect(rows[0]?.prs).toEqual([{ number: 57, url: 'https://github.com/acme/widgets/pull/57', repo: 'acme/widgets' }])
  expect(parseClosed(JSON.stringify([{ number: 1, title: 't', url: '', closedAt: '2026-01-01T00:00:00Z' }]))?.[0]?.stateReason).toBe('')
  expect(parseClosed('{}')).toBeNull()
  expect(sinceDate(Date.parse('2026-11-06T12:00:00Z'), 7)).toBe('2026-10-30')
  expect(sinceDate(Date.parse('2026-11-06T00:30:00Z'), 1)).toBe('2026-11-05')

  const at = 1_000_000
  const cache = closedRecord(rows, '2026-10-30', at)
  expect(isClosedDue(undefined, '2026-10-30', 'timer', at, false)).toBe(true)
  expect(isClosedDue(cache, '2026-10-31', 'timer', at + 1, false)).toBe(true)
  expect(isClosedDue(cache, '2026-10-30', 'timer', at + 899_999, false)).toBe(false)
  expect(isClosedDue(cache, '2026-10-30', 'start', at + 900_000, false)).toBe(true)
  expect(isClosedDue(cache, '2026-10-30', 'expand', at + 599_999, false)).toBe(false)
  expect(isClosedDue(cache, '2026-10-30', 'expand', at + 600_000, false)).toBe(true)
  expect(isClosedDue(cache, '2026-10-30', 'press', at + 29_999, false)).toBe(false)
  expect(isClosedDue(cache, '2026-10-30', 'tool', at + 30_000, false)).toBe(true)
  expect(isClosedDue(cache, '2026-10-30', 'timer', at + 29_999, true)).toBe(false)
  expect(isClosedDue(cache, '2026-10-30', 'timer', at + 30_000, true)).toBe(true)
  // B2-BEH-2 (E3-2): a try that failed counts as a read for when the next one is due, with or without a list.
  expect(isClosedDue(undefined, '2026-10-30', 'timer', at + 899_999, false, at)).toBe(false)
  expect(isClosedDue(undefined, '2026-10-30', 'start', at + 900_000, false, at)).toBe(true)
  expect(isClosedDue(undefined, '2026-10-30', 'press', at + 29_999, false, at)).toBe(false)
  expect(isClosedDue(undefined, '2026-10-30', 'expand', at + 599_999, false, at)).toBe(false)
  expect(isClosedDue(cache, '2026-10-30', 'timer', at + 900_000, false, at + 600_000)).toBe(false)
  expect(isClosedDue(cache, '2026-10-30', 'timer', at + 1_500_000, false, at + 600_000)).toBe(true)
  expect(isClosedDue(cache, '2026-10-31', 'timer', at + 1, false)).toBe(true)

  const many = closedRecord(
    Array.from({ length: 14 }, (_, index) => ({ number: index + 1, title: '', url: '', closedAt: '', stateReason: '', prs: [] })),
    '2026-10-30',
    at,
  )
  expect(many.rows).toHaveLength(10)
  expect(closedCountLabel(many)).toBe('10+')
  expect(closedCountLabel(cache)).toBe('3')
  expect(asClosedCache({ v: 1, fetchedAt: 1, since: '2026-10-30', rows: [{ number: 2, prs: [{ number: 0 }] }], count: 1 })).toEqual({ v: 1, fetchedAt: 1, since: '2026-10-30', rows: [{ number: 2, title: '', url: '', closedAt: '', stateReason: '', prs: [] }], count: 1 })
  expect(asClosedCache({ v: 1, fetchedAt: 1, rows: [] })).toBeUndefined()
})

test('a reset clears the lists\' keys too', ME, async ($, on) => {
  const { store } = project(on, { stored: EXPANDED, gh: (args: readonly string[]) => searchWith()(args) ?? closedWith()(args) })
  await started($, on)
  expect(store.has('inbox:github.com')).toBe(true)
  expect(store.has(`closed:${SECTION}`)).toBe(true)
  const result = await $.command.run({ command: 'issue-radar', args: 'reset', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(result.text).toBe(DE.storeCleared)
  expect(store.has('inbox:github.com')).toBe(false)
  expect(store.has(`closed:${SECTION}`)).toBe(false)
})
