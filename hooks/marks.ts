// E5, new since the last visit: what the owner has seen of each repository, the
// marks a row carries against it, and which rows a look covers. Also the one
// rule for which rows a drawing holds (the row budget), so the pane, a look and
// E4's cards always agree on it, and a rough estimate of where each row sits in
// the pane's window. Pure: no `$`.
import type { Boards, ClosedCache, Filter, Glimpse, IssueDetails, IssueRow, Mapping, Mark, Options, Recap, RepoSettings, SeenRecord, Section } from '../types'
import { matchesBoard } from './boards'
import { CLOSED_SHOWN } from './closed'
import { groupRows, isDefaultFilter } from './filter'
import type { Strings } from './i18n'

/** The most rows one drawing holds; the engine refuses a tree of more than 20,000 elements. */
export const ROW_BUDGET = 200
/** How long a mark stays after a look first saw it at its update time. */
export const MARK_HOLD_MS = 10 * 60_000
/** The shortest gap between two writes of a repository's seen record by this session's looks. */
export const LOOK_THROTTLE_MS = 15_000
/** A seen record keeps this many times the issue cap per repository, the most recently updated (E5-3). */
export const SEEN_KEEP_FACTOR = 2
/** How long the arrival toast stays. */
export const ARRIVAL_TOAST_MS = 6_000
/** An arrival toast cuts a single issue's title to this many characters. */
const ARRIVAL_TITLE = 60
/** An arrival toast names at most this many issues. */
const ARRIVALS_NAMED = 5

export function rowKeyOf(sectionKey: string, number: number): string {
  return `${sectionKey}#${number}`
}

// The rows a drawing holds ---------------------------------------------------

export type DrawnInput = {
  sections: readonly Section[]
  settings: RepoSettings
  filter: Filter
  /** The key of the list the current filter asks; undefined for the default list (E14). */
  filterKey: string | undefined
  boards: Boards
  closed: Readonly<Record<string, ClosedCache>>
  closedDays: number
}

export type DrawnGroup = { id: string; rows: IssueRow[]; count: number }

export type DrawnSection = {
  section: Section
  /** Listed for another filter than the current one: drawn as loading until its own list comes (E14-5). */
  isStale: boolean
  isCollapsed: boolean
  /** The rows it would show, in its order: the listed ones the board facet keeps (E18), collapsed or not. */
  shown: IssueRow[]
  /** Its groups as drawn (E14): each group's drawn rows and how many it holds; one group without grouping. */
  groups: DrawnGroup[]
  /** The rows drawn, in drawing order. */
  rows: IssueRow[]
  /** Shown rows past the budget. */
  rest: number
  /** How many rows its expanded "recently closed" part draws (E22's rows count against the budget too, E5-6). */
  closed: number
}

export type DrawnPlan = { sections: DrawnSection[]; left: number }

/**
 * What a drawing holds, section by section: the rows the pane draws and in which order, within the row budget that
 * the closed parts (E22) and the assigned section (E11, `left` after the sections) share. The pane draws from it, and
 * a look (E5) and the hover cards (E4) read it, so they all agree.
 */
export function drawnRowsOf(input: DrawnInput): DrawnPlan {
  const { settings, filter } = input
  const facet = settings.boards === true ? filter.board : ''
  let left = ROW_BUDGET
  const sections: DrawnSection[] = []
  for (const section of input.sections) {
    const isStale = section.info !== null && section.state.kind === 'ok' && section.filterKey !== input.filterKey
    const listed = isStale ? [] : section.rows
    const shown = facet === '' ? [...listed] : listed.filter(row => matchesBoard(input.boards.items[rowKeyOf(section.key, row.number)], facet))
    const isCollapsed = settings.collapsed[section.key] === true
    if (isCollapsed) {
      sections.push({ section, isStale, isCollapsed, shown, groups: [], rows: [], rest: 0, closed: 0 })
      continue
    }
    const groups: DrawnGroup[] = []
    const rows: IssueRow[] = []
    for (const group of groupRows(shown, filter.group)) {
      const drawn = group.rows.slice(0, Math.max(0, left))
      left -= drawn.length
      rows.push(...drawn)
      groups.push({ id: group.id, rows: drawn, count: group.rows.length })
    }
    const cache = input.closed[section.key]
    const hasClosed = input.closedDays > 0 && section.info !== null && section.state.kind === 'ok' && settings.showClosed?.[section.key] === true
    const closed = hasClosed ? Math.min(cache?.rows.length ?? 0, CLOSED_SHOWN, Math.max(0, left)) : 0
    left -= closed
    sections.push({ section, isStale, isCollapsed, shown, groups, rows, rest: shown.length - rows.length, closed })
  }

  return { sections, left: Math.max(0, left) }
}

