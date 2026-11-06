// The pane's drawing: the title bar, one section per repository with its rows
// or its state, the consent row, the settings panel and the footer. The
// desktop gets tints, pills and an icon; the terminal the same layout in plain
// text. Nothing here writes state: every press goes to an action. Every string
// that came from GitHub, a model or the owner's settings goes through `clean`
// before it is drawn, as the last step: one control character or image-cell
// mark would get the whole tree refused.
import type { Elements, RenderElement, RenderSurface, Space } from 'claude-code'

import type { Boards, ClosedCache, ClosedRow, Facets, Filter, FilterGroup, FilterSort, Glimpse, Inbox, InboxRow, IssueDetails, IssueRef, IssueRow, Mapping, Mark, Options, PrRecord, Reactions, Recap, RepoSettings, RepoState, SeenRecord, Section, SessionPr, StartRoute, Triage } from '../types'
import { BOARD_STATUS_CHARS, boardItemFor, boardOptions } from './boards'
import { CLOSED_LOADING_MS, closedCountLabel, sinceDate } from './closed'
import { ANY, GROUPS, SORTS, VIEWS, cutText, isBuiltInView, isDefaultFilter, matchesUrl, sanitizeQuery } from './filter'
import { REACTIONS, excerptOf } from './github'
import type { Strings } from './i18n'
import { INBOX_CAP } from './inbox'
import { cardRowsOf, paneLayout, rowKeyOf, unreadCount, visibleMark } from './marks'
import { linksOf, prCardLine, prChip, prLine, prRefOf } from './prs'
import type { PrTone, ShownPr } from './prs'
import { clean, cleanLine } from './text'
import { labelSays } from './triage'

export { rowKeyOf }

type Table = Elements[keyof Elements]

/** What the pane draws from. */
export type ViewState = {
  sections: Section[]
  details: Record<string, IssueDetails>
  recaps: Record<string, Recap>
  mappings: Record<string, Mapping>
  /** Pull-request states per repository key (E3). */
  prs: Record<string, PrRecord>
  /** The pull request the app binds to each mapped issue session, by row key (E3). */
  sessionPrs: Record<string, SessionPr>
  settings: RepoSettings
  /** E14: the pane's filter, and the key of the list it asks (undefined for the default list). */
  filter: Filter
  filterKey: string | undefined
  isFilterOpen: boolean
  /** What the label and milestone pickers offer (E14). */
  facets: Facets
  /** Part of the search field's key: bumped when the filter clears the search, so the field is drawn afresh (E14-4). */
  searchGen: number
  /** E18's board status per row. */
  boards: Boards
  /** E11's section. */
  inbox: Inbox
  /** E22's recently closed issues, loading flags and failures, per repository key. */
  closed: Record<string, ClosedCache>
  closedLoading: Record<string, number>
  closedErrors: Record<string, RepoState>
  /** E5's baselines per repository key and the glimpses per row key: what the marks are drawn from. */
  seenBase: Record<string, SeenRecord>
  glimpsed: Record<string, Glimpse>
  options: Options
  strings: Strings
  opened: string
  starting: Record<string, boolean>
  isRefreshing: boolean
  isSettingsOpen: boolean
  tokens: number
  version: string
  now: number
  columns: number
  rows: number
  /** The first row of the tree the pane's window shows (E4's cards go to the rows near it). */
  scrollOffset: number
  surface: RenderSurface
  route: StartRoute
}

/** What a press asks for; the hooks module carries it out. */
export type ViewActions = {
  /** The title bar's ↻: the owner's own refresh. */
  refresh: () => void
  /** A state block's retry, after the owner fixed what it names (signed in, back online). */
  retry: () => void
  toggleSettings: () => void
  close: () => void
  toggleSection: (key: string) => void
  toggleRow: (rowKey: string) => void
  /** `label` is the button's label as drawn: the owner's own words for the press, which a typed desktop call carries. */
  workOn: (sectionKey: string, number: number, label: string) => void
  takeHere: (sectionKey: string, number: number) => void
  consent: (repoKey: string, value: boolean) => void
  addWatch: (spec: string) => void
  removeWatch: (spec: string) => void
  /** E14: the ⌕ tool, a picker's choice, the search (Enter), ✕, saving and removing a view. */
  toggleFilter: () => void
  setFilter: (patch: Partial<Filter>) => void
  setSearch: (text: string) => void
  clearFilter: () => void
  saveView: (name: string) => void
  removeView: (id: string) => void
  /** E17-4: an epic's open sub-issues in the list, through the search. */
  listSubIssues: (rowKey: string) => void
  /** E18: the ⚙ panel's switch, and Erneut prüfen after a missing scope. */
  toggleBoards: () => void
  retryBoards: (host: string) => void
  /** E11: the section's header, and ↓ Zeigen. */
  toggleInbox: () => void
  showInSection: (rowKey: string) => void
  /** E22: a repository's "recently closed" header. */
  toggleClosed: (sectionKey: string) => void
  /** E5: the title bar's unread pill marks every row of every section seen. */
  markAllSeen: () => void
}

/** Text colors: the theme's own keys, so the pane follows the app's light or dark mode. */
const INK = {
  text: 'text',
  secondary: 'inactive',
  muted: 'subtle',
  brand: 'claude',
  success: 'success',
  warning: 'warning',
  error: 'error',
  accent: 'suggestion',
} as const

/** Hues for tints: mid tones that read on a light and a dark ground alike. */
const HUE = {
  brand: '#d97757',
  green: '#30a46c',
  amber: '#e09b1a',
  blue: '#4c8ed9',
  gray: '#8b8d98',
  red: '#e5484d',
  purple: '#8e4ec6',
} as const

/** A pull request's tone as ink and hue; `neutral` while its state is unknown. */
const PR_INK: Record<PrTone | 'neutral', string> = {
  merged: 'merged',
  muted: INK.muted,
  error: INK.error,
  warning: INK.warning,
  success: INK.success,
  accent: INK.accent,
  neutral: INK.secondary,
}
const PR_HUE: Record<PrTone | 'neutral', string> = {
  merged: HUE.purple,
  muted: HUE.gray,
  error: HUE.red,
  warning: HUE.amber,
  success: HUE.green,
  accent: HUE.blue,
  neutral: HUE.gray,
}

/** A color of no ink: a border that keeps its room without showing. */
const CLEAR = '#00000000'
/** How many label chips a row shows before the rest is counted; one fewer once another pill shows (plan 4.6). */
const LABELS_SHOWN = 4
/** The longest text a chip-line pill draws (plan 4.6). */
const PILL_CHARS = 24
/** How many pull-request chips the status strip draws before it counts the rest. */
const PR_CHIPS = 2
/** How many pull requests the opened row lists. */
const PR_LINES = 3
/** E4: the most characters one hover card holds; its body is cut last to stay within it (E4-1). */
const CARD_CHARS = 600
/** E4: no more cards once the drawing's text before a row (visible and hidden) passes this (E4-4: the tree draws 100,000). */
const CARD_TEXT_STOP = 60_000
/** E4: how many comments and pull requests a card lists, one line each. */
const CARD_COMMENTS = 2
const CARD_PRS = 2
/** E4: reactions as emoji, the most first, at most four. */
const REACTION_GLYPH: Record<string, string> = { THUMBS_UP: '👍', THUMBS_DOWN: '👎', LAUGH: '😄', HOORAY: '🎉', CONFUSED: '😕', HEART: '❤️', ROCKET: '🚀', EYES: '👀' }
/** E9: the kind chip's hue. */
const KIND_HUE: Record<Triage['kind'], string> = { bug: HUE.red, feature: HUE.blue, question: HUE.amber, other: HUE.gray }

/** E4: `👍 3 😄 1`, the most first (GitHub's order between equals), at most `max`; empty without reactions. */
export function reactionsText(reactions: Reactions | undefined, max = 4): string {
  return REACTIONS.map(content => ({ content, count: reactions?.[content] ?? 0 }))
    .filter(found => found.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, max)
    .map(found => `${REACTION_GLYPH[found.content] ?? ''} ${found.count}`)
    .join(' ')
}

/** `text` cut to `max` characters, an ellipsis marking the cut. */
function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text
}

/** `text` cut to the pill's room, an ellipsis marking the cut. */
export function pillText(text: string): string {
  return text.length > PILL_CHARS ? `${text.slice(0, PILL_CHARS - 1)}…` : text
}

/** How a row names a related issue: `#12` in the section's repository, `owner/name#12` elsewhere. */
export function refLabel(ref: Pick<IssueRef, 'number' | 'repo'>, sectionRepo: string): string {
  return ref.repo === '' || ref.repo.toLowerCase() === sectionRepo.toLowerCase() ? `#${ref.number}` : `${ref.repo}#${ref.number}`
}

function repoOfSection(section: Section): string {
  return section.info === null ? '' : `${section.info.owner}/${section.info.name}`
}

/** `hex` at `alpha` as CSS rgba: a tint the theme's ground shows through. */
function tint(hex: string, alpha: number): string {
  const clean = hex.replace('#', '')
  const full = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return `rgba(139, 141, 152, ${alpha})`
  const channel = (at: number) => Number.parseInt(full.slice(at, at + 2), 16)

  return `rgba(${channel(0)}, ${channel(2)}, ${channel(4)}, ${alpha})`
}