// Where the rows sit -----------------------------------------------------------

/**
 * What the estimate of the pane's layout reads. The engine says nothing of where a row is drawn or what is in view
 * (only a pane's window: its first row and how many it shows), so the pane's height is guessed from what it draws.
 */
export type LayoutInput = {
  /** Cells across the pane's body. */
  columns: number
  /** Rows drawn above the first section beyond the title bar: the filter line and any open panel (headRows). */
  head: number
  opened: string
  recaps: Readonly<Record<string, Recap>>
  details: Readonly<Record<string, IssueDetails>>
  mappings: Readonly<Record<string, Mapping>>
  /** E1: rows without a mapping draw a line naming their last earlier attempt. */
  attempts?: Readonly<Record<string, readonly unknown[]>>
  /** E22-b: per section, how many of its drawn closed rows draw their session's line (a third line, R5-INT-3). */
  closedSessions?: Readonly<Record<string, number>>
  /** Sections that draw the consent block above their rows. */
  asking: ReadonlySet<string>
  /** E20: the row whose start form is open beneath its actions line (it draws taller). */
  form?: string
  /** Batch 7: the row whose inline editor, confirmation card or outcome line is drawn beneath its actions line. */
  write?: string
}

export type RowTop = { key: string; sectionKey: string; row: IssueRow; top: number }

/** E20: how many rows the start form adds beneath its row's actions line, about (its fields, captions and buttons). */
export const FORM_ROWS = 14
/** Batch 7: how many rows a row's editor or confirmation card adds beneath its actions line, about. */
export const WRITE_ROWS = 10
/** E16: how many rows the new issue's form adds above the sections, about (closed: none). */
export const DRAFT_ROWS = 16
/** F-STATE-1: how many rows the line about a store that refuses writes takes above the sections, about (wrapped). */
export const STORE_FULL_ROWS = 3

/**
 * Rows above the sections beyond the title bar: the filter line, the filter panel, the settings panel (with E20's
 * guidance, E8's and E13's switches), and E13's question whether to file issue sessions in the sidebar.
 */
export function headRows(hasFilterLine: boolean, isFilterOpen: boolean, isSettingsOpen: boolean, isSidebarAsking = false, isDraftOpen = false): number {
  return (hasFilterLine ? 1 : 0) + (isFilterOpen ? 9 : 0) + (isSettingsOpen ? 24 : 0) + (isSidebarAsking ? 6 : 0) + (isDraftOpen ? DRAFT_ROWS : 0)
}

/** How many lines `chars` characters take at `width`. */
function lines(chars: number, width: number): number {
  return Math.max(1, Math.ceil(chars / width))
}

/**
 * The estimated first line of each drawn row, in the pane's rows: the title bar, then per section its header (and a
 * state line or the consent block), then each row's title (wrapped), chips, recap or excerpt (wrapped), session line,
 * status strip and actions, an opened row much taller. A guess on the tall side, so a look counts fewer rows as seen.
 */
export function rowTops(plan: DrawnPlan, layout: LayoutInput): RowTop[] {
  const width = Math.max(16, layout.columns - 6)
  const tops: RowTop[] = []
  let top = 2 + layout.head
  for (const drawn of plan.sections) {
    const { section } = drawn
    top += 2 + (layout.asking.has(section.key) ? 6 : 0) + (section.state.kind === 'ok' ? 0 : 2)
    if (drawn.isCollapsed) continue
    for (const group of drawn.groups) {
      if (group.id !== '') top += 1
      for (const row of group.rows) {
        const key = rowKeyOf(section.key, row.number)
        tops.push({ key, sectionKey: section.key, row, top })
        const recap = layout.recaps[key]
        const text = recap !== undefined && recap.error === undefined ? recap.text.length : (layout.details[key]?.excerpt.length ?? 40)
        const hasSessionLine = layout.mappings[key] !== undefined || (layout.attempts?.[key]?.length ?? 0) > 0
        const hasForm = layout.form === key && layout.mappings[key] === undefined
        const extra = (hasSessionLine ? 1 : 0) + (layout.opened === key ? 16 : 0) + (hasForm ? FORM_ROWS : 0) + (layout.write === key ? WRITE_ROWS : 0)
        top += 3 + lines(row.title.length + 6, width) + lines(text, width) + extra
      }
    }
    top += drawn.rest > 0 ? 1 : 0
    top += 1 + (drawn.closed > 0 ? 1 + 2 * drawn.closed + Math.min(drawn.closed, layout.closedSessions?.[section.key] ?? 0) : 0)
  }

  return tops
}

/** The rows whose first line falls inside the window `[offset - before, offset + bodyRows + after)`. */
export function rowsInView(tops: readonly RowTop[], offset: number, bodyRows: number, before = 0, after = 0): RowTop[] {
  return tops.filter(found => found.top >= offset - before && found.top < offset + bodyRows + after)
}

/** E4: at most this many rows carry a hover card, those nearest the pane's window (E4-4: hidden text counts too). */
export const CARD_ROWS = 24

/**
 * E4: the rows that carry a hover card: those whose title lies within a window's height above or below the pane's
 * window, at most CARD_ROWS, never the first row drawn (with only the title bar above it, its card would be clipped
 * away; below it, the row's own lines would paint over it, E4-3).
 */
export function cardRowsOf(tops: readonly RowTop[], offset: number, bodyRows: number): RowTop[] {
  const first = tops[0]?.key

  return rowsInView(tops, offset, bodyRows, bodyRows, bodyRows)
    .filter(found => found.key !== first)
    .slice(0, CARD_ROWS)
}

/** What a pane's drawing and the estimate of its layout read: the view's state has every field, register reads the atoms. */
export type PaneLike = Omit<DrawnInput, 'closedDays'> & {
  options: Pick<Options, 'closedDays' | 'recaps'>
  opened: string
  recaps: Readonly<Record<string, Recap>>
  details: Readonly<Record<string, IssueDetails>>
  mappings: Readonly<Record<string, Mapping>>
  /** E1: the earlier attempts per row (their line counts in the layout). */
  attempts?: Readonly<Record<string, readonly unknown[]>>
  /** E22-b: the closed issues' sessions per row (a drawn closed row with one draws a third line). */
  done?: Readonly<Record<string, unknown>>
  /** E20: the start form, open under one row. */
  startForm?: { rowKey: string } | null
  /** E13: whether the question to file issue sessions in the sidebar is drawn above the sections. */
  isSidebarAsking?: boolean
  /** E16: whether the new issue's form is drawn above the sections. */
  isDraftOpen?: boolean
  /** F-STATE-1: whether the line about a store that refuses writes is drawn above the sections. */
  storeRefused?: boolean
  /** Batch 7: the row whose editor, confirmation card or outcome line is drawn beneath it. */
  writeAt?: string
  isFilterOpen: boolean
  isSettingsOpen: boolean
  columns: number
}