const pad2 = (n: number) => String(n).padStart(2, '0')

export function fmtTime(ms: number): string {
  const d = new Date(ms)

  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function fmtK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/** "2h", "3d": the age a row has room for. */
export function shortAgo(iso: string, now: number, words: Strings['ago']): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return '—'
  const minutes = Math.floor((now - ms) / 60_000)
  if (minutes < 1) return words.now
  if (minutes < 60) return `${minutes}${words.m}`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}${words.h}`
  const days = Math.floor(hours / 24)
  if (days < 14) return `${days}${words.d}`
  if (days < 60) return `${Math.floor(days / 7)}${words.w}`

  return `${Math.floor(days / 30)}${words.mo}`
}

function labelOf(section: Section): string {
  return clean(section.info === null ? section.spec : `${section.info.owner}/${section.info.name}`)
}

function logoSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22"><rect x="0.5" y="0.5" width="21" height="21" rx="5" fill="${HUE.brand}" fill-opacity="0.12" stroke="${HUE.brand}" stroke-opacity="0.35"/><circle cx="11" cy="11" r="5.5" fill="none" stroke="${HUE.brand}" stroke-width="1.8"/><circle cx="11" cy="11" r="1.8" fill="${HUE.brand}"/></svg>`
}

export function renderPane(ui: Table, state: ViewState, actions: ViewActions): RenderElement {
  const { Box, Text, Button, Link, Code } = ui
  const isRich = state.surface !== 'terminal'
  const Svg = isRich && 'Svg' in ui ? ui.Svg : undefined
  const Input = state.surface !== 'mobile' && 'Input' in ui ? ui.Input : undefined
  // E14: a surface without Select (mobile) draws a picker as a row of chips instead.
  const Select = state.surface !== 'mobile' && 'Select' in ui ? ui.Select : undefined
  const S = state.strings
  const { options, settings } = state
  const step = (rich: Space, plain: number): Space => (isRich ? rich : plain)
  const wash = (hue: string, alpha: number) => (isRich ? tint(hue, alpha) : undefined)
  const savedViews = settings.views ?? []
  /** E18's facet while the feature is on; empty keeps every row. */
  const boardFacet = settings.boards === true ? state.filter.board : ''
  // The rows drawn, in order, within the row budget, and where each sits: the one rule a look (E5) and the cards (E4)
  // read too, so they always agree with the drawing.
  const { plan, tops } = paneLayout(state)
  const planOf = new Map(plan.sections.map(drawn => [drawn.section.key, drawn]))
  /** E14-5: a section listed for another filter than the current one is drawn as loading until its own list comes. */
  const isStale = (section: Section) => planOf.get(section.key)?.isStale ?? false
  const listedOf = (section: Section): IssueRow[] => (isStale(section) ? [] : section.rows)
  /** The rows a section draws: its listed rows, those the board facet picks (E18). */
  const shownOf = (section: Section): IssueRow[] => planOf.get(section.key)?.shown ?? []
  const isFiltered = (section: Section) => section.query !== undefined
  // E4: the hover cards, desktop only, on the rows near the pane's window (never the first drawn), each within its
  // characters and all of them while the drawing's text before a row stays well under the tree's 100,000 (E4-4).
  const canHover = state.surface === 'desktop'
  const cardKeys = new Set(canHover && options.hoverCards ? cardRowsOf(tops, state.scrollOffset, state.rows).map(found => found.key) : [])
  let textSoFar = 0
  // E5: every row's mark, and how many rows show one.
  const markOfRow = (section: Section, item: IssueRow): Mark | null => visibleMark(item, state.seenBase[section.key], state.glimpsed[rowKeyOf(section.key, item.number)], state.now)
  const unread = unreadCount(plan, state.seenBase, state.glimpsed, state.now)
  /** One line of words for a failed state, as the state blocks word it. */
  const stateText = (failed: RepoState): string => {
    const host = clean(failed.host ?? 'github.com')
    const detail = failed.detail === undefined ? undefined : clean(failed.detail)
    switch (failed.kind) {
      case 'offline':
        return S.offline
      case 'rate-limited':
        return S.rateLimited
      case 'signed-out':
        return S.signedOut(host)
      case 'token-invalid':
        return S.tokenInvalid
      case 'gh-missing':
        return S.ghMissing
      case 'no-access':
        return S.noAccess(detail ?? '?')
      case 'missing-scope':
        return S.scopeMissing(detail ?? 'read:project')
      default:
        return S.error(detail ?? failed.kind)
    }
  }
  const note = (text: string, ink: string = INK.secondary) => (
    <Text size="footnote" color={ink} wrap="wrap">
      {text}
    </Text>
  )

  /** A small label: a tinted, bordered Box on a graphical surface, a colored run on the terminal; `canShrink` lets it cut its text at the row's end. */
  const pill = (text: string, ink: string, hue: string, isRound = false, canShrink = false) =>
    isRich ? (
      <Box
        borderStyle={isRound ? 'round' : 'single'}
        borderColor={tint(hue, 0.35)}
        backgroundColor={tint(hue, 0.12)}
        paddingX="sm"
        paddingY={0}
        flexShrink={canShrink ? 1 : 0}
        minWidth={canShrink ? 0 : undefined}
      >
        <Text size="caption" weight="medium" color={ink} wrap={canShrink ? 'truncate-end' : undefined}>
          {text}
        </Text>
      </Box>
    ) : (
      <Text color={ink} wrap={canShrink ? 'truncate-end' : undefined}>
        {text}
      </Text>
    )

  /** A GitHub label: its own color as a tint only, the text in the theme's ink. */
  const labelChip = (name: string, color: string) =>
    isRich ? (
      <Box borderStyle="single" borderColor={tint(`#${color}`, 0.45)} backgroundColor={tint(`#${color}`, 0.14)} paddingX="xs" paddingY={0} flexShrink={0}>
        <Text size="caption" color={INK.text} wrap="truncate-end">
          {name}
        </Text>
      </Box>
    ) : (
      <Text color={INK.accent}>[{name}]</Text>
    )

  /** A small pressable mark of the title bar or a header. */
  const tool = (id: string, glyph: string, title: string, onPress: () => void) => (
    <Box key={`tool:${id}`} flexShrink={0} paddingX={step('xs', 0)}>
      <Button key={id} plain label={glyph} hover={{ color: INK.brand }} onPress={onPress} />
    </Box>
  )

  const hairline = () => (isRich ? <Box height={0.07} backgroundColor={tint(HUE.gray, 0.3)} /> : null)

  // Title bar ------------------------------------------------------------
  const titleBar = (
    <Box flexDirection="row" alignItems="center" paddingX={step('xs', 0)} paddingY={step('xs', 0)}>
      <Box flexDirection="row" alignItems="center" columnGap={step('sm', 1)} flexGrow={1} flexShrink={1} minWidth={0}>
        {Svg !== undefined ? <Svg source={logoSvg()} alt={S.title} width={22} height={22} /> : <Text color={INK.brand}>◎</Text>}
        <Text size="heading" weight="semibold">
          {S.title}
        </Text>
        {pill(S.radar, INK.brand, HUE.brand, true)}
        {/* E5: how many rows are marked; a press marks every row of every section seen. A hover needs its keyed Box. */}
        {unread > 0 && (
          <Box key="tool:seen-all" flexShrink={0}>
            <Button key="seen-all" plain label={S.unread(unread)} hover={{ color: INK.brand }} onPress={actions.markAllSeen} />
          </Box>
        )}
      </Box>
      <Box flexDirection="row" alignItems="center" columnGap={step('xs', 1)}>
        {tool('refresh', state.isRefreshing ? '…' : '↻', S.refresh, actions.refresh)}
        {tool('filter', '⌕', S.filter, actions.toggleFilter)}
        {tool('settings', '⚙', S.settings, actions.toggleSettings)}
        {tool('close', '✕', S.close, actions.close)}
      </Box>
    </Box>
  )

  // Filter (E14) -----------------------------------------------------------

  /**
   * A one-of-several picker: a Select where the surface draws one, else a row of plain chips, the current one in
   * brackets. The current value is always among the options: a value outside them is not one a Select takes. Every
   * value is cleaned here as well as at its source: a control character in one gets the whole tree refused (R2-RT-1).
   */
  const picker = (key: string, label: string, choices: ReadonlyArray<{ value: string; label: string }>, value: string, onPick: (value: string) => void) => {
    const current = clean(value)
    const safe = choices.map(choice => ({ value: clean(choice.value), label: choice.label }))
    // Values unique (a Select refuses a repeated one), the current one among them.
    const unique = safe.filter((choice, index) => safe.findIndex(found => found.value === choice.value) === index)
    const listed = unique.some(choice => choice.value === current) ? unique : [...unique, { value: current, label: cutText(current, 40) }]
    if (Select !== undefined) return <Select key={key} label={label} options={listed.map(choice => ({ value: choice.value, label: choice.label }))} value={current} onSelect={picked => onPick(picked)} />

    return (
      <Box key={key} flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={step('xs', 1)} rowGap={step('xs', 0)}>
        <Text size="caption" color={INK.secondary}>
          {label}:
        </Text>
        {listed.map(choice => (
          <Button key={`${key}:${choice.value}`} plain label={choice.value === current ? `[${choice.label}]` : choice.label} onPress={() => onPick(choice.value)} />
        ))}
      </Box>
    )
  }

  /** The listed rows' board items (E18), for the facet's options. */
  const listedItems = state.sections.flatMap(section => listedOf(section).map(item => state.boards.items[rowKeyOf(section.key, item.number)] ?? []))
  const boardChoices = boardOptions(listedItems).map(option => ({ value: option.value, label: clean(S.boardOption(option.title, option.status ?? S.boardNoStatus)) }))
  const listedCount = state.sections.reduce((sum, section) => sum + listedOf(section).length, 0)
  const isScopeMissing = Object.values(state.boards.scope).some(scope => scope === 'missing')

  /** The filter line (E14): what the filter is, cut at the end, and ✕ to restore the default. */
  const filterLine = (() => {
    const f = state.filter
    // A board facet left from before E18 was switched off filters nothing, so it alone names no filter.
    if (isDefaultFilter({ ...f, board: boardFacet })) return null
    const parts: string[] = []
    if (f.view !== 'open') parts.push(isBuiltInView(f.view) ? S.viewNames[f.view] : (savedViews.find(view => view.id === f.view)?.name ?? f.view))
    const { query, dropped } = sanitizeQuery(f.search)
    const epic = /^parent-issue:([\w.-]+\/[\w.-]+#\d+)$/.exec(query)?.[1]
    if (epic !== undefined) parts.push(S.subIssuesOf(epic))
    else if (query !== '') parts.push(`"${query}"`)
    if (f.label !== '') parts.push(`label:${f.label}`)
    if (f.milestone !== '') parts.push(`milestone:${f.milestone}`)
    if (f.sort !== 'updated') parts.push(S.sortNames[f.sort])
    if (f.group !== 'none') parts.push(S.groupNames[f.group])
    if (boardFacet !== '') parts.push(`${S.boardFacet}: ${boardChoices.find(choice => choice.value === boardFacet)?.label ?? boardFacet} (${S.boardAmong(listedCount)})`)
    if (dropped.length > 0) parts.push(S.filterIgnored(dropped.join(' ')))

    return (
      <Box key="filter-line" flexDirection="row" alignItems="center" columnGap={step('sm', 1)} paddingX={step('sm', 1)}>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text size="caption" color={INK.accent} wrap="truncate-end">
            {clean(`⌕ ${parts.join(' · ')}`)}
          </Text>
        </Box>
        <Button key="filter-clear" plain label="✕" onPress={actions.clearFilter} />
      </Box>
    )
  })()

  /** The filter panel (E14): one control per line; the search Input draws no value, by V1's rule (E14-4). */
  const filterPanel = (() => {
    if (!state.isFilterOpen) return null
    const f = state.filter
    const viewChoices = [...VIEWS.map(view => ({ value: view as string, label: S.viewNames[view] })), ...savedViews.map(view => ({ value: view.id, label: clean(view.name) }))]
    const facetChoices = (names: readonly string[]) => [{ value: ANY, label: S.filterAny }, ...names.map(name => ({ value: clean(name), label: cutText(clean(name), 40) }))]
    const pickSort = (value: string) => {
      const sort = SORTS.find(found => found === value)
      if (sort !== undefined) actions.setFilter({ sort: sort as FilterSort })
    }
    const pickGroup = (value: string) => {
      const group = GROUPS.find(found => found === value)
      if (group !== undefined) actions.setFilter({ group: group as FilterGroup })
    }
    const hasSearch = sanitizeQuery(f.search).query !== ''
    const boardPart = (() => {
      if (settings.boards !== true) return null
      if (isScopeMissing) return note(S.boardScopeLine, INK.muted)
      if (boardChoices.length === 0) return listedCount > 0 && Object.values(state.boards.scope).some(scope => scope === 'present') ? note(S.boardNone, INK.muted) : null

      return picker('filter-board', S.boardFacet, [{ value: ANY, label: S.filterAny }, ...boardChoices], f.board === '' ? ANY : f.board, value => actions.setFilter({ board: value === ANY ? '' : value }))
    })()

    return (
      <Box key="filter-panel" flexDirection="column" marginTop={step('sm', 0)} paddingX={step('md', 1)} paddingY={step('sm', 0)} rowGap={step('xs', 0)} borderStyle="round" backgroundColor={wash(HUE.blue, 0.04)}>
        {picker('filter-view', S.filterView, viewChoices, f.view, value => actions.setFilter({ view: value }))}
        {Input !== undefined && <Input key={`filter-search:${state.searchGen}`} placeholder={S.filterSearchHint} submitLabel={S.filterSearch} onSubmit={value => actions.setSearch(value)} />}
        {(state.facets.labels.length > 0 || f.label !== '') && picker('filter-label', S.filterLabel, facetChoices(state.facets.labels), f.label === '' ? ANY : f.label, value => actions.setFilter({ label: value === ANY ? '' : value }))}
        {(state.facets.milestones.length > 0 || f.milestone !== '') &&
          picker('filter-milestone', S.filterMilestone, facetChoices(state.facets.milestones), f.milestone === '' ? ANY : f.milestone, value => actions.setFilter({ milestone: value === ANY ? '' : value }))}
        {picker(
          'filter-sort',
          S.filterSort,
          SORTS.map(sort => ({ value: sort as string, label: S.sortNames[sort] })),
          f.sort,
          pickSort,
        )}
        {picker(
          'filter-group',
          S.filterGroup,
          GROUPS.map(group => ({ value: group as string, label: S.groupNames[group] })),
          f.group,
          pickGroup,
        )}
        {boardPart}
        {Input !== undefined && hasSearch && <Input key={`filter-save:${state.searchGen}`} placeholder={S.filterSaveHint} submitLabel={S.filterSave} onSubmit={value => actions.saveView(value)} />}
      </Box>
    )
  })()

  // Settings panel -------------------------------------------------------
  const boardsOn = settings.boards === true
  const boardHosts = Object.entries(state.boards.scope).filter(([, scope]) => scope === 'missing').map(([host]) => host)
  const settingsPanel = state.isSettingsOpen ? (
    <Box flexDirection="column" marginTop={step('sm', 0)} paddingX={step('md', 1)} paddingY={step('sm', 0)} rowGap={step('xs', 0)} borderStyle="round" backgroundColor={wash(HUE.gray, 0.05)}>
      <Text size="caption" weight="semibold" color={INK.secondary}>
        {S.watchTitle}
      </Text>
      {settings.watch.length === 0 && (
        <Text size="caption" color={INK.muted}>
          {S.watchNone}
        </Text>
      )}
      {settings.watch.map(spec => (
        <Box key={`watch:${spec}`} flexDirection="row" alignItems="center" columnGap={step('sm', 1)}>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text size="footnote" wrap="truncate-end">
              {clean(spec)}
            </Text>
          </Box>
          <Button key={`unwatch:${spec}`} plain label={isRich ? '✕' : `✕ ${S.watchRemove}`} onPress={() => actions.removeWatch(spec)} />
        </Box>
      ))}
      {Input !== undefined && (
        <Box flexDirection="row" alignItems="center" columnGap={step('sm', 1)}>
          {/* No `value`: a field the hook redraws with every keystroke's echo drops typed characters. */}
          <Input key="watch-add" placeholder={S.watchHint} submitLabel={S.watchAdd} onSubmit={value => actions.addWatch(value)} />
        </Box>
      )}
      <Text size="caption" weight="semibold" color={INK.secondary}>
        {S.recapsTitle}
      </Text>
      {!options.recaps && (
        <Text size="caption" color={INK.muted}>
          {S.recapsOff}
        </Text>
      )}
      {options.recaps &&
        state.sections
          .filter(section => section.info !== null)
          .map(section => {
            const value = settings.consent[section.key]
            const text = value === true ? S.on : value === false ? S.off : S.notAsked

            return (
              <Box key={`consent-row:${section.key}`} flexDirection="row" alignItems="center" columnGap={step('sm', 1)}>
                {isRich ? pill(text, value === true ? INK.success : INK.muted, value === true ? HUE.green : HUE.gray) : null}
                <Button key={`consent:${section.key}`} plain label={isRich ? labelOf(section) : `[${text}] ${labelOf(section)}`} onPress={() => actions.consent(section.key, value !== true)} />
              </Box>
            )
          })}
      <Text size="caption" weight="semibold" color={INK.secondary}>
        {S.savedViewsTitle}
      </Text>
      {savedViews.length === 0 && (
        <Text size="caption" color={INK.muted}>
          {S.savedViewsNone}
        </Text>
      )}
      {savedViews.map(view => (
        <Box key={`view:${view.id}`} flexDirection="row" alignItems="center" columnGap={step('sm', 1)}>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text size="footnote" wrap="truncate-end">
              {clean(view.name)} <Text color={INK.muted}>{clean(view.query)}</Text>
            </Text>
          </Box>
          <Button key={`view-remove:${view.id}`} plain label={isRich ? '✕' : `✕ ${S.watchRemove}`} onPress={() => actions.removeView(view.id)} />
        </Box>
      ))}
      <Text size="caption" weight="semibold" color={INK.secondary}>
        {S.boardsTitle}
      </Text>
      <Box key="boards-row" flexDirection="row" alignItems="center" columnGap={step('sm', 1)}>
        {isRich ? pill(boardsOn ? S.on : S.off, boardsOn ? INK.success : INK.muted, boardsOn ? HUE.green : HUE.gray) : null}
        <Button key="boards-toggle" plain label={isRich ? S.boardsLabel : `[${boardsOn ? S.on : S.off}] ${S.boardsLabel}`} onPress={actions.toggleBoards} />
      </Box>
      {boardsOn &&
        boardHosts.map(host => {
          const scope = clean(state.boards.needs[host] ?? 'read:project')
          const shownHost = clean(host)

          return (
            <Box key={`boards-scope:${host}`} flexDirection="column" rowGap={step('xs', 0)}>
              {note(S.boardScopeMissing(scope), INK.warning)}
              <Code source={S.scopeHint(shownHost, scope)} language="bash" />
              {note(S.scopeEnv(shownHost, scope), INK.muted)}
              <Button key={`boards-retry:${host}`} label={S.retry} onPress={() => actions.retryBoards(host)} />
            </Box>
          )
        })}
      {boardsOn &&
        Object.entries(state.boards.detail).map(([host, detail]) => (
          <Box key={`boards-failed:${host}`} flexDirection="column">
            {note(S.boardUnavailable(clean(detail)), INK.warning)}
          </Box>
        ))}
    </Box>
  ) : null

  // States ---------------------------------------------------------------
  const stateBlock = (section: Section) => {
    const { kind } = section.state
    const label = labelOf(section)
    const host = clean(section.state.host ?? section.info?.host ?? 'github.com')
    // What gh said (a repository, a scope, the first line of an error) is gh's text, not ours.
    const detail = section.state.detail === undefined ? undefined : clean(section.state.detail)
    const line = (text: string, ink: string = INK.secondary) => (
      <Text size="footnote" color={ink} wrap="wrap">
        {text}
      </Text>
    )
    const retry = <Button key={`retry:${section.key}`} label={S.retry} onPress={actions.retry} />
    const body = (() => {
      switch (kind) {
        case 'loading':
          return [line(S.loading(label))]
        case 'no-git':
          return [line(S.noGit)]
        case 'no-remote':
          return [line(S.noRemote)]
        case 'not-github':
          return [line(S.notGithub)]
        case 'signed-out':
          return [line(S.signedOut(host), INK.warning), <Code source={S.signInHint(host)} language="bash" />, retry]
        case 'gh-missing':
          return [line(S.ghMissing, INK.warning), <Link href={S.ghInstall} label={S.ghInstall} />, retry]
        case 'token-invalid':
          return [line(S.tokenInvalid, INK.warning), <Code source={S.signInHint(host)} language="bash" />, retry]
        case 'missing-scope': {
          const scope = detail ?? 'read:project'

          return [line(S.scopeMissing(scope), INK.warning), <Code source={S.scopeHint(host, scope)} language="bash" />, line(S.scopeEnv(host, scope), INK.muted), retry]
        }
        case 'no-access':
          return [line(S.noAccess(detail ?? label), INK.warning), retry]
        case 'issues-disabled':
          return [line(S.issuesDisabled(label))]
        case 'archived':
          return [line(S.archived(label))]
        case 'offline':
          return [line(S.offline, INK.warning), retry]
        case 'rate-limited':
          return [line(S.rateLimited, INK.warning)]
        case 'error':
          return [line(S.error(detail ?? '?'), INK.error), retry]
        case 'ok': {
          if (section.rows.length > 0) return []
          // E14: an empty filtered list says so, and links GitHub's search for the same query.
          if (isFiltered(section)) {
            const href = section.info === null ? null : matchesUrl(section.info.url, state.filter, savedViews, state.now)

            return [line(S.emptyFiltered(label)), href === null ? null : <Link href={clean(href)} label={S.allMatches} />]
          }

          return [line(S.empty(label)), section.info === null ? null : <Link href={clean(`${section.info.url}/issues`)} label={S.allIssues} />]
        }
      }
    })()
    const parts = body.filter(part => part !== null)
    if (parts.length === 0) return null

    return (
      <Box flexDirection="column" rowGap={step('xs', 0)} paddingX={step('sm', 1)} paddingY={step('xs', 0)}>
        {parts}
      </Box>
    )
  }

  // Consent --------------------------------------------------------------
  const consentBlock = (section: Section) => {
    if (!options.recaps || section.info === null || section.state.kind !== 'ok' || settings.consent[section.key] !== undefined) return null

    return (
      <Box
        key={`consent-block:${section.key}`}
        flexDirection="column"
        rowGap={step('xs', 0)}
        marginX={step('sm', 0)}
        marginY={step('xs', 0)}
        paddingX={step('md', 1)}
        paddingY={step('sm', 0)}
        borderStyle="round"
        borderColor={isRich ? tint(HUE.brand, 0.45) : INK.brand}
        backgroundColor={wash(HUE.brand, 0.06)}
      >
        <Text size="footnote" weight="semibold" wrap="wrap">
          {S.consentTitle(labelOf(section))}
        </Text>
        <Text size="caption" color={INK.secondary} wrap="wrap">
          {S.consentDetail}
        </Text>
        <Box flexDirection="row" flexWrap="wrap" columnGap={step('xs', 1)} rowGap={step('xs', 0)}>
          <Button key={`consent-on:${section.key}`} label={S.consentOn} variant="primary" onPress={() => actions.consent(section.key, true)} />
          <Button key={`consent-off:${section.key}`} label={S.consentOff} onPress={() => actions.consent(section.key, false)} />
        </Box>
      </Box>
    )
  }

  // One issue ------------------------------------------------------------

  /** A pill of the row's own, keyed so the drawing names what it shows (tests find it by key, plan 4.6). */
  const keyedPill = (key: string, text: string, ink: string, hue: string) => (
    <Box key={key} flexShrink={0}>
      {pill(pillText(clean(text)), ink, hue)}
    </Box>
  )

  /**
   * E9: the triage a row shows, where the repository consented to recaps and the recap call brought one; while a newer
   * recap is pending, the last one, drawn muted. Undefined where there is none to show.
   */
  const triageOf = (section: Section, row: IssueRow, recap: Recap | undefined): { triage: Triage; isStale: boolean } | undefined => {
    if (!options.recaps || settings.consent[section.key] !== true || recap === undefined || recap.error !== undefined || recap.triage === undefined) return undefined

    return { triage: recap.triage, isStale: recap.updatedAt < row.updatedAt }
  }

  /** E9's chips: the kind (unless a label says it, never `other`), the size when known, and how ready the issue is. */
  const triagePills = (section: Section, row: IssueRow, recap: Recap | undefined): RenderElement[] => {
    const shown = triageOf(section, row, recap)
    if (shown === undefined) return []
    const { triage, isStale } = shown
    const key = rowKeyOf(section.key, row.number)
    const ink = (live: string) => (isStale ? INK.muted : live)
    const parts: RenderElement[] = []
    if (!labelSays(triage.kind, row.labels)) parts.push(keyedPill(`triage:${key}:kind`, S.kinds[triage.kind], ink(INK.text), KIND_HUE[triage.kind]))
    if (triage.size !== null) parts.push(keyedPill(`triage:${key}:size`, S.size(triage.size), ink(INK.secondary), HUE.gray))
    if (triage.gaps.length > 0) parts.push(keyedPill(`triage:${key}:readiness`, S.gapCount(triage.gaps.length), ink(INK.warning), HUE.amber))
    else if (triage.criteria === 'stated') parts.push(keyedPill(`triage:${key}:readiness`, S.ready, ink(INK.success), HUE.green))
    else parts.push(keyedPill(`triage:${key}:readiness`, S.criteriaUnclear, ink(INK.warning), HUE.amber))

    return parts
  }

  /**
   * The chip line (plan 4.6, line 2): E5's mark, E17's blocked pill, E18's board status, E9's triage, the labels (at
   * most four, three once another pill shows, then `+n`), E17's progress and parent pills, the facts text last.
   */
  const chips = (section: Section, row: IssueRow, details: IssueDetails | undefined, recap: Recap | undefined) => {
    const key = rowKeyOf(section.key, row.number)
    const sectionRepo = repoOfSection(section)
    // Rows come from the store too: every part of the relations is read as possibly absent.
    const relations = row.relations
    const lead: RenderElement[] = []
    const tail: RenderElement[] = []
    // E5: new or changed since the last visit; tests find it by key (E5-1).
    const mark = markOfRow(section, row)
    if (mark !== null) lead.push(keyedPill(`mark:${key}`, S.marks[mark], mark === 'new' ? INK.brand : INK.accent, mark === 'new' ? HUE.brand : HUE.blue))
    const open = relations?.blockedBy?.open ?? 0
    const firstBlocker = relations?.blockedBy?.refs?.[0]
    if (open > 0 && firstBlocker !== undefined) {
      lead.push(keyedPill(`blocked:${key}`, S.blockedChip(refLabel(firstBlocker, sectionRepo), open - 1), INK.warning, HUE.amber))
    }
    // E18: the board status, right after the blocked pill: in the project the facet picked, else the first open project.
    const onBoard = settings.boards === true ? boardItemFor(state.boards.items[key], boardFacet) : null
    if (onBoard !== null && onBoard.status !== null) lead.push(keyedPill(`board:${key}`, S.boardChip(cutText(onBoard.status, BOARD_STATUS_CHARS)), INK.accent, HUE.blue))
    lead.push(...triagePills(section, row, recap))
    const subIssues = relations?.subIssues ?? null
    if (subIssues !== null) {
      const isDone = subIssues.completed >= subIssues.total
      tail.push(keyedPill(`subs:${key}`, S.subProgress(subIssues.completed, subIssues.total), isDone ? INK.success : INK.accent, isDone ? HUE.green : HUE.blue))
    }
    const parent = relations?.parent ?? null
    if (parent !== null) tail.push(keyedPill(`parent:${key}`, S.partOf(refLabel(parent, sectionRepo)), INK.muted, HUE.gray))
    const labelsShown = lead.length + tail.length > 0 ? LABELS_SHOWN - 1 : LABELS_SHOWN
    const parts: RenderElement[] = [...lead]
    // A label's name runs to 50 characters on GitHub: cut to the pill's room like every chip-line pill (plan 4.6).
    row.labels.slice(0, labelsShown).forEach(label => parts.push(labelChip(pillText(clean(label.name)), label.color)))
    if (row.labels.length > labelsShown) {
      parts.push(
        <Text size="caption" color={INK.muted}>
          +{row.labels.length - labelsShown}
        </Text>,
      )
    }
    parts.push(...tail)
    const created = shortAgo(row.createdAt, state.now, S.ago)
    const updated = shortAgo(row.updatedAt, state.now, S.ago)
    const facts: string[] = [created]
    if (updated !== created) facts.push(`↑ ${updated}`)
    if (details !== undefined) facts.push(S.comment(details.commentCount))
    if (row.assignees.length > 0) facts.push(row.assignees.map(name => `@${clean(name)}`).join(' '))
    if (row.isPinned) facts.push(`📌 ${S.pinned}`)
    parts.push(
      <Text size="caption" color={INK.muted} wrap="truncate-end">
        {facts.join(' · ')}
      </Text>,
    )

    return (
      <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={step('xs', 1)} rowGap={step('xs', 0)}>
        {parts}
      </Box>
    )
  }

  const recapLine = (section: Section, row: IssueRow, details: IssueDetails | undefined, recap: Recap | undefined) => {
    const consented = options.recaps && settings.consent[section.key] === true
    if (consented) {
      if (recap !== undefined && recap.error === undefined && recap.updatedAt >= row.updatedAt) {
        return (
          <Text size="caption" color={INK.secondary} wrap="wrap">
            {clean(recap.text)}
          </Text>
        )
      }
      if (recap !== undefined && recap.error !== undefined && recap.updatedAt >= row.updatedAt) {
        return (
          <Text size="caption" color={INK.muted} wrap="wrap">
            {clean(details?.excerpt ?? '')} <Text color={INK.warning}>({S.recapFailed})</Text>
          </Text>
        )
      }

      return (
        <Text size="caption" color={INK.muted}>
          {S.recapPending}
        </Text>
      )
    }
    if (details === undefined) {
      return (
        <Text size="caption" color={INK.muted}>
          …
        </Text>
      )
    }

    return (
      <Text size="caption" color={INK.secondary} wrap="wrap">
        {details.excerpt === '' ? S.noBody : clean(details.excerpt)} <Text color={INK.muted}>({S.noRecap})</Text>
      </Text>
    )
  }

  /**
   * The pull requests a row shows (E3): GraphQL's states, the details' links, the issue session's own. The app's
   * answer for a session speaks only while the row's mapping still names that session: a released or replaced
   * mapping's pull request is no longer the row's own.
   */
  const prsOf = (section: Section, item: IssueRow, details: IssueDetails | undefined) => {
    const key = rowKeyOf(section.key, item.number)
    const found = state.sessionPrs[key]
    const session = found !== undefined && found.sessionId !== undefined && found.sessionId === state.mappings[key]?.sessionId ? found : undefined

    return { key, session, sectionRepo: repoOfSection(section), ...linksOf(state.prs[section.key], item.number, details, session, repoOfSection(section), state.now) }
  }

  /**
   * The status strip (plan 4.6, line 5): a chip per linked pull request, the most relevant first, at most two and then
   * `+n`; closed, unmerged ones stay out (E3-8). Drawn only when the issue has one.
   */
  const statusStrip = (section: Section, item: IssueRow, details: IssueDetails | undefined) => {
    const { key, session, sectionRepo, links, total } = prsOf(section, item, details)
    const live = links.filter(pr => pr.state !== 'CLOSED')
    if (live.length === 0) return null
    const drawn = live.slice(0, PR_CHIPS)
    const more = Math.max(0, total - drawn.length)

    return (
      <Box key={`prs:${key}`} flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={step('xs', 1)} rowGap={step('xs', 0)}>
        {drawn.map(pr => {
          const chip = prChip(pr, session, sectionRepo, S)
          const tone = chip.tone ?? 'neutral'

          // A chip may cut its text at the strip's end: a long repository name never pushes it past the pane (E3-8).
          return (
            <Box key={`pr:${key}:${pr.repo}#${pr.number}`} flexShrink={1} minWidth={0}>
              {pill(clean(chip.text), PR_INK[tone], PR_HUE[tone], false, true)}
            </Box>
          )
        })}
        {more > 0 && (
          <Text size="caption" color={INK.muted}>
            +{more}
          </Text>
        )}
      </Box>
    )
  }

  /** The opened row's pull requests (E3): one line each, the link and its state in words, never `#n ()`. */
  const prLinesOf = (section: Section, item: IssueRow, details: IssueDetails) => {
    const { key, session, sectionRepo, links } = prsOf(section, item, details)
    if (links.length === 0) return null

    return (
      <Box key={`prlines:${key}`} flexDirection="column">
        <Text size="caption" weight="semibold" color={INK.secondary}>
          {S.linkedPrs}
        </Text>
        {links.slice(0, PR_LINES).map((pr: ShownPr) => {
          const words = prLine(pr, session, S)

          return (
            <Box key={`prline:${key}:${pr.repo}#${pr.number}`} flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={step('xs', 1)}>
              <Link href={clean(pr.url)} label={clean(prRefOf(pr, sectionRepo, false))} />
              {words !== '' && (
                <Text size="caption" color={pr.state === 'CLOSED' ? INK.muted : INK.secondary} wrap="wrap">
                  · {clean(words)}
                </Text>
              )}
            </Box>
          )
        })}
      </Box>
    )
  }

  /** The opened row's relations (E17), from the row alone: the parent, the open blockers, the sub-issue progress. */
  const relationsOf = (section: Section, item: IssueRow) => {
    const relations = item.relations
    if (relations === undefined) return null
    const key = rowKeyOf(section.key, item.number)
    const sectionRepo = repoOfSection(section)
    const parent = relations.parent ?? null
    const subIssues = relations.subIssues ?? null
    const blockedBy = { open: relations.blockedBy?.open ?? 0, refs: relations.blockedBy?.refs ?? [] }
    const more = blockedBy.open - blockedBy.refs.length

    return (
      <Box key={`relations:${key}`} flexDirection="column">
        <Text size="caption" weight="semibold" color={INK.secondary}>
          {S.relationsTitle}
        </Text>
        {parent !== null && <Link href={clean(parent.url)} label={clean(parent.title === '' ? S.partOf(refLabel(parent, sectionRepo)) : S.partOfTitled(refLabel(parent, sectionRepo), parent.title))} />}
        {blockedBy.open > 0 && (
          <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={step('xs', 1)}>
            <Text size="caption" color={INK.warning}>
              {S.blockedByTitle}:
            </Text>
            {blockedBy.refs.map(ref => (
              <Link href={clean(ref.url)} label={clean(refLabel(ref, sectionRepo))} />
            ))}
            {more > 0 && (
              <Text size="caption" color={INK.muted}>
                +{more}
              </Text>
            )}
          </Box>
        )}
        {subIssues !== null && (
          <Text size="caption" color={INK.secondary}>
            {S.subIssuesDone(subIssues.completed, subIssues.total)}
          </Text>
        )}
        {subIssues !== null && subIssues.completed < subIssues.total && <Button key={`sub-issues:${key}`} plain label={S.listSubIssues} onPress={() => actions.listSubIssues(key)} />}
      </Box>
    )
  }

  /** E4: who opened the issue and when, its milestone and its reactions: the card's first line and the opened row's. */
  const bylineOf = (item: IssueRow): string => {
    const parts = [S.cardBy(item.author, shortAgo(item.createdAt, state.now, S.ago))]
    if (item.milestone !== null && item.milestone !== '') parts.push(S.cardMilestone(item.milestone))
    const reactions = reactionsText(item.reactions)
    if (reactions !== '') parts.push(reactions)

    return cleanLine(parts.join(' · '))
  }

  /** E9: the opened row's gaps, one chip each (never sections); none without a triage that names any. */
  const gapsOf = (section: Section, item: IssueRow, recap: Recap | undefined) => {
    const shown = triageOf(section, item, recap)
    if (shown === undefined || shown.triage.gaps.length === 0) return null
    const key = rowKeyOf(section.key, item.number)

    return (
      <Box key={`gaps:${key}`} flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={step('xs', 1)} rowGap={step('xs', 0)}>
        <Text size="caption" weight="semibold" color={INK.secondary}>
          {S.gapsTitle}
        </Text>
        {shown.triage.gaps.map(gap => {
          const said = cleanLine(gap)

          return pill(isRich ? said : `[${said}]`, shown.isStale ? INK.muted : INK.warning, HUE.amber, false, true)
        })}
      </Box>
    )
  }

  /**
   * E4's hover card for a collapsed row, drawn hidden and revealed while the pointer rests on the row's number (no hook
   * runs on hover, so it holds only what the session has): the byline, up to two lines of the body, the last two
   * comments or where they are, up to two pull requests with their state, the relations and the triage. It sits above
   * the number and right of it, growing upward to fit what it holds (E4-1), so the column above the number stays free and
   * moving the pointer up leaves the scope (E4-2). No key (a keyed card would be a scope of its own and never reveal), no
   * Button or Link (a hidden element must never take the focus or a stray click), no Markdown.
   */
  const cardOf = (section: Section, item: IssueRow, details: IssueDetails | undefined, recap: Recap | undefined) => {
    const width = Math.max(20, Math.min(56, state.columns - 10))
    const inner = Math.max(12, width - 4)
    const lineOf = (text: string) => cut(cleanLine(text), inner)
    // The byline and the body may take two lines each; every other line is one, cut at its end.
    type CardLine = { text: string; ink: string; isHeading?: boolean; wraps?: boolean }
    const lines: CardLine[] = [{ text: cut(bylineOf(item), 2 * inner), ink: INK.secondary, wraps: true }]
    const comments = details !== undefined && details.fetchedAt !== 0 ? details.comments.slice(-CARD_COMMENTS) : []
    const tail: CardLine[] = []
    if (comments.length > 0) {
      tail.push({ text: lineOf(S.cardComments(comments.length, Math.max(details?.commentCount ?? 0, comments.length))), ink: INK.secondary, isHeading: true })
      for (const comment of comments) tail.push({ text: lineOf(`${comment.author} · ${shortAgo(comment.createdAt, state.now, S.ago)} · ${comment.body}`), ink: INK.text })
    } else if (details !== undefined) tail.push({ text: lineOf(details.commentCount > 0 ? S.cardCommentsLater(details.commentCount) : S.noComments), ink: INK.muted })
    const { session, sectionRepo, links } = prsOf(section, item, details)
    for (const pr of links.slice(0, CARD_PRS)) tail.push({ text: lineOf(prCardLine(pr, session, sectionRepo, S)), ink: pr.state === 'CLOSED' ? INK.muted : INK.secondary })
    const relations = item.relations
    const related: string[] = []
    if (relations?.parent !== undefined && relations.parent !== null) related.push(S.partOf(refLabel(relations.parent, sectionRepo)))
    const blocker = relations?.blockedBy?.refs?.[0]
    if ((relations?.blockedBy?.open ?? 0) > 0 && blocker !== undefined) related.push(S.blockedChip(refLabel(blocker, sectionRepo), (relations?.blockedBy?.open ?? 1) - 1))
    if (relations?.subIssues !== undefined && relations.subIssues !== null) related.push(S.subProgress(relations.subIssues.completed, relations.subIssues.total))
    if (related.length > 0) tail.push({ text: lineOf(related.join(' · ')), ink: INK.secondary })
    const shown = triageOf(section, item, recap)
    if (shown !== undefined) {
      const { triage } = shown
      const readiness = triage.gaps.length > 0 ? `${S.gapsTitle}: ${triage.gaps.join(', ')}` : triage.criteria === 'stated' ? S.ready : S.criteriaUnclear
      const words = [S.kinds[triage.kind], ...(triage.size === null ? [] : [S.size(triage.size)]), readiness]
      tail.push({ text: lineOf(words.join(' · ')), ink: shown.isStale ? INK.muted : INK.secondary })
    }
    // The body last, in what the card's characters leave: two lines' worth at most (E4-1).
    const others = [...lines, ...tail].reduce((sum, line) => sum + line.text.length, 0)
    const room = Math.min(2 * inner, Math.max(inner, CARD_CHARS - others))
    const body = details === undefined ? '…' : details.fetchedAt !== 0 && details.body.trim() !== '' ? excerptOf(details.body, room) : details.excerpt !== '' ? details.excerpt : S.noBody
    lines.push({ text: cut(cleanLine(body), room), ink: INK.text, wraps: true })
    const all = [...lines, ...tail]
    textSoFar += all.reduce((sum, line) => sum + line.text.length, 0)

    return (
      <Box
        position="absolute"
        bottom={1}
        left={String(item.number).length + 2}
        width={width}
        display="none"
        hover={{ display: 'flex' }}
        flexDirection="column"
        borderStyle="round"
        borderColor={tint(HUE.gray, 0.5)}
        backgroundColor="inverseText"
      >
        <Box flexDirection="column" paddingX="sm" backgroundColor={tint(HUE.gray, 0.06)}>
          {all.map(line => (
            <Text size="caption" weight={line.isHeading === true ? 'semibold' : undefined} color={line.ink} wrap={line.wraps === true ? 'wrap' : 'truncate-end'}>
              {line.text}
            </Text>
          ))}
        </Box>
      </Box>
    )
  }

  const openedBlock = (section: Section, item: IssueRow, details: IssueDetails | undefined, recap: Recap | undefined) => {
    const key = rowKeyOf(section.key, item.number)
    // E4: the card's first line opens the opened row on every surface (the terminal has no card).
    const byline = (
      <Box key={`byline:${key}`} flexDirection="column">
        <Text size="caption" color={INK.secondary} wrap="wrap">
          {bylineOf(item)}
        </Text>
      </Box>
    )
    // A seeded entry has no body or comments yet: the opened row reads as loading until the details land.
    if (details === undefined || details.fetchedAt === 0) {
      return (
        <Box flexDirection="column">
          {byline}
          <Text size="caption" color={INK.muted}>
            …
          </Text>
        </Box>
      )
    }
    // Cleaned after the fold as well: trimming a leading space could bare a combining mark, which gets a tree refused.
    const text = cleanLine(details.body)
    const body = text === '' ? (details.excerpt === '' ? S.noBody : clean(details.excerpt)) : text.slice(0, 600)

    return (
      <Box flexDirection="column" rowGap={step('xs', 0)} paddingX={step('sm', 1)} paddingY={step('xs', 0)} borderStyle="round" backgroundColor={wash(HUE.gray, 0.05)}>
        {byline}
        <Text size="caption" wrap="wrap">
          {body}
          {text.length > 600 ? ' …' : ''}
        </Text>
        <Text size="caption" weight="semibold" color={INK.secondary}>
          {S.lastComments}
        </Text>
        {details.comments.length === 0 && (
          <Text size="caption" color={INK.muted}>
            {S.noComments}
          </Text>
        )}
        {details.comments.map(comment => {
          const said = clean(comment.body)

          return (
            <Text size="caption" color={INK.secondary} wrap="wrap">
              <Text weight="medium" color={INK.text}>
                {clean(comment.author)}
              </Text>{' '}
              · {shortAgo(comment.createdAt, state.now, S.ago)} · {said.slice(0, 240)}
              {said.length > 240 ? ' …' : ''}
            </Text>
          )
        })}
        {prLinesOf(section, item, details)}
        {relationsOf(section, item)}
        {gapsOf(section, item, recap)}
      </Box>
    )
  }

  const row = (section: Section, item: IssueRow) => {
    const key = rowKeyOf(section.key, item.number)
    const details = state.details[key]
    const recap = state.recaps[key]
    const mapping = state.mappings[key]
    const isOpen = state.opened === key
    const isStarting = state.starting[key] === true
    const workLabel = isStarting ? S.starting : mapping !== undefined ? S.openSession : S.workOnIt
    // E4: the card goes before the row's own text in the tree, so it is drawn while the text before it stays well
    // under the tree's budget (E4-4); the row's visible text counts toward that too, by a rough measure.
    const card = cardKeys.has(key) && !isOpen && textSoFar < CARD_TEXT_STOP ? cardOf(section, item, details, recap) : null
    textSoFar += item.title.length + (recap?.text.length ?? details?.excerpt.length ?? 0) + 120

    return (
      <Box
        key={`row:${key}`}
        flexDirection="column"
        rowGap={step('xs', 0)}
        paddingX={step('sm', 1)}
        paddingY={step('xs', 0)}
        borderStyle={isRich ? 'single' : undefined}
        borderColor={isRich ? (isOpen ? tint(HUE.brand, 0.45) : CLEAR) : undefined}
        backgroundColor={isOpen ? wash(HUE.brand, 0.04) : undefined}
        hover={isRich ? { backgroundColor: tint(HUE.gray, 0.08) } : undefined}
      >
        {/* The title line (plan 4.6): the number is E4's hover scope and holds the card; the Button holds the title. */}
        <Box flexDirection="row" alignItems="flex-start" columnGap={step('xs', 1)}>
          <Box key={`peek:${key}`} flexShrink={0}>
            <Text color={INK.muted} hover={canHover ? { color: INK.brand, underline: true } : undefined}>
              #{item.number}
            </Text>
            {card}
          </Box>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Button key={`row-title:${key}`} plain onPress={() => actions.toggleRow(key)}>
              <Text weight="semibold">{clean(item.title)}</Text>
            </Button>
          </Box>
        </Box>
        {chips(section, item, details, recap)}
        {isOpen ? (
          openedBlock(section, item, details, recap)
        ) : (
          <Box key={`recap:${key}`} flexDirection="column">
            {recapLine(section, item, details, recap)}
          </Box>
        )}
        {mapping !== undefined && (
          <Text size="caption" color={INK.muted} wrap="truncate-end">
            {S.sessionLine(clean(mapping.title), fmtTime(mapping.startedAt))}
            {mapping.detached ? '' : ` · ${S.sessionLinked}`}
          </Text>
        )}
        {statusStrip(section, item, details)}
        <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={step('sm', 1)} rowGap={step('xs', 0)}>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Link href={clean(item.url)} label={S.github} />
          </Box>
          <Button
            key={`work:${key}`}
            label={workLabel}
            variant={mapping === undefined && !isStarting ? 'primary' : undefined}
            dimColor={isStarting}
            onPress={() => {
              if (!isStarting) actions.workOn(section.key, item.number, workLabel)
            }}
          />
          <Button key={`here:${key}`} plain label={S.takeHere} onPress={() => actions.takeHere(section.key, item.number)} />
        </Box>
      </Box>
    )
  }

  // Sections -------------------------------------------------------------
  // The row budget is the plan's (marks.ts drawnRowsOf): rows, closed rows and the assigned section's rows share it.

  /**
   * The pointer to the rest on GitHub (E7): `… +382 weitere auf GitHub ↗` once the open count is known and exceeds the
   * rows; while it is unknown, a capped list says it shows only the most recently updated, beside a link to all.
   */
  const pointer = (section: Section) => {
    const count = section.rows.length
    if (section.info === null || section.state.kind !== 'ok' || count === 0 || isStale(section)) return null
    // E14: a filtered list at the cap points to every match on GitHub, within what a Link may hold (E14-2).
    if (isFiltered(section)) {
      const matches = count < options.maxIssues ? null : matchesUrl(section.info.url, state.filter, savedViews, state.now)

      return matches === null ? null : (
        <Box key={`more:${section.key}`} paddingX={step('sm', 1)}>
          <Link href={clean(matches)} label={S.allMatches} />
        </Box>
      )
    }
    const href = clean(`${section.info.url}/issues`)
    if (section.total !== undefined && section.total > count) {
      return (
        <Box key={`more:${section.key}`} paddingX={step('sm', 1)}>
          <Link href={href} label={S.moreOnGitHub(section.total - count)} />
        </Box>
      )
    }
    if (section.total !== undefined || count < options.maxIssues) return null

    return (
      <Box key={`more:${section.key}`} flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={step('xs', 1)} paddingX={step('sm', 1)}>
        <Text size="caption" color={INK.muted}>
          … {S.capped(count)} ·
        </Text>
        <Link href={href} label={S.allIssues} />
      </Box>
    )
  }

  // E22: the recently closed part --------------------------------------------

  const closedRow = (section: Section, item: ClosedRow) => {
    const reason = item.stateReason
    const glyph = reason === 'COMPLETED' ? '✓' : reason === 'NOT_PLANNED' || reason === 'DUPLICATE' ? '⊘' : '•'
    const word = reason === 'COMPLETED' ? S.closedCompleted : reason === 'NOT_PLANNED' ? S.closedNotPlanned : reason === 'DUPLICATE' ? S.closedDuplicate : S.closedPlain
    const first = item.prs[0]

    return (
      <Box key={`closed-row:${section.key}#${item.number}`} flexDirection="column">
        <Text size="caption" wrap="wrap">
          <Text color={reason === 'COMPLETED' ? INK.success : INK.muted}>{glyph}</Text> <Text color={INK.muted}>#{item.number}</Text> {clean(item.title)}
        </Text>
        <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={step('xs', 1)}>
          <Text size="caption" color={INK.muted}>
            {word} · {shortAgo(item.closedAt, state.now, S.ago)} ·
          </Text>
          {first !== undefined && <Link href={clean(first.url)} label={clean(S.prRef(prRefOf(first, repoOfSection(section), true)))} />}
          {item.prs.length > 1 && (
            <Text size="caption" color={INK.muted}>
              +{item.prs.length - 1}
            </Text>
          )}
          {first !== undefined && (
            <Text size="caption" color={INK.muted}>
              ·
            </Text>
          )}
          <Link href={clean(item.url)} label={S.github} />
        </Box>
      </Box>
    )
  }

  /**
   * A repository's collapsed "recently closed" part (E22), at the end of its section: a header with the count of the
   * current window; expanded, the loading line, the failure above the last good rows, at most ten rows, the empty
   * line and the links. Its rows count against the drawing's row budget.
   */
  const closedBlock = (section: Section) => {
    if (options.closedDays <= 0 || section.info === null || section.state.kind !== 'ok') return null
    const key = section.key
    const isOpen = settings.showClosed?.[key] === true
    const cache = state.closed[key]
    const since = sinceDate(state.now, options.closedDays)
    const header = (
      <Box key={`closed:${key}`} flexDirection="row" alignItems="center" columnGap={step('sm', 1)} paddingX={step('sm', 1)}>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Button key={`closed-toggle:${key}`} plain onPress={() => actions.toggleClosed(key)}>
            <Text size="caption" color={INK.muted}>
              {isOpen ? '▼' : '▶'}
            </Text>{' '}
            <Text size="footnote" color={INK.secondary}>
              {S.closedTitle(options.closedDays)}
            </Text>
          </Button>
        </Box>
        {cache !== undefined && cache.since === since && (
          <Box key={`closed-count:${key}`} flexShrink={0}>
            {pill(closedCountLabel(cache), INK.muted, HUE.gray)}
          </Box>
        )}
      </Box>
    )
    if (!isOpen) return header
    const loadingAt = state.closedLoading[key]
    const failed = state.closedErrors[key]
    // Loading while a fetch runs, and while the part holds no list of this window and nothing failed: the next refresh
    // that may fetch brings one (B2-BEH-4), so an expanded part is never a bare header.
    const isLoading = (loadingAt !== undefined && state.now - loadingAt < CLOSED_LOADING_MS) || (failed === undefined && (cache === undefined || cache.since !== since))
    const drawn = (cache?.rows ?? []).slice(0, planOf.get(key)?.closed ?? 0)

    return (
      <Box key={`closed-part:${key}`} flexDirection="column" rowGap={step('xs', 0)}>
        {header}
        <Box flexDirection="column" rowGap={step('xs', 0)} paddingX={step('md', 2)}>
          {isLoading && (
            <Text size="caption" color={INK.muted}>
              {S.closedLoading}
            </Text>
          )}
          {failed !== undefined && note(stateText(failed), INK.warning)}
          {drawn.map(item => closedRow(section, item))}
          {cache !== undefined && cache.since === since && cache.rows.length === 0 && !isLoading && (
            <Text size="caption" color={INK.muted}>
              {S.closedEmpty(options.closedDays)}
            </Text>
          )}
          {cache !== undefined && (
            <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={step('xs', 1)}>
              <Link href={clean(`${section.info.url}/issues?q=is%3Aissue+is%3Aclosed`)} label={S.closedAll} />
              <Text size="caption" color={INK.muted}>
                · {S.closedAsOf(fmtTime(cache.fetchedAt))}
              </Text>
            </Box>
          )}
        </Box>
      </Box>
    )
  }

  /** The rows of a section, in E14's groups when grouping: a caption per group (`bug · 3`), the empty group last. */
  const groupedRows = (section: Section) => {
    const group = state.filter.group
    const parts: RenderElement[] = []
    const planned = planOf.get(section.key)
    for (const found of planned?.groups ?? []) {
      if (group === 'none') {
        parts.push(...found.rows.map(item => row(section, item)))
        continue
      }
      if (found.rows.length === 0) continue
      const name = found.id === '' ? S.groupEmpty[group] : cutText(clean(found.id), 40)
      parts.push(
        <Box key={`group:${section.key}:${found.id === '' ? '-' : found.id}`} flexDirection="column" rowGap={step('xs', 0)}>
          <Box paddingX={step('sm', 1)}>
            <Text size="caption" weight="semibold" color={INK.secondary}>
              {`${name} · ${found.count}`}
            </Text>
          </Box>
          {found.rows.map(item => row(section, item))}
        </Box>,
      )
    }

    return { parts, rest: planned?.rest ?? 0 }
  }

  const sectionBlock = (section: Section) => {
    const label = labelOf(section)
    const isCollapsed = settings.collapsed[section.key] === true
    const isLoading = isStale(section)
    const listed = listedOf(section)
    const shown = shownOf(section)
    const count = shown.length
    const marked = isCollapsed ? shown.filter(item => markOfRow(section, item) !== null).length : 0
    // A filtered list counts its matches, the board facet the rows it keeps (E18-3); the default list E7's count.
    const counted = isLoading ? '…' : !isFiltered(section) && boardFacet === '' && section.total !== undefined && section.total > count ? `${count}/${section.total}` : String(count)
    const header = (
      <Box flexDirection="row" alignItems="center" columnGap={step('sm', 1)} paddingX={step('sm', 1)} paddingY={step('xs', 0)}>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Button key={`section:${section.key}`} plain onPress={() => actions.toggleSection(section.key)}>
            <Text size="caption" color={INK.muted}>
              {isCollapsed ? '▶' : '▼'}
            </Text>{' '}
            <Text weight="semibold">{label}</Text>
            {section.info?.isFork === true ? <Text color={INK.muted}> (fork)</Text> : null}
          </Button>
        </Box>
        {/* E5: a collapsed section says how many of its rows are marked, before its count. */}
        {isCollapsed && marked > 0 && (
          <Box key={`marks:${section.key}`} flexShrink={0}>
            {pill(S.sectionMarks(marked), INK.brand, HUE.brand)}
          </Box>
        )}
        {section.state.kind === 'ok' && (
          <Box key={`count:${section.key}`} flexShrink={0}>
            {pill(counted, count > 0 ? INK.text : INK.muted, HUE.gray)}
          </Box>
        )}
      </Box>
    )
    if (isCollapsed) {
      return (
        <Box key={`sec:${section.key}`} flexDirection="column">
          {header}
        </Box>
      )
    }
    const { parts, rest } = groupedRows(section)

    return (
      <Box key={`sec:${section.key}`} flexDirection="column" rowGap={step('xs', 0)}>
        {header}
        {isLoading ? <Box paddingX={step('sm', 1)}>{note(S.loading(label), INK.muted)}</Box> : stateBlock(section)}
        {consentBlock(section)}
        {listed.length > 0 && shown.length === 0 && <Box paddingX={step('sm', 1)}>{note(S.emptyFiltered(label), INK.muted)}</Box>}
        {parts}
        {rest > 0 && (
          <Text size="caption" color={INK.muted}>
            … +{rest}
          </Text>
        )}
        {pointer(section)}
        {closedBlock(section)}
      </Box>
    )
  }

  // E11: assigned to me -------------------------------------------------------

  /** The rows listed in the pane's sections, collapsed or past the row budget too (E11-4): ↓ Zeigen opens them. */
  const listedKeys = new Set(state.sections.flatMap(section => section.rows.map(item => rowKeyOf(section.key, item.number))))
  const paneRepos = new Set(state.sections.map(section => section.key))

  /**
   * One assigned issue, two lines (E11-7): the title; the repository (cut in the middle) and number, the age and the
   * comments, GitHub ↗, and ↓ Zeigen when a section lists the issue, else + Beobachten when the repository is neither
   * the checkout nor watched. No Work on it: an issue session works in this checkout.
   */
  const inboxRow = (item: InboxRow) => {
    const [owner = '', name = ''] = item.repo.split('/')
    const repoKey = `${item.host}/${owner}/${name}`.toLowerCase()
    const key = rowKeyOf(repoKey, item.number)
    const spec = item.host === 'github.com' ? item.repo : `${item.host}/${item.repo}`
    const isListed = listedKeys.has(key)
    const isWatchable = !isListed && !paneRepos.has(repoKey) && !settings.watch.some(watched => watched.toLowerCase() === spec.toLowerCase())

    return (
      <Box key={`inbox-row:${key}`} flexDirection="column" paddingX={step('sm', 1)} paddingY={step('xs', 0)}>
        <Text weight="semibold" wrap="truncate-end">
          {clean(item.title)}
        </Text>
        <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={step('xs', 1)}>
          <Box flexShrink={1} minWidth={0}>
            <Text size="caption" color={INK.muted} wrap="truncate-middle">
              {clean(`${item.repo}#${item.number}`)}
            </Text>
          </Box>
          <Text size="caption" color={INK.muted}>
            · {shortAgo(item.updatedAt, state.now, S.ago)} · {S.comment(item.commentCount)}
          </Text>
          <Link href={clean(item.url)} label={S.github} />
          {isListed && <Button key={`inbox-show:${key}`} plain label={S.inboxShow} onPress={() => actions.showInSection(key)} />}
          {isWatchable && <Button key={`inbox-watch:${key}`} plain label={S.inboxWatch} onPress={() => actions.addWatch(spec)} />}
        </Box>
      </Box>
    )
  }

  /** E11's section, last: collapsed by default, its header V1's shape (the count pill beside the Button, never in it). */
  const inboxBlock = () => {
    if (!options.assignedToMe) return null
    const box = state.inbox
    const isCollapsed = settings.collapsed['inbox'] !== false
    const failed = box.state.kind === 'ok' || box.state.kind === 'loading' ? null : box.state
    // '…' only before the first answer; a failure with no rows to show is marked, never drawn as loading (B2-BEH-5).
    const isFailedEmpty = failed !== null && box.rows.length === 0
    const counted = box.state.kind === 'loading' ? '…' : isFailedEmpty ? '!' : String(box.rows.length)
    const host = clean(box.host === '' ? 'github.com' : box.host)
    const header = (
      <Box flexDirection="row" alignItems="center" columnGap={step('sm', 1)} paddingX={step('sm', 1)} paddingY={step('xs', 0)}>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Button key="section:inbox" plain onPress={actions.toggleInbox}>
            <Text size="caption" color={INK.muted}>
              {isCollapsed ? '▶' : '▼'}
            </Text>{' '}
            <Text weight="semibold">{S.inboxTitle}</Text>
          </Button>
        </Box>
        <Box key="count:inbox" flexShrink={0}>
          {pill(counted, isFailedEmpty ? INK.warning : box.rows.length > 0 ? INK.text : INK.muted, isFailedEmpty ? HUE.amber : HUE.gray)}
        </Box>
      </Box>
    )
    if (isCollapsed) {
      return (
        <Box key="sec:inbox" flexDirection="column">
          {header}
        </Box>
      )
    }
    const drawn = box.rows.slice(0, plan.left)

    return (
      <Box key="sec:inbox" flexDirection="column" rowGap={step('xs', 0)}>
        {header}
        {failed !== null && (
          <Box flexDirection="column" rowGap={step('xs', 0)} paddingX={step('sm', 1)}>
            {note(stateText(failed), failed.kind === 'error' ? INK.error : INK.warning)}
            {(failed.kind === 'signed-out' || failed.kind === 'token-invalid') && <Code source={S.signInHint(host)} language="bash" />}
          </Box>
        )}
        {box.fetchedAt !== null && box.rows.length === 0 && failed === null && <Box paddingX={step('sm', 1)}>{note(S.inboxEmpty, INK.muted)}</Box>}
        {drawn.map(inboxRow)}
        {box.rows.length >= Math.min(INBOX_CAP, options.maxIssues) && (
          <Box paddingX={step('sm', 1)}>
            <Link href={`https://${host}/issues/assigned`} label={S.inboxAll} />
          </Box>
        )}
        {box.fetchedAt !== null && (
          <Box paddingX={step('sm', 1)}>
            <Text size="caption" color={INK.muted}>
              {S.inboxSearched(fmtTime(box.fetchedAt))}
            </Text>
          </Box>
        )}
      </Box>
    )
  }

  // Footer ---------------------------------------------------------------
  const fetchedAt = state.sections.reduce<number | null>((latest, section) => (section.fetchedAt !== null && (latest === null || section.fetchedAt > latest) ? section.fetchedAt : latest), null)
  const openCount = state.sections.reduce((sum, section) => sum + section.rows.length, 0)
  const shownCount = state.sections.reduce((sum, section) => sum + shownOf(section).length, 0)
  const footerParts: string[] = []
  if (fetchedAt !== null) footerParts.push(S.fetched(fmtTime(fetchedAt)))
  // E14: matches while a filter lists; E18-3: how many of the listed rows the board facet keeps.
  if (boardFacet !== '') footerParts.push(S.shownOf(shownCount, listedCount))
  else if (state.sections.some(isFiltered)) footerParts.push(S.matches(listedCount))
  else footerParts.push(S.openCount(openCount))
  if (options.recaps) footerParts.push(clean(options.recapModel))
  if (state.tokens > 0) footerParts.push(S.tokens(fmtK(state.tokens)))
  const footer = (
    <Box flexDirection="row" alignItems="center" columnGap={step('sm', 1)} paddingX={step('xs', 0)} paddingY={step('xs', 0)} marginTop={isRich ? 0 : 1}>
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Text size="caption" color={state.isRefreshing ? INK.brand : INK.secondary} wrap="truncate-end">
          {state.isRefreshing ? `${S.refreshing} · ` : ''}
          {footerParts.join(' · ')}
        </Text>
      </Box>
      <Text size="caption" color={INK.muted}>
        issue-radar{state.version === '' ? '' : ` v${clean(state.version)}`}
      </Text>
    </Box>
  )

  return (
    <Box flexDirection="column" minHeight={isRich ? Math.max(1, state.rows - 0.1) : undefined}>
      {titleBar}
      {hairline()}
      {filterLine}
      {filterPanel}
      {settingsPanel}
      <Box flexDirection="column" flexGrow={1} paddingY={step('sm', 0)} rowGap={step('sm', 0)}>
        {state.sections.length === 0 ? (
          <Box paddingX={step('sm', 1)}>
            <Text color={INK.secondary}>{S.loading('…')}</Text>
          </Box>
        ) : (
          state.sections.map(sectionBlock)
        )}
        {inboxBlock()}
      </Box>
      {hairline()}
      {footer}
    </Box>
  )
}