/** The rows a pane draws and where each sits, from what the pane draws (the same rule for the pane, a look and the cards). */
export function paneLayout(pane: PaneLike): { plan: DrawnPlan; tops: RowTop[] } {
  const plan = drawnRowsOf({ ...pane, closedDays: pane.options.closedDays })
  const facet = pane.settings.boards === true ? pane.filter.board : ''
  const asking = new Set(pane.sections.filter(section => pane.options.recaps && section.info !== null && section.state.kind === 'ok' && pane.settings.consent[section.key] === undefined).map(section => section.key))
  const head = headRows(!isDefaultFilter({ ...pane.filter, board: facet }), pane.isFilterOpen, pane.isSettingsOpen, pane.isSidebarAsking === true, pane.isDraftOpen === true) + (pane.storeRefused === true ? STORE_FULL_ROWS : 0)
  // E22-b (R5-INT-3): the drawn closed rows (the first of each expanded part, as the pane draws them) that keep a session.
  const done = pane.done ?? {}
  const closedSessions = Object.fromEntries(
    plan.sections.map(drawn => [drawn.section.key, (pane.closed[drawn.section.key]?.rows ?? []).slice(0, drawn.closed).filter(row => done[rowKeyOf(drawn.section.key, row.number)] !== undefined).length]),
  )
  const tops = rowTops(plan, { columns: pane.columns, head, opened: pane.opened, recaps: pane.recaps, details: pane.details, mappings: pane.mappings, ...(pane.attempts === undefined ? {} : { attempts: pane.attempts }), closedSessions, asking, ...(pane.startForm === null || pane.startForm === undefined ? {} : { form: pane.startForm.rowKey }), ...(pane.writeAt === undefined ? {} : { write: pane.writeAt }) })

  return { plan, tops }
}

// Seen records and marks --------------------------------------------------------

/** A stored seen record as the mod can use it, every field checked; null when it is none (a first run). */
export function readSeen(stored: unknown): SeenRecord | null {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return null
  const value = stored as Record<string, unknown>
  if (value['v'] !== 1 || typeof value['at'] !== 'number' || typeof value['newest'] !== 'string') return null
  const given = value['rows']
  if (typeof given !== 'object' || given === null || Array.isArray(given)) return null
  const rows = Object.fromEntries(Object.entries(given as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  const record: SeenRecord = { v: 1, at: value['at'], newest: value['newest'], rows }
  const flags = value['reopened']
  if (typeof flags === 'object' && flags !== null && !Array.isArray(flags)) {
    const reopened = Object.fromEntries(Object.entries(flags as Record<string, unknown>).filter(([number, flag]) => flag === true && rows[number] !== undefined).map(([number]) => [number, true as const]))
    if (Object.keys(reopened).length > 0) record.reopened = reopened
  }

  return record
}

/**
 * `record` bounded to `keep` issues (E5-3: by size, not by the capped list, whose churn would drop what is seen): every
 * issue in `held` stays, whatever its update time (B3-BEH-1: issues that closed since, seen at newer updates, must never
 * push out an unchanged open one the list still shows), and the most recently updated others fill what is left.
 */
function bounded(rows: Record<string, string>, reopened: Record<string, true>, keep: number, held: ReadonlySet<string>): Pick<SeenRecord, 'rows' | 'reopened'> {
  const entries = Object.entries(rows)
  const pinned = entries.filter(([key]) => held.has(key))
  const others = entries
    .filter(([key]) => !held.has(key))
    .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0))
    .slice(0, Math.max(0, Math.max(1, keep) - pinned.length))
  const kept = new Map([...pinned, ...others])
  const flags = Object.fromEntries(Object.keys(reopened).filter(number => kept.has(number)).map(number => [number, true as const]))

  return Object.keys(flags).length > 0 ? { rows: Object.fromEntries(kept), reopened: flags } : { rows: Object.fromEntries(kept) }
}

/**
 * A repository's seen record after a look covered `covered` of its `listed` rows (the default list's: a filtered view
 * passes the repository's stored default list): each covered row at the newest update time seen of it (ISO times
 * compare as text), the reopened ones noted, `newest` advanced to the covered rows' newest creation, but never past an
 * issue the list holds that is newer than the last visit and was not covered (it stays new for the next visit), bounded
 * to `keep` issues by update time, the listed and covered ones always kept (B3-BEH-1). A look in a filtered list
 * (`isFiltered`) leaves `newest` as it was: its rows say nothing of the issues between them (R3-INT-1). With no previous
 * record (a first run) every listed row counts as covered.
 */
export function seenRecordOf(covered: readonly IssueRow[], listed: readonly IssueRow[], previous: SeenRecord | null, now: number, keep: number, isFiltered = false): SeenRecord {
  const rows: Record<string, string> = { ...(previous?.rows ?? {}) }
  const reopened: Record<string, true> = { ...(previous?.reopened ?? {}) }
  const seen = previous === null ? listed : covered
  for (const row of seen) {
    const key = String(row.number)
    const had = rows[key]
    if (had === undefined || row.updatedAt > had) rows[key] = row.updatedAt
    if (row.stateReason === 'REOPENED') reopened[key] = true
  }
  const base = previous?.newest ?? ''
  const unseen = listed.filter(row => rows[String(row.number)] === undefined && row.createdAt > base).map(row => row.createdAt)
  const ceiling = unseen.length === 0 ? null : unseen.reduce((low, time) => (time < low ? time : low))
  let newest = base
  if (!isFiltered || previous === null) for (const row of seen) if (row.createdAt > newest && (ceiling === null || row.createdAt < ceiling)) newest = row.createdAt
  const held = new Set([...listed, ...seen].map(row => String(row.number)))

  return { v: 1, at: now, newest, ...bounded(rows, reopened, keep, held) }
}

/** `record` with one row acknowledged (opened, worked on, taken here): `newest` stays, so an unseen older issue stays new. */
export function withRow(record: SeenRecord, row: IssueRow, now: number): SeenRecord {
  const key = String(row.number)
  const had = record.rows[key]
  const rows = had === undefined || row.updatedAt > had ? { ...record.rows, [key]: row.updatedAt } : record.rows
  const reopened = row.stateReason === 'REOPENED' ? { ...(record.reopened ?? {}), [key]: true as const } : record.reopened

  return { ...record, at: now, rows, ...(reopened === undefined ? {} : { reopened }) }
}

/**
 * Why a row is marked against the session's baseline, or null. `new`: the owner never saw it and it was created after
 * the newest they saw. `reopened`: changed since, GitHub calls it reopened, and the owner never saw it reopened (the
 * reason stays on the issue for as long as it is open, so a later change of an issue seen reopened is `updated`, E5-2).
 * `updated`: any other change since, or an older issue the record does not hold (one that came back into the capped
 * default list). No baseline: no marks (a first run). In a filtered list (`isFiltered`, E14) an older issue the record
 * does not hold is unmarked: such a list is no capped window of the open issues, and the record keeps only the most
 * recently updated ones, so it brings old, untouched issues the owner may well have seen (B3-BEH-2, R3-INT-1).
 */
export function markOf(row: IssueRow, base: SeenRecord | undefined, isFiltered = false): Mark | null {
  if (base === undefined) return null
  const key = String(row.number)
  const seen = base.rows[key]
  if (seen !== undefined && row.updatedAt <= seen) return null
  if (seen === undefined && row.createdAt > base.newest) return 'new'
  if (seen === undefined && isFiltered) return null
  if (row.stateReason === 'REOPENED' && base.reopened?.[key] !== true) return 'reopened'

  return 'updated'
}

/** Whether a section is a filtered list (E14), whose rows `markOf` reads as such. */
export function isFilteredList(section: Pick<Section, 'query'>): boolean {
  return section.query !== undefined
}

/** The mark a row shows: none once a look saw it at this update time ten minutes ago or longer. */
export function visibleMark(row: IssueRow, base: SeenRecord | undefined, glimpse: Glimpse | undefined, now: number, isFiltered = false): Mark | null {
  const mark = markOf(row, base, isFiltered)
  if (mark === null) return null

  return glimpse !== undefined && glimpse.updatedAt === row.updatedAt && now - glimpse.at >= MARK_HOLD_MS ? null : mark
}

/** How many rows show a mark, collapsed sections included; a section listed for another filter counts none. */
export function unreadCount(plan: DrawnPlan, base: Readonly<Record<string, SeenRecord>>, glimpsed: Readonly<Record<string, Glimpse>>, now: number): number {
  let count = 0
  for (const drawn of plan.sections) {
    const isFiltered = isFilteredList(drawn.section)
    for (const row of drawn.shown) if (visibleMark(row, base[drawn.section.key], glimpsed[rowKeyOf(drawn.section.key, row.number)], now, isFiltered) !== null) count += 1
  }

  return count
}

/**
 * The glimpses whose hold has passed, taken into the session's baselines (R3-INT-3): each such row counts as seen at
 * the update the look saw (`newest` unchanged, as an acknowledgement leaves it), so its mark stays gone when the row
 * leaves the list and comes back (a filter, a capped list's churn); the glimpses still held are kept, listed or not.
 * Null when no glimpse has faded.
 */
export function foldFaded(base: Readonly<Record<string, SeenRecord>>, glimpsed: Readonly<Record<string, Glimpse>>, now: number): { base: Record<string, SeenRecord>; glimpsed: Record<string, Glimpse> } | null {
  const faded = Object.entries(glimpsed).filter(([, glimpse]) => now - glimpse.at >= MARK_HOLD_MS)
  if (faded.length === 0) return null
  const next: Record<string, SeenRecord> = { ...base }
  for (const [rowKey, glimpse] of faded) {
    const hash = rowKey.lastIndexOf('#')
    const sectionKey = rowKey.slice(0, hash)
    const number = rowKey.slice(hash + 1)
    const record = next[sectionKey]
    if (record === undefined) continue
    const had = record.rows[number]
    const rows = had === undefined || glimpse.updatedAt > had ? { ...record.rows, [number]: glimpse.updatedAt } : record.rows
    const reopened = glimpse.reopened === true ? { ...(record.reopened ?? {}), [number]: true as const } : record.reopened
    next[sectionKey] = { ...record, rows, ...(reopened === undefined ? {} : { reopened }) }
  }
  const kept = Object.fromEntries(Object.entries(glimpsed).filter(([, glimpse]) => now - glimpse.at < MARK_HOLD_MS))

  return { base: next, glimpsed: kept }
}

/**
 * The rows of a section that arrived: never listed by this session before, and created after the newest issue the
 * owner had seen (E5-3: no floor from the previous list, so an issue the search index brings late still counts). None
 * on the session's first list of the repository, or without a baseline.
 */
export function arrivalsOf(rows: readonly IssueRow[], base: SeenRecord | undefined, listed: Readonly<Record<string, true>> | undefined): IssueRow[] {
  if (base === undefined || listed === undefined) return []

  return rows.filter(row => listed[String(row.number)] !== true && row.createdAt > base.newest)
}

/** How an arrival names its issue: `#57` in the checkout's repository, `owner/name#57` in a watched one. */
export function arrivalRef(section: Pick<Section, 'isCheckout' | 'info'>, number: number): string {
  return section.isCheckout || section.info === null ? `#${number}` : `${section.info.owner}/${section.info.name}#${number}`
}

/** The arrival toast: one issue by its title (cut to 60), several by their references (at most five, then `…`). */
export function arrivalText(arrivals: ReadonlyArray<{ section: Pick<Section, 'isCheckout' | 'info'>; row: IssueRow }>, S: Pick<Strings, 'arrivedOne' | 'arrivedMany'>): string {
  const refs = arrivals.map(found => arrivalRef(found.section, found.row.number))
  const only = arrivals[0]
  if (arrivals.length === 1 && only !== undefined) {
    const title = only.row.title.replace(/\s+/g, ' ').trim()

    return S.arrivedOne(refs[0] ?? '', title.length > ARRIVAL_TITLE ? `${title.slice(0, ARRIVAL_TITLE - 1)}…` : title)
  }

  return S.arrivedMany(arrivals.length, `${refs.slice(0, ARRIVALS_NAMED).join(', ')}${refs.length > ARRIVALS_NAMED ? ', …' : ''}`)
}

/** When the next mark fades: the earliest glimpse's end of hold still ahead of `now`; null when none is. */
export function nextFade(glimpsed: Readonly<Record<string, Glimpse>>, now: number): number | null {
  let due: number | null = null
  for (const glimpse of Object.values(glimpsed)) {
    const end = glimpse.at + MARK_HOLD_MS
    if (end > now && (due === null || end < due)) due = end
  }

  return due
}
