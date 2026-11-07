// Issue Radar: the open GitHub issues of the session's repository in a pane,
// and one click that starts a dedicated session per issue. The hooks module:
// the pane, the commands, the refresh pipeline, the hand-off. `$.ui.status`
// has one owner, the issue session's status line (E12); nothing else sets it.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import type { Boards, ClosedCache, Filter, Glimpse, Inbox, IssueDetails, IssueMeta, IssueRow, Language, Mapping, Options, PrRecord, Recap, RepoCache, RepoInfo, RepoSettings, RepoState, Section, SeenRecord, Triage } from '../types'
import { MARKER, branchName, renderBackground, renderBrief, sessionName, sessionTitle, spikeBrief } from './brief'
import { asClosedCache, closedRecord, isClosedDue, listClosed, sinceDate } from './closed'
import type { ClosedReason } from './closed'
import { DEFAULT_FILTER, MAX_VIEWS, TYPED_CHARS, asSavedViews, cleanViewName, cutText, effectiveQuery, facetsOf, filterKey, metaBound, retainMeta, sameFacets, sanitizeQuery, viewIdOf } from './filter'
import { dropRelations, firstLine, isRepoSpec, listIssues, metaOf, repoKey, repoLabel, resetRelations, resolveCheckout, resolveNamed, stateOf, viewIssue, viewParent } from './github'
import { MAPPED_MAX, PROBE_MAX, PROBE_PAUSE_MS, fetchBoards, fetchPrLinks } from './graph'
import { asLanguage, strings } from './i18n'
import { INBOX_CAP, asInboxCache, failedInbox, inboxFromRecord, inboxPeriod, isInboxDue, searchAssigned } from './inbox'
import { ARRIVAL_TOAST_MS, LOOK_THROTTLE_MS, MARK_HOLD_MS, SEEN_KEEP_FACTOR, arrivalText, arrivalsOf, cardRowsOf, foldFaded, isFilteredList, markOf, nextFade, paneLayout, readSeen, rowKeyOf, rowsInView, seenRecordOf, unreadCount, withRow } from './marks'
import type { PaneLike, RowTop } from './marks'
import { asRecord, isPrsDue, mergeLinks, recordOf } from './prs'
import { RECAP_VERSION, asRecap, isBetterRecap, isRecapCurrent, isRecapFor, isRecapUsable, recapIssue } from './recap'
import { commandConsent, detachSession, focusSession, lookUpSession, parseObject, pressConsent, quietDesktop, readPrStatus, routeInUse, startDesktopSession } from './session'
import { clean } from './text'
import { probeEngaged, runTiers } from './tiers'
import { offerToast, takeToast } from './toasts'
import { renderPane } from './view'

const PLUGIN = 'issue-radar'
const PANE = 'issue-radar'
const PANE_COLUMNS = 46
const DETAILS_CONCURRENCY = 2
const STORE_PREFIXES = ['cache:', 'recaps:', 'session:', 'settings:', 'debug:', 'prs:', 'inbox:', 'closed:', 'seen:'] as const
/** E9: how many recaps of an older version (or language) a refresh redoes at most, the rows drawn first (C-E9-2). */
const BACKFILL_PER_REFRESH = 5
/** E9: how long a row whose recap redo failed waits before the backfill (or its opened row) asks again (B3-BEH-4). */
const REDO_RETRY_MS = 60 * 60_000
/** E4: how many rows' details (their comments) a refresh reads for the hover cards at most, while the pane is shown. */
const CARD_WARM_PER_REFRESH = 2
/** E4: how long a row whose warm-up read failed waits before it is read again, unless the issue changes (R3-RT-2). */
const WARM_RETRY_MS = 30 * 60_000
/** E5: a scroll counts as a look once the window rests this long, so a wheel's ticks make one look at where it stopped. */
const SCROLL_LOOK_MS = 400
/** E5-c: a comment of the owner's this close to an issue's last update made that update: no news to them. */
const OWN_ACTIVITY_MS = 120_000
/** E5: at most this many issue numbers per repository the session remembers as listed. */
const LISTED_KEEP = 1_000
/** E18: the shortest gap between two board reads of the same rows that the timer, a tool or a re-run asks for. */
const BOARDS_MIN_MS = 60_000
/** E11: how long a scroll to a row the press just opened waits before its one retry (E11-5). */
const SCROLL_RETRY_MS = 250
/** How often a mapped issue session's pull request is read from the app while it answers (E3). */
const SESSION_PR_EVERY_MS = 60_000
/** How long one session's pull-request read waits after the app did not answer it, or answered with an error (E3-1). */
const SESSION_PR_BACKOFF_MS = 10 * 60_000
/** The texts of a schema that lacks what the pull-request request asks (an older GitHub Enterprise): no more tries there. */
const SCHEMA_REFUSAL = /doesn't accept argument|doesn't exist on type|undefined ?field|unknown argument|cannot query field/i
/** The fields only E3's Links fragment asks: a refusal that names one, in a request that mixes fragments, is E3's. */
const PR_FIELD = /\b(?:closedByPullRequestsReferences|reviewDecision|statusCheckRollup|isDraft)\b/
const DEFAULT_SETTINGS: RepoSettings = { watch: [], consent: {}, collapsed: {} }
/** The first characters of a brief: what tells this session's own fills from a hand-off. */
const BRIEF_HEAD = 80
/** The shortest timer period, whatever the setting says. */
const MIN_PERIOD_MS = 30_000

// Change a tag when the stored value's fields change: an earlier version's
// value is then read as the initial instead of in the wrong shape.
const sections = atom({ plugin: 'issue-radar', key: 'sections' } as const, [], { shape: 'sections-1' })
const details = atom({ plugin: 'issue-radar', key: 'details' } as const, {}, { shape: 'details-1' })
const recaps = atom({ plugin: 'issue-radar', key: 'recaps' } as const, {}, { shape: 'recaps-1' })
const mappings = atom({ plugin: 'issue-radar', key: 'mappings' } as const, {}, { shape: 'mappings-1' })
const settings = atom({ plugin: 'issue-radar', key: 'settings' } as const, DEFAULT_SETTINGS, { shape: 'settings-1' })
const opened = atom({ plugin: 'issue-radar', key: 'opened' } as const, '')
const starting = atom({ plugin: 'issue-radar', key: 'starting' } as const, {})
const isRefreshing = atom({ plugin: 'issue-radar', key: 'isRefreshing' } as const, false)
const isSettingsOpen = atom({ plugin: 'issue-radar', key: 'isSettingsOpen' } as const, false)
const tokens = atom({ plugin: 'issue-radar', key: 'tokens' } as const, 0)
const version = atom({ plugin: 'issue-radar', key: 'version' } as const, '')
const checkoutKey = atom({ plugin: 'issue-radar', key: 'checkoutKey' } as const, '')
const isIssueSession = atom({ plugin: 'issue-radar', key: 'isIssueSession' } as const, false)
const route = atom({ plugin: 'issue-radar', key: 'route' } as const, 'none')
const prs = atom({ plugin: 'issue-radar', key: 'prs' } as const, {}, { shape: 'prs-1' })
const sessionPrs = atom({ plugin: 'issue-radar', key: 'sessionPrs' } as const, {}, { shape: 'sessionprs-1' })
const NO_BOARDS: Boards = { scope: {}, needs: {}, detail: {}, items: {}, fetchedAt: null }
const NO_INBOX: Inbox = { host: '', state: { kind: 'loading' }, rows: [], fetchedAt: null }
const filter = atom({ plugin: 'issue-radar', key: 'filter' } as const, DEFAULT_FILTER, { shape: 'filter-1' })
const isFilterOpen = atom({ plugin: 'issue-radar', key: 'isFilterOpen' } as const, false)
const facets = atom({ plugin: 'issue-radar', key: 'facets' } as const, { labels: [], milestones: [] }, { shape: 'facets-1' })
const searchGen = atom({ plugin: 'issue-radar', key: 'searchGen' } as const, 0)
const boards = atom({ plugin: 'issue-radar', key: 'boards' } as const, NO_BOARDS, { shape: 'boards-1' })
const inbox = atom({ plugin: 'issue-radar', key: 'inbox' } as const, NO_INBOX, { shape: 'inbox-1' })
const closed = atom({ plugin: 'issue-radar', key: 'closed' } as const, {}, { shape: 'closed-1' })
const closedLoading = atom({ plugin: 'issue-radar', key: 'closedLoading' } as const, {})
const closedErrors = atom({ plugin: 'issue-radar', key: 'closedErrors' } as const, {}, { shape: 'closederrors-1' })
const seenBase = atom({ plugin: 'issue-radar', key: 'seenBase' } as const, {}, { shape: 'seenbase-1' })
const glimpsed = atom({ plugin: 'issue-radar', key: 'glimpsed' } as const, {}, { shape: 'glimpsed-1' })
const listed = atom({ plugin: 'issue-radar', key: 'listed' } as const, {}, { shape: 'listed-1' })

// Module state: lost on a hot reload, which is fine, since the next refresh rebuilds it.
let timer: Timer | undefined
let timerMinutes = 0
let isRunning = false
/** The reason of the refresh asked for while one ran (the strongest, when several were); it runs once that one ends. */
let queuedReason: Reason | null = null
let delayed: Timer | undefined
/** The reason the pending `delayed` refresh will run with; a later `schedule` keeps the stronger of both. */
let delayedReason: Reason | null = null
/** Whether the first refresh has decided about opening the pane. */
let paneDecided = false
/** Whether the pane is up on the mod's or the owner's initiative, so an attach places it again. */
let wantsPane = false
let checkout: { root: string; info: RepoInfo | null; state: RepoState } | null = null
const named = new Map<string, { info: RepoInfo | null; state: RepoState }>()
const backoffUntil = new Map<string, number>()
let settingsKey: string | null = null
let myId = ''
/** Rows whose "Work on it" is in flight, claimed synchronously so a double press starts one session. */
const inFlight = new Set<string>()
/**
 * Mappings of sessions this pane started whose store write was refused (a full store): the store is otherwise the
 * only memory of a mapping (A 6c), and without this a press would start a second session for the issue. Each refresh
 * writes them again; the store wins as soon as it holds a mapping for the row.
 */
const unsaved = new Map<string, Mapping>()
/** The heads of the briefs this session put into its own prompt box: sending one does not make this an issue session. */
const ownBriefs = new Set<string>()
/** E7: until when an unclassified failure pauses a repository's probe (the V1 list runs meanwhile). */
const probeOffUntil = new Map<string, number>()
/** E3: when each repository's pull-request states were last asked for, answered or not (a failure waits a full interval, E3-2). */
const prTriedAt = new Map<string, number>()
/** E3: hosts whose schema refused the pull-request fields; their rows keep gh's stateless links. */
const prsOffHosts = new Set<string>()
/** E3: the failure kinds already logged, once each per module lifetime. */
const prFailuresLogged = new Set<string>()
/** E3: when each mapped session's pull request may be read from the app again (per session, never the whole layer, E3-1). */
const sessionPrNext = new Map<string, number>()
let isReadingSessionPrs = false
let hasLoggedStatusRaw = false
/**
 * E3 for filtered sections (E14): their rows' pull-request states, read as the default list's are but kept in this
 * module only, per section and query. `prs:<repoKey>` serves the default list and is never written from a filter.
 */
const filteredPrs = new Map<string, { query: string; record: PrRecord }>()
const filteredPrTried = new Map<string, { query: string; at: number }>()
/** E18: when each section's board items were last asked, and for which rows. */
const boardsReadAt = new Map<string, { at: number; rows: string }>()
/**
 * E22: each repository's step that reads its closed part, claimed before its first wait, so a press and a refresh
 * never both fetch it; a reload clears it, unlike a flag in `$.state` (E22-1).
 */
const closedInFlight = new Set<string>()
/** E22: until when a repository's closed list waits after a rate limit or no network. */
const closedBackoff = new Map<string, number>()
/** E22: when each repository's closed list was last asked, answered or not, and for which window: a failure waits as a read does (E3-2). */
const closedTriedAt = new Map<string, { at: number; since: string }>()
/** E22: repositories an issue just left (a complete list lost it, or Work on it found it closed): read again after 30 s. */
const closedNudge = new Set<string>()
/** E5: when the next mark fades (the drawing and the title follow); a reload loses it and the next refresh arms it again. */
let fade: Timer | undefined
/** E5: the look a scroll makes once the window rests. */
let scrollLook: Timer | undefined
/** E5: where the pane's window stands, as the last drawing or scroll said: what a look covers, where the cards go. */
let viewport = { offset: 0, bodyRows: 24, columns: PANE_COLUMNS }
/** E5: the rows looks covered that wait for their repository's next seen-record write (at most one per 15 s each). */
const pendingSeen = new Map<string, Map<number, IssueRow>>()
/** E5: the repositories whose pending rows a look in a filtered list (E14) covered: their write leaves `newest` (R3-INT-1). */
const pendingFiltered = new Set<string>()
/** E5: when this session last wrote each repository's seen record for a look. */
const seenWrittenAt = new Map<string, number>()
let seenFlush: Timer | undefined
/** E5: the seen records' store writes, one after another, so a look and an acknowledgement never interleave a read and a write. */
let seenChain: Promise<void> = Promise.resolve()
/** E5-5: a retitle that unplaced the pane stops retitling for the session. */
let retitleOff = false
/**
 * E9: the rows whose recap redo (the backfill's, or an opened row's) failed, at which update and in which language, and
 * when: their working recap stays, and nothing asks again for an hour (B3-BEH-4); a reload or the next session retries.
 */
const redoFailed = new Map<string, { updatedAt: string; language: Language; at: number }>()
/** E4: the rows whose warm-up read failed, at which update and when: not read again for half an hour (R3-RT-2). */
const warmFailed = new Map<string, { updatedAt: string; at: number }>()

type Resolved = { spec: string; info: RepoInfo | null; state: RepoState; isCheckout: boolean }
/**
 * Why a refresh runs: the session's start, the timer, the owner's ↻ (`press`, nothing else), a re-run the mod asks
 * for itself (`manual`: a consent, a watch change, a reset, a command, a state block's retry), or a tool or an attach.
 */
type Reason = 'start' | 'timer' | 'press' | 'manual' | 'tool'

/** How much a reason asks for: a queued or merged refresh runs with the strongest reason it stands for. */
const REASON_RANK: Record<Reason, number> = { timer: 0, tool: 1, start: 2, manual: 3, press: 4 }

function strongerReason(a: Reason | null, b: Reason): Reason {
  return a !== null && REASON_RANK[a] >= REASON_RANK[b] ? a : b
}

function readOptions(given: PluginOptions): Options {
  const parse = (key: string) => {
    const value = given[key]

    return typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  }
  const num = (key: string, fallback: number) => {
    const parsed = parse(key)

    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
  }
  // E22: every number is clamped to 0–90, a negative one to 0 (hidden); only a missing or non-numeric value means 7 (B2-BEH-6).
  const days = parse('closedDays')
  const flag = (key: string, fallback: boolean) => (typeof given[key] === 'boolean' ? (given[key] as boolean) : fallback)
  const model = typeof given['recapModel'] === 'string' && (given['recapModel'] as string).trim() !== '' ? (given['recapModel'] as string).trim() : 'haiku'

  return {
    openAtStart: flag('openAtStart', true),
    refreshMinutes: num('refreshMinutes', 3),
    maxIssues: Math.max(1, Math.round(num('maxIssues', 30))),
    recaps: flag('recaps', true),
    recapModel: model,
    language: asLanguage(given['language']) as Language,
    closedDays: Number.isFinite(days) ? Math.max(0, Math.min(90, Math.round(days))) : 7,
    assignedToMe: flag('assignedToMe', false),
    hoverCards: flag('hoverCards', true),
    arrivalToasts: flag('arrivalToasts', true),
  }
}

function storeKeyOf(prefix: (typeof STORE_PREFIXES)[number], key: string): string {
  return `${prefix}${key}`
}

async function readStore<T>($: EngineInterface, key: string): Promise<T | undefined> {
  const value = await $.store.get(key).catch(() => undefined)

  return value === undefined || value === null ? undefined : (value as T)
}

/** Writes one store key; false when the store refused it (a store past 4 MiB of JSON), which is logged and otherwise borne. */
async function writeStore($: EngineInterface, key: string, value: unknown): Promise<boolean> {
  try {
    await $.store.set(key, value)

    return true
  } catch (error) {
    $.ui.log(`${PLUGIN}: store write failed for ${key}: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })

    return false
  }
}

/**
 * The settings as stored, rebuilt field by field, each one missing or of the wrong type at its default; a stored spec
 * is checked again before it reaches gh. The optional fields (E14's views, E18's boards, E22's expanded parts) are
 * kept only when they say something, so a V1 record stays as it was.
 */
function readSettings(stored: unknown): RepoSettings {
  const value = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {}
  const watch = Array.isArray(value['watch']) ? (value['watch'] as unknown[]).filter((spec): spec is string => typeof spec === 'string' && isRepoSpec(spec)) : []
  const record = (key: string): Record<string, boolean> => {
    const given = value[key]
    if (typeof given !== 'object' || given === null) return {}

    return Object.fromEntries(Object.entries(given as Record<string, unknown>).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'))
  }
  const settled: RepoSettings = { watch, consent: record('consent'), collapsed: record('collapsed') }
  const views = asSavedViews(value['views'])
  if (views.length > 0) settled.views = views
  if (value['boards'] === true) settled.boards = true
  const showClosed = Object.fromEntries(Object.entries(record('showClosed')).filter(([, isShown]) => isShown))
  if (Object.keys(showClosed).length > 0) settled.showClosed = showClosed

  return settled
}

async function loadVersion($: EngineInterface): Promise<void> {
  const manifest = await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`).catch(() => '')
  const stated = /"version"\s*:\s*"([^"]+)"/.exec(manifest)?.[1]
  if (stated !== undefined) await update($, version, () => stated)
}

/** A stored mapping as the mod can use it; anything without a session id is no mapping. */
function asMapping(value: unknown): Mapping | undefined {
  return typeof value === 'object' && value !== null && typeof (value as { sessionId?: unknown }).sessionId === 'string' ? (value as Mapping) : undefined
}

/**
 * Every issue → session mapping in the store, and those this pane could not write there, mirrored into the state. Run
 * at the session's start and on every refresh: another pane (or this project's issue session) may have written or
 * released one since (A 6c).
 */
async function loadMappings($: EngineInterface): Promise<Record<string, Mapping>> {
  const keys = await $.store.keys().catch(() => [] as string[])
  const found: Record<string, Mapping> = {}
  for (const key of keys) {
    if (!key.startsWith('session:')) continue
    const value = asMapping(await readStore<unknown>($, key))
    if (value !== undefined) found[key.slice('session:'.length)] = value
  }
  // A mapping the store refused stays this pane's, and is written again, until the store holds one for its row.
  for (const [rowKey, mapping] of unsaved) {
    if (found[rowKey] === undefined) {
      found[rowKey] = mapping
      if (!(await writeStore($, storeKeyOf('session:', rowKey), mapping))) continue
    }
    unsaved.delete(rowKey)
  }
  await update($, mappings, current => {
    const next = { ...found }
    // A press in flight owns its row: it writes the store and then the state, and a read between the two must not undo it.
    for (const rowKey of inFlight) {
      const mine = current[rowKey]
      if (mine === undefined) delete next[rowKey]
      else next[rowKey] = mine
    }

    return next
  })

  return found
}

/** One row's mapping, read from the store for a click (else the one the store refused) and mirrored into the state, so a press never acts on a stale copy. */
async function reloadMapping($: EngineInterface, rowKey: string): Promise<Mapping | undefined> {
  const stored = asMapping(await readStore<unknown>($, storeKeyOf('session:', rowKey)))
  if (stored !== undefined) unsaved.delete(rowKey)
  const mapping = stored ?? unsaved.get(rowKey)
  await update($, mappings, current => {
    const next = { ...current }
    if (mapping === undefined) delete next[rowKey]
    else next[rowKey] = mapping

    return next
  })

  return mapping
}

async function saveMapping($: EngineInterface, rowKey: string, mapping: Mapping | null): Promise<void> {
  const key = storeKeyOf('session:', rowKey)
  if (mapping === null) {
    unsaved.delete(rowKey)
    await $.store.delete(key).catch(() => undefined)
  } else if (await writeStore($, key, mapping)) unsaved.delete(rowKey)
  else unsaved.set(rowKey, mapping)
  await update($, mappings, current => {
    const next = { ...current }
    if (mapping === null) delete next[rowKey]
    else next[rowKey] = mapping

    return next
  })
  // A released mapping, or one now naming another session, takes the pull request the app reported for the old one along (E3).
  await update($, sessionPrs, current => {
    const had = current[rowKey]
    if (had === undefined || (mapping !== null && had.sessionId === mapping.sessionId)) return current
    const next = { ...current }
    delete next[rowKey]

    return next
  })
}

/** Applies a change to the stored settings, read fresh so another pane's writes on the same repository survive, and mirrors the result into the state. */
async function saveSettings($: EngineInterface, change: (current: RepoSettings) => RepoSettings): Promise<RepoSettings> {
  const key = settingsKey
  const current = key === null || key === '' ? await read($, settings) : readSettings(await readStore<unknown>($, storeKeyOf('settings:', key)))
  const next = change(current)
  await update($, settings, () => next)
  if (key !== null && key !== '') await writeStore($, storeKeyOf('settings:', key), next)

  return next
}

/** What the pane draws from, as the atoms hold it: the rows a drawing holds and where they sit follow from it (marks.ts). */
async function paneState($: EngineInterface, options: Options): Promise<PaneLike> {
  const chosen = await read($, settings)
  const activeFilter = await read($, filter)

  return {
    sections: await read($, sections),
    settings: chosen,
    filter: activeFilter,
    filterKey: filterKey(activeFilter, chosen.views ?? []),
    boards: await read($, boards),
    closed: await read($, closed),
    options,
    opened: await read($, opened),
    recaps: await read($, recaps),
    details: await read($, details),
    mappings: await read($, mappings),
    isFilterOpen: await read($, isFilterOpen),
    isSettingsOpen: await read($, isSettingsOpen),
    columns: viewport.columns,
  }
}

/** Whether every surface the session has is the desktop: the title count is shown there only (E5-5; a terminal retitle could unplace the pane). */
async function isDesktopOnly($: EngineInterface): Promise<boolean> {
  const surfaces = await $.session.surfaces().catch(() => [])

  return surfaces.some(surface => surface === 'desktop') && !surfaces.some(surface => surface === 'terminal')
}

/**
 * The pane's title, the one composer of it: every open goes through here (`openPane`, the command, the attach), since
 * an open of the same id retitles, and a re-open with a bare title would drop the count. On the desktop it carries
 * E5's count of marked rows, `Issues (2)`; the engine draws it as the tab's label while more than one pane is open,
 * which is why the count also sits in the pane's own title bar.
 */
async function paneTitle($: EngineInterface, options: Options): Promise<string> {
  const S = strings(options.language)
  if ((await read($, isIssueSession)) || !(await isDesktopOnly($))) return S.title
  const base = await read($, seenBase)
  // No row marked against its baseline: no count, and no need to lay the pane out.
  const isMarked = (await read($, sections)).some(section => base[section.key] !== undefined && section.rows.some(row => markOf(row, base[section.key], isFilteredList(section)) !== null))
  if (!isMarked) return S.title
  const { plan } = paneLayout(await paneState($, options))

  return S.titleWithCount(unreadCount(plan, base, await read($, glimpsed), await $.clock.now()))
}

/**
 * Retitles the pane when its count changed (E5): only an open, placed pane (opening a closed id would reopen it), only
 * on the desktop (E5-5), never with `focus`. A retitle that unplaced a pane stops retitling for the session.
 */
async function syncTitle($: EngineInterface, options: Options): Promise<void> {
  if (retitleOff) return
  const pane = (await $.ui.panes().catch(() => [])).find(found => found.id === PANE)
  if (pane === undefined || !pane.isPlaced || !(await isDesktopOnly($))) return
  const title = await paneTitle($, options)
  if (pane.title === title) return
  const placed = await $.ui.open({ id: PANE, title, columns: PANE_COLUMNS }).catch(() => null)
  if (placed !== null && !placed.isPlaced) {
    retitleOff = true
    $.ui.log(`${PLUGIN}: retitling the pane unplaced it (${placed.reason}); the count stays in the pane's title bar`, { to: 'debug' })
  }
}

async function openPane($: EngineInterface, options: Options, isLoud: boolean): Promise<void> {
  const S = strings(options.language)
  const placed = await $.ui.open({ id: PANE, title: await paneTitle($, options), columns: PANE_COLUMNS }).catch(() => null)
  if (placed === null) return
  wantsPane = true
  if (!placed.isPlaced) $.ui.log(`${PLUGIN}: ${S.paneWaits(placed.reason)}`, isLoud ? undefined : { to: 'debug' })
}

async function isPaneShown($: EngineInterface): Promise<boolean> {
  const panes = await $.ui.panes().catch(() => [])

  return panes.some(pane => pane.id === PANE && pane.isShown)
}

/**
 * Whether work the mod starts on its own (the timer, a background fetch, tracking) may run now: only while the
 * pane is SHOWN, not merely open (undrawn before the desktop attaches, on a narrow terminal, on vscode or mobile, or
 * behind another tab), and never inside an issue session (D X-1).
 */
async function mayRunInBackground($: EngineInterface): Promise<boolean> {
  return !(await read($, isIssueSession)) && (await isPaneShown($))
}

/**
 * Whether the owner is typing in the pane: an inline editor or a form with an Input is open. Timed refreshes wait
 * while it holds, so a redraw never races the typing (F X-1). The pane has no such editor yet (the watch field of
 * the settings panel draws no value and keeps its text across redraws); the editors that come add their atoms here.
 */
async function isEditing($: EngineInterface): Promise<boolean> {
  return false
}

async function isPaneOpen($: EngineInterface): Promise<boolean> {
  const panes = await $.ui.panes().catch(() => [])

  return panes.some(pane => pane.id === PANE)
}

/** The surfaces that draw no pane: no fetch and no model call there. */
async function surfacesAllowPane($: EngineInterface): Promise<boolean> {
  const surfaces = await $.session.surfaces().catch(() => [])

  return surfaces.length === 0 || surfaces.some(surface => surface === 'desktop' || surface === 'terminal')
}

function armTimer($: EngineInterface, options: Options): void {
  if (timer !== undefined && timerMinutes === options.refreshMinutes) return
  timer?.cancel()
  timer = undefined
  timerMinutes = options.refreshMinutes
  if (options.refreshMinutes <= 0) return
  timer = $.clock.every(Math.max(MIN_PERIOD_MS, Math.round(options.refreshMinutes * 60_000)), () => {
    void (async () => {
      if ((await mayRunInBackground($)) && !(await isEditing($))) await refresh($, options, 'timer')
    })()
  })
}

/** Stops everything the mod does on its own inside an issue session; /issue-radar may start it again. */
function standDown(): void {
  wantsPane = false
  paneDecided = true
  delayed?.cancel()
  delayed = undefined
  delayedReason = null
  timer?.cancel()
  timer = undefined
  timerMinutes = 0
}

/** Runs a refresh after `delayMs`; a refresh already pending is replaced, and the new one keeps the stronger reason of both. */
function schedule($: EngineInterface, options: Options, delayMs: number, reason: Reason = 'manual'): void {
  delayed?.cancel()
  const merged = strongerReason(delayedReason, reason)
  delayedReason = merged
  delayed = $.clock.after(delayMs, () => {
    delayedReason = null
    void refresh($, options, merged)
  })
}

/** Shows the refresh's one toast: the best offer its steps made (failure before a proposal before arrivals). */
function flushToasts($: EngineInterface): void {
  const offer = takeToast()
  if (offer === null) return
  $.ui.toast(clean(offer.text), offer.timeoutMs === undefined ? undefined : { timeoutMs: offer.timeoutMs })
}

async function resolveTargets($: EngineInterface, root: string, watch: readonly string[], reason: Reason): Promise<Resolved[]> {
  // The refresh resolved the checkout a moment ago (a failed resolution is tried again on every refresh, so Retry and ↻
  // recover); resolving a failure again here would cost a second gh call and hide the state the refresh just read.
  if (checkout === null || checkout.root !== root) checkout = { root, ...(await resolveCheckout($, root)) }
  const targets: Resolved[] = [
    { spec: checkout.info === null ? root : repoLabel(checkout.info), info: checkout.info, state: checkout.state, isCheckout: true },
  ]
  for (const spec of watch) {
    const cached = named.get(spec)
    // A resolved repository is remembered for the session; a failure only until the next explicit
    // refresh, so Retry and the header's refresh ask gh again while the timer does not.
    const seen = cached !== undefined && (cached.info !== null || reason === 'timer') ? cached : undefined
    const resolved = seen ?? (await resolveNamed($, spec))
    if (seen === undefined && (resolved.info !== null || resolved.state.kind === 'no-access' || resolved.state.kind === 'issues-disabled' || resolved.state.kind === 'archived')) {
      named.set(spec, resolved)
    }
    targets.push({ spec, info: resolved.info, state: resolved.state, isCheckout: false })
  }

  return targets
}

/** Seeds the session's details from the store's small per-issue meta, so unchanged issues need no details call. */
function seededDetails(meta: IssueMeta | undefined): IssueDetails | undefined {
  if (meta === undefined) return undefined

  return { updatedAt: meta.updatedAt, state: 'OPEN', commentCount: meta.commentCount, comments: [], excerpt: meta.excerpt, body: '', linkedPrs: meta.linkedPrs, fetchedAt: 0 }
}

/** Details or a recap are current while they are at least as new as the row (ISO times compare as text). */
function isCurrent(have: { updatedAt: string } | undefined, row: IssueRow): boolean {
  return have !== undefined && have.updatedAt >= row.updatedAt
}

/** V1's back-off after a failed list, shared by E7's tiers and E3's request: ten minutes after a rate limit, two offline. */
function backoffFor(key: string, state: RepoState, now: number): void {
  if (state.kind === 'rate-limited') backoffUntil.set(key, now + 10 * 60_000)
  else if (state.kind === 'offline') backoffUntil.set(key, now + 2 * 60_000)
}

function newest(times: readonly string[]): string {
  return times.reduce((latest, time) => (time > latest ? time : latest), '')
}

/** What E7's tiers made of a repository's timed refresh: the section, its meta, tier 2's details and the PR record. */
type Probed = { section: Section; meta: Record<string, IssueMeta>; details: Map<number, IssueDetails>; record: PrRecord | undefined; log: Record<string, unknown> }

/**
 * E7 for one repository: the probe, and tier 2 when it found changes, in place of V1's list. Null when an unclassified
 * failure paused the probe: the refresh then lists as V1 does, so the pane never shows less than V1. A classified
 * failure keeps the last rows under its state and backs off as a failed list does. A mapped issue the probe found
 * closed or gone is released, which V1's pruning cannot do for a capped list.
 */
async function probeSection($: EngineInterface, options: Options, target: Resolved, info: RepoInfo, sectionKey: string, cache: RepoCache, before: Section | undefined, now: number, withLinks: boolean): Promise<Probed | null> {
  const all = await read($, mappings)
  const mapped = Object.entries(all)
    .filter(([rowKey]) => rowKey.startsWith(`${sectionKey}#`))
    .sort(([, a], [, b]) => a.startedAt - b.startedAt)
    .map(([rowKey]) => Number(rowKey.slice(sectionKey.length + 1)))
    .filter(number => Number.isInteger(number) && number > 0)
    .slice(0, MAPPED_MAX)
  const hasPrFields = !prsOffHosts.has(info.host)
  const outcome = await runTiers($, { info, first: Math.min(PROBE_MAX, options.maxIssues), cache, mapped, withLinks, hasPrFields, now })
  for (const number of outcome.released) await saveMapping($, rowKeyOf(sectionKey, number), null)
  // A probe that asked the pull requests and did not bring them counts as a failed try of them (E3-2).
  if (withLinks && outcome.kind !== 'done') prTriedAt.set(sectionKey, now)
  if (outcome.kind === 'paused') {
    probeOffUntil.set(sectionKey, now + PROBE_PAUSE_MS)
    if (outcome.isRelations) dropRelations(info)
    // The probe's Links, or tier 2's, refused by the schema: the host's pull-request states are given up, as a refused
    // IssueRadarPrs gives them up, so later probes ask without them and patches read the window instead.
    if (refusesPrFields(outcome.state)) prsOffHosts.add(info.host)
    $.ui.log(`${PLUGIN}: the probe of ${sectionKey} pauses for 30 minutes: ${outcome.state.detail ?? outcome.state.kind}`, { to: 'debug' })

    return null
  }
  const base = { key: sectionKey, spec: target.spec, info, isCheckout: target.isCheckout }
  if (outcome.kind === 'failed') {
    backoffFor(sectionKey, outcome.state, now)
    const total = before?.total ?? cache.total
    const section: Section = { ...base, state: outcome.state, rows: before?.rows ?? cache.rows, fetchedAt: before?.fetchedAt ?? cache.fetchedAt, ...(total === undefined ? {} : { total }) }

    return { section, meta: cache.meta ?? {}, details: new Map(), record: undefined, log: { plan: 'failed', state: outcome.state.kind, links: withLinks } }
  }
  // E14-1: beyond the window the store keeps the most recently shown issues' meta, which a filter may show again.
  const isWhole = outcome.rows.length < options.maxIssues && outcome.total <= outcome.rows.length
  const meta = retainMeta({ ...(cache.meta ?? {}), ...outcome.meta }, new Set(outcome.rows.map(row => String(row.number))), isWhole, metaBound(options.maxIssues), now)
  const written: RepoCache = { fetchedAt: now, rows: outcome.rows, meta, total: outcome.total }
  await writeStore($, storeKeyOf('cache:', sectionKey), written)
  backoffUntil.delete(sectionKey)
  let record: PrRecord | undefined
  if (outcome.links !== null) {
    prTriedAt.set(sectionKey, now)
    // The signed-in account the probe named (E5), else the one the last record kept.
    const viewer = outcome.viewer ?? asRecord(await readStore<unknown>($, storeKeyOf('prs:', sectionKey)))?.viewer ?? null
    record = recordOf(outcome.links, outcome.asOf, now, viewer)
  }
  if (outcome.patchedLinks.size > 0) {
    const stored = record ?? asRecord(await readStore<unknown>($, storeKeyOf('prs:', sectionKey)))
    // Tier 2's pull requests refresh a record a sweep made; alone they would make a partial one look fresh.
    if (stored !== undefined) record = mergeLinks(stored, outcome.patchedLinks, outcome.patchedAsOf)
  }
  if (record !== undefined) await writeStore($, storeKeyOf('prs:', sectionKey), record)
  const section: Section = { ...base, state: { kind: 'ok' }, rows: outcome.rows, fetchedAt: now, total: outcome.total }

  return { section, meta, details: outcome.details, record, log: { plan: outcome.plan, cost: outcome.cost, remaining: outcome.remaining, links: outcome.links !== null } }
}

/** The pull-request record a filtered section read for its own query (E14); undefined before it read one. */
function filteredRecordOf(section: Section): PrRecord | undefined {
  const own = section.query === undefined ? undefined : filteredPrs.get(section.key)

  return own !== undefined && own.query === section.query ? own.record : undefined
}

/**
 * E14: one repository's filtered list, gh's search with the filter's query as one argument, in GitHub's order. It is
 * never written to the store's list (`cache:` stays the default list's) and never prunes it. A timed refresh keeps
 * the rows this pane listed for the same query less than 0.9 periods ago, or while a back-off holds; a failure keeps
 * them under its state.
 */
async function listFiltered($: EngineInterface, options: Options, target: Resolved, info: RepoInfo, sectionKey: string, before: Section | undefined, query: string, listKey: string | undefined, reason: Reason, now: number, freshFor: number): Promise<Section> {
  const same = before?.query === query ? before : undefined
  const until = backoffUntil.get(sectionKey) ?? 0
  if (reason === 'timer' && same !== undefined && (now < until || (same.fetchedAt !== null && now - same.fetchedAt < freshFor))) return same
  const base = { key: sectionKey, spec: target.spec, info, isCheckout: target.isCheckout, query, ...(listKey === undefined ? {} : { filterKey: listKey }) }
  const listed = await listIssues($, info, options.maxIssues, query)
  if ('state' in listed) {
    backoffFor(sectionKey, listed.state, now)

    return { ...base, state: listed.state, rows: same?.rows ?? [], fetchedAt: same?.fetchedAt ?? null }
  }
  backoffUntil.delete(sectionKey)

  return { ...base, state: { kind: 'ok' }, rows: listed.rows, fetchedAt: now }
}

/**
 * Mirrors each listed repository's stored pull-request record into the state (another pane may have read it since),
 * the ones this refresh read taking precedence, and drops the records of repositories no longer listed. A filtered
 * section draws the record its own query read, and the default list's stored one until it has read it.
 */
async function loadPrCache($: EngineInterface, current: readonly Section[], fresh: ReadonlyMap<string, PrRecord>): Promise<void> {
  const found: Record<string, PrRecord> = {}
  for (const section of current) {
    if (section.info === null) continue
    const record = filteredRecordOf(section) ?? fresh.get(section.key) ?? asRecord(await readStore<unknown>($, storeKeyOf('prs:', section.key)))
    if (record !== undefined) found[section.key] = record
  }
  await update($, prs, () => found)
}

/** Whether a failed request that mixes fragments was refused by a schema that lacks a pull-request field E3 asks. */
function refusesPrFields(state: RepoState): boolean {
  const said = state.detail ?? ''

  return state.kind === 'error' && SCHEMA_REFUSAL.test(said) && PR_FIELD.test(said)
}

/** A failed pull-request request: V1's back-off for a rate limit or no network, a host whose schema refused the fields given up, each kind logged once. */
function notePrFailure($: EngineInterface, section: Section, state: RepoState, now: number): void {
  backoffFor(section.key, state, now)
  if (state.kind === 'error' && section.info !== null && SCHEMA_REFUSAL.test(state.detail ?? '')) prsOffHosts.add(section.info.host)
  if (prFailuresLogged.has(state.kind)) return
  prFailuresLogged.add(state.kind)
  $.ui.log(`${PLUGIN}: pull-request states of ${section.key} failed: ${state.kind} ${state.detail ?? ''}`, { to: 'debug' })
}

/**
 * E3 where V1's list ran: one GraphQL request per repository for the listed issues' pull requests, when they are due
 * (isPrsDue) and the pane is shown (D X-1). Repositories E7 probed this refresh are skipped: their states rode in the
 * probe, or wait for the next one. A filtered section (E14) reads its own rows the same way, on a cadence of its own
 * query, and keeps the record in this module: the store's record stays the default list's (E14-1).
 */
async function refreshPrs($: EngineInterface, current: readonly Section[], reason: Reason, now: number, probed: ReadonlySet<string>, log: Record<string, string>): Promise<void> {
  for (const section of current) {
    if (section.state.kind !== 'ok' || section.info === null || section.rows.length === 0 || probed.has(section.key)) continue
    if (prsOffHosts.has(section.info.host)) continue
    const query = section.query
    const tried = filteredPrTried.get(section.key)
    const stored = query === undefined ? (await read($, prs))[section.key] : filteredRecordOf(section)
    const triedAt = query === undefined ? prTriedAt.get(section.key) : tried?.query === query ? tried.at : undefined
    if (!isPrsDue(stored, section.rows, reason, now, triedAt, backoffUntil.get(section.key) ?? 0)) continue
    if (query === undefined) prTriedAt.set(section.key, now)
    else filteredPrTried.set(section.key, { query, at: now })
    const fetched = await fetchPrLinks($, section.info, section.rows.map(row => row.number))
    if ('state' in fetched) {
      notePrFailure($, section, fetched.state, now)
      log[section.key] = `failed: ${fetched.state.kind}`
      continue
    }
    // The signed-in account the answer named (E5), else the one the last record kept.
    const record = recordOf(fetched.links, newest(section.rows.map(row => row.updatedAt)), now, fetched.viewer ?? stored?.viewer ?? null)
    if (query === undefined) await writeStore($, storeKeyOf('prs:', section.key), record)
    else filteredPrs.set(section.key, { query, record })
    await update($, prs, current => ({ ...current, [section.key]: record }))
    log[section.key] = `read (cost ${fetched.cost ?? '?'})${query === undefined ? '' : ', filtered'}`
  }
}

/**
 * E3's optional layer: the pull request the app binds to each mapped issue session (`ccd_pr` `get_status`), read
 * quietly (never a card), at most once a minute per session, each session backing off on its own for ten minutes
 * after a failure (E3-1). Runs after the refresh as its own task, never awaited by it (A-F4), and only while the pane
 * is shown (D X-1). The app's cache costs no GitHub budget.
 */
async function readSessionPrs($: EngineInterface, current: readonly Section[]): Promise<void> {
  if (isReadingSessionPrs) return
  isReadingSessionPrs = true
  try {
    if (!(await mayRunInBackground($))) return
    const live = new Set(current.flatMap(section => section.rows.map(row => rowKeyOf(section.key, row.number))))
    const all = await read($, mappings)
    for (const [rowKey, mapping] of Object.entries(all)) {
      if (!live.has(rowKey)) continue
      const now = await $.clock.now()
      if (now < (sessionPrNext.get(mapping.sessionId) ?? 0)) continue
      const look = await readPrStatus($, mapping.sessionId, now)
      if (look.kind === 'failed') {
        sessionPrNext.set(mapping.sessionId, now + SESSION_PR_BACKOFF_MS)
        $.ui.log(`${PLUGIN}: get_status ${mapping.sessionId} not read: ${look.reason}`, { to: 'debug' })
        // No answer leaves what the app said last to age out; the app's own error means no pull request for that session.
        if (look.isTransport) continue
      } else {
        if (!hasLoggedStatusRaw) {
          hasLoggedStatusRaw = true
          $.ui.log(`${PLUGIN}: get_status raw: ${look.raw}`, { to: 'debug' })
        }
        sessionPrNext.set(mapping.sessionId, now + SESSION_PR_EVERY_MS)
      }
      await update($, sessionPrs, found => {
        const next = { ...found }
        // The session it was read for goes with it: the row draws it only while its mapping still names that session.
        if (look.kind === 'pr') next[rowKey] = { ...look.pr, sessionId: mapping.sessionId }
        else delete next[rowKey]

        return next
      })
    }
    await update($, sessionPrs, found => Object.fromEntries(Object.entries(found).filter(([rowKey, pr]) => live.has(rowKey) && all[rowKey] !== undefined && all[rowKey]?.sessionId === pr.sessionId)))
  } catch (error) {
    $.ui.log(`${PLUGIN}: reading the sessions' pull requests failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
  } finally {
    isReadingSessionPrs = false
  }
}

async function refresh($: EngineInterface, options: Options, reason: Reason): Promise<void> {
  if (isRunning) {
    // The ask is kept with its reason (E7-2, E11-2): a ↻ pressed meanwhile still runs as the owner's press.
    queuedReason = strongerReason(queuedReason, reason)

    return
  }
  isRunning = true
  try {
    await update($, isRefreshing, () => true)
    const now = await $.clock.now()
    const root = await $.session.root()
    // Another pane, or an issue session of this project, may have started or released a session since the last refresh.
    await loadMappings($)
    if (checkout !== null && checkout.root !== root) {
      checkout = null
      named.clear()
    }
    // After a hot reload the pane is still up while this module's memory is fresh.
    if (!wantsPane && (await isPaneOpen($))) wantsPane = true
    // The checkout first: its settings name the other repositories.
    if (checkout === null || checkout.root !== root || checkout.info === null) checkout = { root, ...(await resolveCheckout($, root)) }
    const key = checkout.info === null ? '' : repoKey(checkout.info)
    if (settingsKey !== key) {
      settingsKey = key
      const stored = key === '' ? undefined : await readStore<unknown>($, storeKeyOf('settings:', key))
      await update($, settings, () => readSettings(stored))
      await update($, checkoutKey, () => key)
    }
    const chosen = await read($, settings)

    // Open the pane once the folder turns out to be a GitHub repository.
    if (!paneDecided) {
      paneDecided = true
      const remote = (await $.session.repo().catch(() => null))?.remote ?? null
      const looksGitHub = checkout.info !== null || (remote !== null && /github/i.test(remote))
      if (options.openAtStart && looksGitHub && !(await read($, isIssueSession)) && (await surfacesAllowPane($))) await openPane($, options, false)
    }

    const targets = await resolveTargets($, root, chosen.watch, reason)
    const previous = await read($, sections)
    const nextSections: Section[] = []
    const cachedMeta = new Map<string, Record<string, IssueMeta>>()
    /** Each repository's stored default list: the facets come from it while a filter shows other rows (E14). */
    const cachedLists = new Map<string, IssueRow[]>()
    // Two specs can name one repository (`owner/name` and `github.com/owner/name`, a rename gh redirects): one section per key.
    const seenKeys = new Set<string>()
    // New background fetches run only while the pane is shown (D X-1): E3's pull-request states here.
    const isShown = await isPaneShown($)
    /** Repositories E7's tiers served this refresh, the details tier 2 read, the pull-request records they brought. */
    const probed = new Set<string>()
    const tierDetails = new Map<string, IssueDetails>()
    const prUpdates = new Map<string, PrRecord>()
    const probeLog: Record<string, Record<string, unknown>> = {}
    const prLog: Record<string, string> = {}
    // E14: one filter for every section; null is V1's list, the same call and the same cache.
    const views = chosen.views ?? []
    const activeFilter = await read($, filter)
    const query = effectiveQuery(activeFilter, views, now)
    const listKey = filterKey(activeFilter, views)

    for (const target of targets) {
      const sectionKey = target.info === null ? `spec:${target.spec}`.toLowerCase() : repoKey(target.info)
      if (seenKeys.has(sectionKey)) continue
      seenKeys.add(sectionKey)
      const before = previous.find(section => section.key === sectionKey)
      // The default list never builds on rows a filter listed (E14).
      const prior = before?.query === undefined ? before : undefined
      if (target.info === null) {
        nextSections.push({ key: sectionKey, spec: target.spec, info: null, state: target.state, rows: [], fetchedAt: null, isCheckout: target.isCheckout })
        continue
      }
      const blocked = stateOf(target.info)
      if (blocked.kind !== 'ok') {
        nextSections.push({ key: sectionKey, spec: target.spec, info: target.info, state: blocked, rows: [], fetchedAt: null, isCheckout: target.isCheckout })
        continue
      }
      const cache = await readStore<RepoCache>($, storeKeyOf('cache:', sectionKey))
      const cachedRows = Array.isArray(cache?.rows) ? cache.rows : []
      const cachedAt = typeof cache?.fetchedAt === 'number' ? cache.fetchedAt : null
      cachedMeta.set(sectionKey, typeof cache?.meta === 'object' && cache?.meta !== null ? cache.meta : {})
      cachedLists.set(sectionKey, cachedRows)
      const freshFor = Math.max(MIN_PERIOD_MS, options.refreshMinutes * 60_000 * 0.9)
      const isFresh = cachedAt !== null && now - cachedAt < freshFor
      const until = backoffUntil.get(sectionKey) ?? 0
      if (query !== null) {
        nextSections.push(await listFiltered($, options, target, target.info, sectionKey, before, query, listKey, reason, now, freshFor))
        continue
      }
      // A timed refresh trusts a list another pane of the project fetched a moment ago, and waits out a back-off;
      // it adopts that list when it is newer than this pane's, so rows and fetch time agree.
      if (reason === 'timer' && (isFresh || now < until)) {
        const useCache = cachedAt !== null && cachedAt > (prior?.fetchedAt ?? 0)
        const total = useCache ? cache?.total : (prior?.total ?? cache?.total)
        nextSections.push({
          key: sectionKey,
          spec: target.spec,
          info: target.info,
          state: useCache ? { kind: 'ok' } : (prior?.state ?? { kind: 'ok' }),
          rows: useCache ? cachedRows : (prior?.rows ?? cachedRows),
          fetchedAt: useCache ? cachedAt : (prior?.fetchedAt ?? cachedAt),
          isCheckout: target.isCheckout,
          ...(total === undefined ? {} : { total }),
        })
        continue
      }
      // E7: a large repository's timed or tool refresh asks the probe, and tier 2 only for what changed.
      if ((reason === 'timer' || reason === 'tool') && cache !== undefined && probeEngaged(cache, options.maxIssues, now, probeOffUntil.get(sectionKey) ?? 0)) {
        const stored = asRecord(await readStore<unknown>($, storeKeyOf('prs:', sectionKey)))
        const withLinks = isShown && !prsOffHosts.has(target.info.host) && isPrsDue(stored, cachedRows, reason, now, prTriedAt.get(sectionKey), until)
        const done = await probeSection($, options, target, target.info, sectionKey, { ...cache, rows: cachedRows, meta: cachedMeta.get(sectionKey) ?? {} }, prior, now, withLinks)
        if (done !== null) {
          probed.add(sectionKey)
          probeLog[sectionKey] = done.log
          cachedMeta.set(sectionKey, done.meta)
          for (const [number, found] of done.details) tierDetails.set(rowKeyOf(sectionKey, number), found)
          if (done.record !== undefined) prUpdates.set(sectionKey, done.record)
          nextSections.push(done.section)
          continue
        }
        probeLog[sectionKey] = { plan: 'paused' }
      }
      const listed = await listIssues($, target.info, options.maxIssues)
      if ('state' in listed) {
        backoffFor(sectionKey, listed.state, now)
        // The last good list stays visible under the error.
        const total = prior?.total ?? cache?.total
        nextSections.push({
          key: sectionKey,
          spec: target.spec,
          info: target.info,
          state: listed.state,
          rows: prior?.rows ?? cachedRows,
          fetchedAt: prior?.fetchedAt ?? cachedAt,
          isCheckout: target.isCheckout,
          ...(total === undefined ? {} : { total }),
        })
        continue
      }
      backoffUntil.delete(sectionKey)
      const open = new Set(listed.rows.map(row => String(row.number)))
      // An uncapped list counts the open issues itself; a capped one keeps the probe's last count while it still fits (E7).
      const total = listed.rows.length < options.maxIssues ? listed.rows.length : cache?.total !== undefined && cache.total >= listed.rows.length ? cache.total : undefined
      // V1 kept the listed issues' meta only; a capped list now keeps the most recently shown others too (E14-1).
      const isWhole = listed.rows.length < options.maxIssues && (total ?? 0) <= listed.rows.length
      const meta = retainMeta(cachedMeta.get(sectionKey) ?? {}, open, isWhole, metaBound(options.maxIssues), now)
      cachedMeta.set(sectionKey, meta)
      const fresh: RepoCache = { fetchedAt: now, rows: listed.rows, meta, ...(total === undefined ? {} : { total }) }
      await writeStore($, storeKeyOf('cache:', sectionKey), fresh)
      nextSections.push({ key: sectionKey, spec: target.spec, info: target.info, state: { kind: 'ok' }, rows: listed.rows, fetchedAt: now, isCheckout: target.isCheckout, ...(total === undefined ? {} : { total }) })
    }

    // Seed details from the cache for issues this session has not fetched yet, and drop what no live row needs.
    const live = new Set(nextSections.flatMap(section => section.rows.map(row => rowKeyOf(section.key, row.number))))
    await update($, details, current => {
      const next: Record<string, IssueDetails> = {}
      for (const [rowKey, have] of Object.entries(current)) if (live.has(rowKey)) next[rowKey] = have
      // What E7's tier 2 read is current: hydrate finds it so, and runs no `gh issue view` for those issues.
      for (const [rowKey, found] of tierDetails) if (live.has(rowKey)) next[rowKey] = found
      for (const section of nextSections) {
        const meta = cachedMeta.get(section.key) ?? {}
        for (const row of section.rows) {
          const rowKey = rowKeyOf(section.key, row.number)
          if (!isCurrent(next[rowKey], row)) {
            const seeded = seededDetails(meta[String(row.number)])
            if (seeded !== undefined && isCurrent(seeded, row)) next[rowKey] = seeded
          }
        }
      }

      return next
    })
    // Recaps of this session's repositories from the store, each read through asRecap (a malformed entry is skipped). One
    // another session made since, newer or better (E9's backfill, a failure redone), replaces this session's.
    for (const section of nextSections) {
      if (section.state.kind !== 'ok') continue
      const stored = await readStore<Record<string, unknown>>($, storeKeyOf('recaps:', section.key))
      if (typeof stored !== 'object' || stored === null) continue
      await update($, recaps, current => {
        const next = { ...current }
        for (const [number, value] of Object.entries(stored)) {
          const rowKey = rowKeyOf(section.key, Number(number))
          const recap = asRecap(value)
          if (recap !== undefined && live.has(rowKey) && isBetterRecap(recap, next[rowKey], options.language)) next[rowKey] = recap
        }

        return next
      })
    }
    await update($, recaps, current => Object.fromEntries(Object.entries(current).filter(([rowKey]) => live.has(rowKey))))
    await update($, opened, current => (current === '' || live.has(current) ? current : ''))
    // E5: each repository's baseline, before its rows are drawn, so a row is drawn with its mark from the start; the
    // glimpses whose hold has passed go into the baselines (R3-INT-3: a glimpse of a row no longer listed is kept, so
    // a row that leaves the list and comes back keeps its fade; written only when one faded, every write redraws).
    await initBaselines($, options, nextSections, now)
    await foldGlimpses($, now)
    // E22: an issue that left a complete default list probably just closed; its repository's closed list is read again
    // once it is 30 s old (E22-2: a capped list loses issues whenever another one is updated, so it says nothing).
    for (const section of nextSections) {
      const was = previous.find(found => found.key === section.key)
      if (was === undefined || was.query !== undefined || section.query !== undefined || section.state.kind !== 'ok' || !isComplete(section, options)) continue
      const open = new Set(section.rows.map(row => row.number))
      if (was.rows.some(row => !open.has(row.number))) closedNudge.add(section.key)
    }
    await update($, sections, () => nextSections)
    // E14: the pickers offer what the default lists hold, the stored one while a filter shows other rows.
    const nextFacets = facetsOf(nextSections.map(section => (section.query === undefined ? section.rows : (cachedLists.get(section.key) ?? []))))
    if (!sameFacets(await read($, facets), nextFacets)) await update($, facets, () => nextFacets)
    // The stored pull-request states draw at once; then the due ones are read, before the details (E3-5).
    await loadPrCache($, nextSections, prUpdates)
    if (isShown) await refreshPrs($, nextSections, reason, now, probed, prLog)
    // E11 and E18 run before the details, their searches and reads only while the pane is shown (D X-1); a hidden pane
    // still draws the inbox another pane left in the store, which costs no GitHub call (B2-BEH-4).
    const inboxLog = await refreshInbox($, options, reason, now, isShown)
    if (isShown) await refreshBoards($, nextSections, reason, now, false)
    // E5: what arrived since this session's last list, once the pull-request read named the signed-in account.
    await announceArrivals($, options, nextSections, previous)
    // The last refresh's outcome, for the spike notes and a look at the store file.
    await writeStore($, 'debug:last', {
      at: now,
      reason,
      root,
      checkout: checkout.state,
      sections: nextSections.map(section => ({
        key: section.key,
        state: section.state,
        rows: section.rows.length,
        ...(section.total === undefined ? {} : { total: section.total }),
        ...(section.query === undefined ? {} : { query: section.query }),
      })),
      probe: probeLog,
      prs: prLog,
      inbox: inboxLog,
    })

    await hydrate($, options, nextSections, now, isShown)
    // E5-c: an update the owner made by their own comment is no news to them.
    await acknowledgeOwnComments($, options, nextSections)
    // E4: the comments of the rows near the window, for their hover cards (two per refresh, while shown on the desktop).
    await warmCards($, options, now)
    await pruneMappings($, options, nextSections)
    // E22 after the details: the expanded closed lists that are due, fetched only while the pane is shown (D X-1); the
    // store's lists are drawn either way (B2-BEH-4).
    await refreshClosed($, options, nextSections, reason, now, isShown)
    // E5: the title's count as the refresh left it, and the next fade (a reload's lost timer is armed again here).
    await syncTitle($, options)
    armFade($, options, await read($, glimpsed), await $.clock.now())
    // The desktop's part comes last and is not awaited: no desktop call holds up the GitHub part (A-F4).
    void readSessionPrs($, nextSections)
  } catch (error) {
    $.ui.log(`${PLUGIN}: refresh failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
  } finally {
    isRunning = false
    await update($, isRefreshing, () => false).catch(() => undefined)
    flushToasts($)
    if (queuedReason !== null) {
      const again = queuedReason
      queuedReason = null
      schedule($, options, 500, again)
    }
  }
}

/**
 * Fetches the details of changed issues, a couple at a time, and their recaps where the repository consented. A recap
 * of an unchanged issue made before E9 (or in the other language) is redone too, to gain its triage, but only while the
 * pane is shown on a surface that draws it, at most five a refresh, the rows drawn first (C-E9-2): an upgrade costs one
 * model call per issue, spread out, never in a hidden or headless session.
 */
async function hydrate($: EngineInterface, options: Options, current: readonly Section[], now: number, isShown: boolean): Promise<void> {
  const chosen = await read($, settings)
  const known = await read($, details)
  const knownRecaps = await read($, recaps)
  type Task = { section: Section; row: IssueRow; isBackfill: boolean }
  const tasks: Task[] = []
  const backfill: Task[] = []
  // A backfill only while the pane is shown on a surface that draws it, and only when some recap is of an older
  // version or in the other language (the surfaces are asked only then).
  const isOld = (recap: Recap) => (recap.v ?? 1) < RECAP_VERSION || recap.language !== options.language
  const mayBackfill = isShown && Object.values(knownRecaps).some(isOld) && (await surfacesAllowPane($))
  for (const section of current) {
    if (section.state.kind !== 'ok' || section.info === null) continue
    const consented = options.recaps && chosen.consent[section.key] === true
    for (const row of section.rows) {
      const rowKey = rowKeyOf(section.key, row.number)
      const recap = knownRecaps[rowKey]
      const needsDetails = !isCurrent(known[rowKey], row)
      const needsRecap = consented && !isRecapFor(recap, row)
      if (needsDetails || needsRecap) tasks.push({ section, row, isBackfill: false })
      else if (consented && mayBackfill && !isRecapCurrent(recap, row, options.language) && !isRedoHeld(rowKey, row, options.language, now)) backfill.push({ section, row, isBackfill: true })
    }
  }
  if (backfill.length > 0) {
    // The rows drawn first, in drawing order; the others after them.
    const { plan } = paneLayout(await paneState($, options))
    const order = new Map(plan.sections.flatMap(drawn => drawn.rows.map(row => rowKeyOf(drawn.section.key, row.number))).map((rowKey, index) => [rowKey, index]))
    const rank = (task: Task) => order.get(rowKeyOf(task.section.key, task.row.number)) ?? Number.MAX_SAFE_INTEGER
    tasks.push(...backfill.sort((a, b) => rank(a) - rank(b)).slice(0, BACKFILL_PER_REFRESH))
  }
  const touchedRepos = new Set<string>()
  if (tasks.length > 0) {
    let next = 0
    const worker = async () => {
      while (next < tasks.length) {
        const task = tasks[next++]
        if (task === undefined) break
        await hydrateOne($, options, task.section, task.row, now, task.isBackfill)
        touchedRepos.add(task.section.key)
      }
    }
    await Promise.all(Array.from({ length: Math.min(DETAILS_CONCURRENCY, tasks.length) }, worker))
  }
  // One store write per touched repository: the meta and the recaps of its rows as they stand now, merged into what
  // the store keeps of the other issues within E14-1's bound. A filtered section never writes the list itself. A
  // filtered list that listed in this refresh marks its rows shown even when none of them needed a read, as the
  // default list does where it is written, so the bound evicts the issues no list showed for longest (B2-BEH-1).
  const allDetails = await read($, details)
  const allRecaps = await read($, recaps)
  for (const section of current) {
    const isFiltered = section.query !== undefined
    const isTouched = touchedRepos.has(section.key)
    const isStampOnly = !isTouched && isFiltered && section.state.kind === 'ok' && section.fetchedAt === now && section.rows.length > 0
    if (!isTouched && !isStampOnly) continue
    const cache = await readStore<RepoCache>($, storeKeyOf('cache:', section.key))
    const merged: Record<string, IssueMeta> = { ...(typeof cache?.meta === 'object' && cache?.meta !== null ? cache.meta : {}) }
    const listed = new Set<string>()
    const repoRecaps: Record<string, Recap> = {}
    for (const row of section.rows) {
      const rowKey = rowKeyOf(section.key, row.number)
      listed.add(String(row.number))
      const have = allDetails[rowKey]
      if (have !== undefined) merged[String(row.number)] = metaOf(have)
      const recap = allRecaps[rowKey]
      if (recap !== undefined && recap.error === undefined) repoRecaps[String(row.number)] = recap
    }
    const meta = retainMeta(merged, listed, !isFiltered && isComplete(section, options), metaBound(options.maxIssues), now)
    if (isStampOnly) {
      // Nothing was read: only when the rows were shown changes; the list and the recaps stay as stored.
      if (Object.keys(meta).length > 0) await writeStore($, storeKeyOf('cache:', section.key), { ...(cache ?? { fetchedAt: 0, rows: [] }), meta })
      continue
    }
    const total = cache?.total ?? section.total
    const written: RepoCache = isFiltered
      ? { ...(cache ?? { fetchedAt: 0, rows: [] }), meta }
      : { fetchedAt: cache?.fetchedAt ?? section.fetchedAt ?? now, rows: cache?.rows ?? section.rows, meta, ...(total === undefined ? {} : { total }) }
    await writeStore($, storeKeyOf('cache:', section.key), written)
    // Recaps stay on disk only while the owner wants them for this repository: the listed rows' as they stand, the
    // others' as long as the store keeps their meta.
    if (options.recaps && chosen.consent[section.key] === true) {
      const stored = await readStore<Record<string, Recap>>($, storeKeyOf('recaps:', section.key))
      const others = Object.entries(typeof stored === 'object' && stored !== null ? stored : {}).filter(([number]) => !listed.has(number) && meta[number] !== undefined)
      await writeStore($, storeKeyOf('recaps:', section.key), { ...Object.fromEntries(others), ...repoRecaps })
    } else await $.store.delete(storeKeyOf('recaps:', section.key)).catch(() => undefined)
  }
}

/** E9: whether a redo of this row's recap failed lately, at the issue's current update and in this language (B3-BEH-4). */
function isRedoHeld(rowKey: string, row: IssueRow, language: Language, now: number): boolean {
  const failed = redoFailed.get(rowKey)

  return failed !== undefined && failed.updatedAt === row.updatedAt && failed.language === language && now - failed.at < REDO_RETRY_MS
}

/**
 * One issue's details when they are older than the row (or only seeded), and its recap where the repository consented:
 * always when the recap is older than the issue, and with `mayRedo` (a backfill task, an opened row) also when it was
 * asked before E9's triage or in the other language. A redo that fails keeps the working recap it was to replace, in
 * the state and so in the store (V1 never touched an unchanged issue's recap), and holds that row's redo for an hour
 * (B3-BEH-4, R3-RT-1, R3-INT-2); a recap older than the issue is replaced by the failure, as in V1.
 */
async function hydrateOne($: EngineInterface, options: Options, section: Section, row: IssueRow, now: number, mayRedo: boolean): Promise<IssueDetails | undefined> {
  if (section.info === null) return undefined
  const rowKey = rowKeyOf(section.key, row.number)
  const chosen = await read($, settings)
  let have = (await read($, details))[rowKey]
  if (!isCurrent(have, row) || have?.fetchedAt === 0) {
    const viewed = await viewIssue($, section.info, row, now)
    if ('state' in viewed) {
      $.ui.log(`${PLUGIN}: details of #${row.number} failed: ${viewed.state.kind} ${viewed.state.detail ?? ''}`, { to: 'debug' })

      return have
    }
    have = viewed.details
    const fetched = viewed.details
    await update($, details, current => ({ ...current, [rowKey]: fetched }))
  }
  const consented = options.recaps && chosen.consent[section.key] === true
  const recap = (await read($, recaps))[rowKey]
  const isRedo = isRecapFor(recap, row)
  if (consented && have !== undefined && (!isRedo || (mayRedo && !isRecapCurrent(recap, row, options.language) && !isRedoHeld(rowKey, row, options.language, now)))) {
    const made = await recapIssue($, row, have, options.language, options.recapModel, now)
    // A failed redo of a working recap keeps that recap: the failure is only remembered, so it is not asked again soon.
    const keepsOld = isRedo && recap?.error === undefined && made.error !== undefined
    if (keepsOld) redoFailed.set(rowKey, { updatedAt: row.updatedAt, language: options.language, at: now })
    else await update($, recaps, current => ({ ...current, [rowKey]: made }))
    const spent = made.usage.input_tokens + made.usage.output_tokens + made.usage.cache_read_input_tokens + made.usage.cache_creation_input_tokens
    if (spent > 0) await update($, tokens, current => current + spent)
    if (made.error !== undefined) $.ui.log(`${PLUGIN}: recap of #${row.number} failed: ${made.error}${keepsOld ? ' (the earlier recap stays)' : ''}`, { to: 'debug' })
  }

  return have
}

/**
 * Whether a section lists every open issue of its repository, so an issue missing from it is no longer open: it is
 * shorter than the cap, and its open count, when known, is not above its rows. A probed list that tier 2 shortened (an
 * issue closed between the probe and the read) is still a capped window of a larger repository: the issues beyond it
 * are not gone, and the probe's aliases release those that close (E7).
 */
function isComplete(section: Section, options: Options): boolean {
  return section.rows.length < options.maxIssues && (section.total ?? 0) <= section.rows.length
}

/**
 * A mapping whose issue is no longer open is dropped; its session closed the issue, or someone did by hand. Only a
 * complete default list says an issue is gone: a filtered list (E14) is not the open set.
 */
async function pruneMappings($: EngineInterface, options: Options, current: readonly Section[]): Promise<void> {
  const all = await read($, mappings)
  for (const section of current) {
    if (section.state.kind !== 'ok' || section.query !== undefined || !isComplete(section, options)) continue
    const open = new Set(section.rows.map(row => rowKeyOf(section.key, row.number)))
    for (const rowKey of Object.keys(all)) {
      if (rowKey.startsWith(`${section.key}#`) && !open.has(rowKey)) await saveMapping($, rowKey, null)
    }
  }
}

/** Puts text into the prompt box, set apart from a draft the owner has already typed. */
async function fillPrompt($: EngineInterface, options: Options, text: string): Promise<boolean> {
  const S = strings(options.language)
  const draft = (await $.prompt.read().catch(() => null))?.text ?? ''
  const filled = await $.prompt.fill({ text: draft.trim() === '' ? text : `\n\n${text}`, mode: 'append' }).catch(() => null)
  if (filled?.isFilled !== true) {
    $.ui.toast(S.promptBusy)

    return false
  }
  ownBriefs.add(text.slice(0, BRIEF_HEAD))

  return true
}

function findRow(current: readonly Section[], sectionKey: string, number: number): { section: Section; row: IssueRow } | null {
  const section = current.find(found => found.key === sectionKey)
  const row = section?.rows.find(found => found.number === number)

  return section === undefined || row === undefined || section.info === null ? null : { section, row }
}

async function setStarting($: EngineInterface, rowKey: string, value: boolean): Promise<void> {
  await update($, starting, current => {
    const next = { ...current }
    if (value) next[rowKey] = true
    else delete next[rowKey]

    return next
  })
}

/**
 * The fresh details the brief needs, with the issue's tree (E17): its relations, and when it has a parent, the
 * parent's other sub-issues from one more read (a failure there leaves the brief without siblings). `null` when the
 * issue is closed or gh failed (the owner is told). The tree lives in the session's state only.
 */
async function freshDetails($: EngineInterface, options: Options, section: Section, row: IssueRow, now: number): Promise<IssueDetails | null> {
  const S = strings(options.language)
  if (section.info === null) return null
  const viewed = await viewIssue($, section.info, row, now, { tree: true })
  if ('state' in viewed) {
    $.ui.toast(clean(S.error(viewed.state.detail ?? viewed.state.kind)))

    return null
  }
  const rowKey = rowKeyOf(section.key, row.number)
  let fetched = viewed.details
  const tree = fetched.tree
  if (tree !== undefined && tree.parent !== null && fetched.state.toUpperCase() === 'OPEN') {
    const here = repoLabel(section.info).toLowerCase()
    const parent = await viewParent($, tree.parent, section.info.host)
    if (parent !== null && !('state' in parent)) {
      const siblings = parent.subIssues.filter(ref => !(ref.number === row.number && (ref.repo === '' || ref.repo.toLowerCase() === here))).slice(0, 10)
      fetched = { ...fetched, tree: { ...tree, siblings, parentProgress: parent.progress } }
    } else $.ui.log(`${PLUGIN}: the parent of #${row.number} was not read: ${parent === null ? 'no repository in its URL' : `${parent.state.kind} ${parent.state.detail ?? ''}`}`, { to: 'debug' })
  }
  const settled = fetched
  await update($, details, current => ({ ...current, [rowKey]: settled }))
  if (settled.state.toUpperCase() !== 'OPEN') {
    $.ui.toast(S.closedMeanwhile(row.number))
    await update($, sections, current => current.map(found => (found.key === section.key ? { ...found, rows: found.rows.filter(item => item.number !== row.number) } : found)))
    await saveMapping($, rowKey, null)
    // E22: the repository's closed list, when expanded, is read again on the next refresh (once it is 30 s old).
    closedNudge.add(section.key)

    return null
  }

  return settled
}

/** "Work on it" (or "Open session", as `label` says): opens the issue's session, or starts one. */
async function workOn($: EngineInterface, options: Options, sectionKey: string, number: number, label: string): Promise<void> {
  const S = strings(options.language)
  const rowKey = rowKeyOf(sectionKey, number)
  if (inFlight.has(rowKey)) return
  inFlight.add(rowKey)
  await setStarting($, rowKey, true)
  try {
    // E5: working on a row acknowledges it.
    await acknowledgeRow($, options, rowKey)
    // What the owner pressed, in the words they saw, for a desktop call that has to take the typed route.
    const consent = pressConsent(label, `issue ${rowKey}`)
    // The store, not this pane's copy, says whether the issue has a session: another pane may have started one.
    const mapping = await reloadMapping($, rowKey)
    if (mapping !== undefined) {
      await openExisting($, options, rowKey, mapping, number, consent)

      return
    }
    const found = findRow(await read($, sections), sectionKey, number)
    if (found === null || found.section.info === null) return
    const now = await $.clock.now()
    const fresh = await freshDetails($, options, found.section, found.row, now)
    if (fresh === null) return
    const input = { issueRepo: found.section.info, codeRepo: checkout?.info ?? null, row: found.row, details: fresh, fetchedAt: new Date(now).toISOString(), triage: await triageFor($, options, rowKey, fresh) }
    const prompt = renderBrief(input)
    const background = renderBackground(input, checkout?.root ?? (await $.session.root()))
    const title = sessionTitle(found.row)
    const outcome = await startDesktopSession(
      $,
      {
        title,
        name: sessionName(found.row, found.section.info.name),
        prompt,
        background,
        branch_name: branchName(found.row),
        use_worktree: true,
      },
      consent,
    )
    await update($, route, () => outcome.route)
    if (outcome.route === 'none') {
      await fillPrompt($, options, prompt)
      $.ui.toast(clean(S.sessionNotStarted(outcome.reason ?? '?')), { timeoutMs: 8_000 })

      return
    }
    if (outcome.sessionId === null) {
      $.ui.toast(S.noIdParsed, { timeoutMs: 8_000 })

      return
    }
    const started: Mapping = { sessionId: outcome.sessionId, title, startedAt: now, startedFrom: myId, detached: false }
    await saveMapping($, rowKey, started)
    $.ui.toast(clean(S.sessionStarted(title)))
    const detached = await detachSession($, outcome.sessionId, consent)
    if (detached.ok) await saveMapping($, rowKey, { ...started, detached: true })
    else $.ui.toast(S.stayLinked, { timeoutMs: 6_000 })
  } finally {
    inFlight.delete(rowKey)
    await setStarting($, rowKey, false)
  }
}

async function openExisting($: EngineInterface, options: Options, rowKey: string, mapping: Mapping, number: number, consent: string): Promise<void> {
  const S = strings(options.language)
  const focused = await focusSession($, mapping.sessionId, consent)
  if (focused.ok) return
  const look = await lookUpSession($, mapping.sessionId, consent)
  if (look.exists && !look.isArchived) {
    $.ui.toast(clean(S.openElsewhere(look.title || mapping.title)), { timeoutMs: 6_000 })

    return
  }
  await saveMapping($, rowKey, null)
  $.ui.toast(S.released(number))
}

async function takeHere($: EngineInterface, options: Options, sectionKey: string, number: number): Promise<void> {
  const S = strings(options.language)
  const found = findRow(await read($, sections), sectionKey, number)
  if (found === null || found.section.info === null) return
  const rowKey = rowKeyOf(sectionKey, number)
  // E5: taking a row here acknowledges it.
  await acknowledgeRow($, options, rowKey)
  const now = await $.clock.now()
  const fresh = await freshDetails($, options, found.section, found.row, now)
  if (fresh === null) return
  const input = { issueRepo: found.section.info, codeRepo: checkout?.info ?? null, row: found.row, details: fresh, fetchedAt: new Date(now).toISOString(), triage: await triageFor($, options, rowKey, fresh) }
  if (await fillPrompt($, options, renderBrief(input))) $.ui.toast(S.briefInPrompt)
}

/**
 * E9: the triage a brief carries: the recap's, only where the pane would use the recap (recaps on, the repository
 * consented, no failure, C-E9-3) and only while it is as new as the issue just read; none otherwise.
 */
async function triageFor($: EngineInterface, options: Options, rowKey: string, fresh: IssueDetails): Promise<Triage | null> {
  const recap = (await read($, recaps))[rowKey]
  const sectionKey = rowKey.slice(0, rowKey.lastIndexOf('#'))

  return isRecapUsable(options, await read($, settings), sectionKey, recap, fresh) ? (recap.triage ?? null) : null
}

async function consent($: EngineInterface, options: Options, key: string, value: boolean): Promise<void> {
  await saveSettings($, current => ({ ...current, consent: { ...current.consent, [key]: value } }))
  if (value) {
    schedule($, options, 0)

    return
  }
  // Switching recaps off for a repository removes its stored recaps.
  await $.store.delete(storeKeyOf('recaps:', key)).catch(() => undefined)
  const prefix = `${key}#`
  await update($, recaps, current => Object.fromEntries(Object.entries(current).filter(([rowKey]) => !rowKey.startsWith(prefix))))
}

/** Normalizes what the owner typed to `owner/name` or `host/owner/name`; null when it is no repository. */
function cleanSpec(spec: string): string | null {
  const clean = spec
    .trim()
    .replace(/^https?:\/\/(?:www\.)?/i, '')
    .replace(/^github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/g, '')

  return isRepoSpec(clean) ? clean : null
}

async function addWatch($: EngineInterface, options: Options, spec: string): Promise<void> {
  const clean = cleanSpec(spec)
  if (clean === null) return
  if (checkout?.info !== null && checkout?.info !== undefined && repoLabel(checkout.info).toLowerCase() === clean.toLowerCase()) return
  let added = false
  await saveSettings($, current => {
    if (current.watch.some(found => found.toLowerCase() === clean.toLowerCase())) return current
    added = true

    return { ...current, watch: [...current.watch, clean] }
  })
  if (!added) return
  named.delete(clean)
  schedule($, options, 0)
}

async function removeWatch($: EngineInterface, options: Options, spec: string): Promise<void> {
  await saveSettings($, current => ({ ...current, watch: current.watch.filter(found => found !== spec) }))
  named.delete(spec)
  await update($, sections, found => found.filter(section => section.isCheckout || section.spec !== spec))
  schedule($, options, 0)
}

async function toggleSection($: EngineInterface, key: string): Promise<void> {
  await saveSettings($, current => {
    const collapsed = { ...current.collapsed }
    if (collapsed[key] === true) delete collapsed[key]
    else collapsed[key] = true

    return { ...current, collapsed }
  })
}

async function toggleRow($: EngineInterface, options: Options, rowKey: string): Promise<void> {
  const now = await update($, opened, current => (current === rowKey ? '' : rowKey))
  if (now !== rowKey) return
  // E5: opening a row acknowledges it.
  await acknowledgeRow($, options, rowKey)
  const have = (await read($, details))[rowKey]
  // A seeded entry has no body or comments: fetch them for the opened row.
  if (have !== undefined && have.fetchedAt !== 0) return
  const hash = rowKey.lastIndexOf('#')
  const found = findRow(await read($, sections), rowKey.slice(0, hash), Number(rowKey.slice(hash + 1)))
  if (found === null) return
  await hydrateOne($, options, found.section, found.row, await $.clock.now(), true)
}

// E14: the filter ------------------------------------------------------------

/**
 * Changes the pane's filter, and lists again only when the query gh would be asked changed: the grouping and the
 * board facet are drawn from the rows already listed.
 */
async function setFilter($: EngineInterface, options: Options, patch: Partial<Filter>): Promise<void> {
  const views = (await read($, settings)).views ?? []
  const now = await $.clock.now()
  const before = await read($, filter)
  const next: Filter = { ...before, ...patch }
  await update($, filter, () => next)
  if (effectiveQuery(before, views, now) !== effectiveQuery(next, views, now)) schedule($, options, 0)
}

/** The search as typed (Enter applies, an empty Enter clears): one line, cleaned; the sanitizer runs on the query. */
async function setSearch($: EngineInterface, options: Options, text: string): Promise<void> {
  await setFilter($, options, { search: cutText(clean(text).replace(/\s+/g, ' ').trim(), TYPED_CHARS) })
}

/** Restores the default filter; the search field is drawn afresh, empty (E14-4). */
async function clearFilter($: EngineInterface, options: Options): Promise<void> {
  await update($, searchGen, current => current + 1)
  await setFilter($, options, DEFAULT_FILTER)
}

/**
 * Saves the current search as a view of the checkout's repository (at most 8; the same name replaces its view) and
 * switches to it; the query is the sanitized search, so a saved view never leaves the repository.
 */
async function saveView($: EngineInterface, options: Options, name: string): Promise<void> {
  const S = strings(options.language)
  const shown = cleanViewName(name)
  const query = sanitizeQuery((await read($, filter)).search).query
  if (shown === null || query === '') return
  const id = viewIdOf(shown)
  let isFull = false
  await saveSettings($, current => {
    const views = current.views ?? []
    const isKnown = views.some(view => view.id === id)
    if (!isKnown && views.length >= MAX_VIEWS) {
      isFull = true

      return current
    }

    return { ...current, views: isKnown ? views.map(view => (view.id === id ? { id, name: shown, query } : view)) : [...views, { id, name: shown, query }] }
  })
  if (isFull) {
    $.ui.toast(S.viewsFull)

    return
  }
  await update($, searchGen, current => current + 1)
  await setFilter($, options, { view: id, search: '' })
}

/** Removes a saved view; a pane showing it falls back to the open issues and lists again. */
async function removeView($: EngineInterface, options: Options, id: string): Promise<void> {
  await saveSettings($, current => {
    const next = { ...current }
    const views = (current.views ?? []).filter(view => view.id !== id)
    if (views.length > 0) next.views = views
    else delete next.views

    return next
  })
  if ((await read($, filter)).view !== id) return
  await update($, filter, current => ({ ...current, view: 'open' }))
  schedule($, options, 0)
}

/** E17-4: an epic's open sub-issues in the list, through E14's search (`parent-issue:owner/name#n`, verified live). */
async function listSubIssues($: EngineInterface, options: Options, rowKey: string): Promise<void> {
  const hash = rowKey.lastIndexOf('#')
  const found = findRow(await read($, sections), rowKey.slice(0, hash), Number(rowKey.slice(hash + 1)))
  if (found === null || found.section.info === null) return
  await update($, searchGen, current => current + 1)
  await setFilter($, options, { view: 'open', search: `parent-issue:${repoLabel(found.section.info)}#${found.row.number}`, label: '', milestone: '' })
}

// E18: board status ------------------------------------------------------------

/**
 * Reads the listed rows' Projects status, one request per section, while the feature is on for the checkout's
 * repository; collapsed sections wait (E18-2). The timer, a tool and the mod's own re-runs ask at most once a minute
 * for the same rows, and never while the host's token lacks the scope; the session's start, ↻ and the owner's presses
 * (`force`: the toggle, Erneut prüfen) always ask, since the owner may have granted the scope meanwhile. A rate limit,
 * no network or a signed-out gh keep the last items; another failure is named in the ⚙ panel.
 */
async function refreshBoards($: EngineInterface, current: readonly Section[], reason: Reason, now: number, force: boolean, onlyHost?: string): Promise<void> {
  const chosen = await read($, settings)
  if (chosen.boards !== true) return
  for (const section of current) {
    const info = section.info
    if (info === null || section.state.kind !== 'ok' || section.rows.length === 0 || chosen.collapsed[section.key] === true) continue
    if (onlyHost !== undefined && info.host !== onlyHost) continue
    const numbers = section.rows.map(row => row.number)
    const asked = numbers.join(',')
    const last = boardsReadAt.get(section.key)
    if (!force && reason !== 'start' && reason !== 'press') {
      if ((await read($, boards)).scope[info.host] === 'missing') continue
      if (last !== undefined && last.rows === asked && now - last.at < BOARDS_MIN_MS) continue
    }
    boardsReadAt.set(section.key, { at: now, rows: asked })
    const fetched = await fetchBoards($, info, numbers)
    if ('state' in fetched) {
      const failed = fetched.state
      $.ui.log(`${PLUGIN}: board status of ${section.key} not read: ${failed.kind} ${failed.detail ?? ''}`, { to: 'debug' })
      if (failed.kind === 'missing-scope') {
        await update($, boards, (had): Boards => {
          const items = { ...had.items }
          for (const number of numbers) delete items[rowKeyOf(section.key, number)]

          return { ...had, scope: { ...had.scope, [info.host]: 'missing' }, needs: { ...had.needs, [info.host]: failed.detail ?? 'read:project' }, items }
        })
      } else if (failed.kind !== 'rate-limited' && failed.kind !== 'offline' && failed.kind !== 'signed-out') {
        await update($, boards, (had): Boards => ({ ...had, detail: { ...had.detail, [info.host]: firstLine(failed.detail ?? failed.kind) || failed.kind } }))
      }
      continue
    }
    await update($, boards, (had): Boards => {
      const items = { ...had.items }
      for (const number of numbers) delete items[rowKeyOf(section.key, number)]
      for (const [number, list] of fetched.items) if (list.length > 0) items[rowKeyOf(section.key, number)] = list
      const detail = { ...had.detail }
      delete detail[info.host]

      return { ...had, scope: { ...had.scope, [info.host]: 'present' }, detail, items, fetchedAt: now }
    })
  }
}

/** The ⚙ panel's switch: on reads the board status at once; off forgets the items and the board facet. */
async function toggleBoards($: EngineInterface): Promise<void> {
  const next = await saveSettings($, current => {
    if (current.boards !== true) return { ...current, boards: true }
    const rest = { ...current }
    delete rest.boards

    return rest
  })
  if (next.boards === true) {
    await refreshBoards($, await read($, sections), 'press', await $.clock.now(), true)

    return
  }
  await update($, boards, had => ({ ...had, items: {}, detail: {} }))
  if ((await read($, filter)).board !== '') await update($, filter, current => ({ ...current, board: '' }))
}

/** Erneut prüfen after a missing scope: asks that host's sections at once, the rest of the refresh untouched (E18-2). */
async function retryBoards($: EngineInterface, host: string): Promise<void> {
  await update($, boards, (had): Boards => ({ ...had, scope: { ...had.scope, [host]: 'unknown' } }))
  await refreshBoards($, await read($, sections), 'press', await $.clock.now(), true, host)
}

// E11: assigned to me ----------------------------------------------------------

/**
 * The search for the issues assigned to the signed-in account on the checkout's host, shared through the store by
 * every pane on the machine. Due by age only (E11-1): the attach refresh that finds the pane placed searches; ↻ asks
 * once the last try is a minute old (E11-2); a back-off kept in the store holds after a failure (E11-6), so a reload
 * cannot fire a rate-limited search again. It searches only when `maySearch` (the pane is shown, D X-1). Otherwise, or
 * when not due, the pane draws the store's record when it is newer than what the pane draws: another pane's rows, or
 * the failure its search met (R2-RT-4); reading it costs no GitHub call, so a hidden pane draws it too (B2-BEH-4).
 */
async function refreshInbox($: EngineInterface, options: Options, reason: Reason, now: number, maySearch: boolean): Promise<string> {
  if (!options.assignedToMe) return 'off'
  const host = checkout?.info?.host ?? 'github.com'
  const key = storeKeyOf('inbox:', host)
  const stored = asInboxCache(await readStore<unknown>($, key))
  const period = inboxPeriod(options.refreshMinutes)
  if (!maySearch || !isInboxDue(stored, reason, now, period)) {
    const shared = inboxFromRecord(stored, await read($, inbox), host)
    if (shared !== undefined) await update($, inbox, () => shared)

    return maySearch ? 'shared' : 'not shown'
  }
  const found = await searchAssigned($, host, Math.min(INBOX_CAP, options.maxIssues))
  if ('state' in found) {
    const failed = found.state
    await writeStore($, key, failedInbox(stored, failed, now, period))
    const lastRows = stored?.rows ?? []
    const lastAt = stored !== undefined && stored.fetchedAt > 0 ? stored.fetchedAt : null
    await update($, inbox, (had): Inbox => (had.host === host && had.fetchedAt !== null ? { ...had, state: failed, at: now } : { host, state: failed, rows: lastRows, fetchedAt: lastAt, at: now }))

    return `failed: ${failed.kind}`
  }
  await writeStore($, key, { v: 1, fetchedAt: now, triedAt: now, rows: found.rows })
  await update($, inbox, (): Inbox => ({ host, state: { kind: 'ok' }, rows: found.rows, fetchedAt: now, at: now }))

  return `searched: ${found.rows.length}`
}

/** The section is collapsed unless the owner expanded it: `collapsed.inbox` false. */
async function toggleInbox($: EngineInterface): Promise<void> {
  await saveSettings($, current => ({ ...current, collapsed: { ...current.collapsed, inbox: current.collapsed['inbox'] === false } }))
}

/** ↓ Zeigen: the issue's row in its section, expanded, opened and scrolled into view. */
async function showInSection($: EngineInterface, options: Options, rowKey: string): Promise<void> {
  const sectionKey = rowKey.slice(0, rowKey.lastIndexOf('#'))
  if ((await read($, settings)).collapsed[sectionKey] === true) await toggleSection($, sectionKey)
  if ((await read($, opened)) !== rowKey) await toggleRow($, options, rowKey)
  await scrollToRow($, rowKey)
}

/**
 * Scrolls the pane to a row's title. `$.ui.scroll` answers `{ deny }` for an element not drawn yet rather than
 * waiting, so a denied scroll is tried once more a moment later (E11-5); then the owner scrolls.
 */
async function scrollToRow($: EngineInterface, rowKey: string): Promise<void> {
  const first = await $.ui.scroll({ in: PANE, to: { key: `row-title:${rowKey}` }, block: 'start' }).catch(error => ({ deny: error instanceof Error ? error.message : String(error) }))
  if (first.deny === undefined) return
  await $.clock.sleep(SCROLL_RETRY_MS).catch(() => undefined)
  const second = await $.ui.scroll({ in: PANE, to: { key: `row-title:${rowKey}` }, block: 'start' }).catch(error => ({ deny: error instanceof Error ? error.message : String(error) }))
  if (second.deny !== undefined) $.ui.log(`${PLUGIN}: scroll to row-title:${rowKey} refused twice: ${second.deny}`, { to: 'debug' })
}

/** With the section switched off, no other project's issue titles stay on disk: every `inbox:` key goes at the start. */
async function sweepInbox($: EngineInterface): Promise<void> {
  const keys = await $.store.keys().catch(() => [] as string[])
  for (const key of keys) if (key.startsWith('inbox:')) await $.store.delete(key).catch(() => undefined)
}

// E22: recently closed ---------------------------------------------------------

/**
 * Reads the expanded "recently closed" parts that are due (isClosedDue), one gh call each, when `mayFetch` (the pane
 * is shown, or a press asked); a part whose section is collapsed never fetches (E22-2). Each repository's step is
 * claimed in module memory before its first wait (E22-1), so a press and a refresh never both fetch one list; the
 * loading flag in the state only draws, and only the call that set it clears it. Another pane's newer list in the
 * store is drawn whether or not this call may fetch: reading it costs no GitHub call (B2-BEH-4). A failure keeps the
 * last list under its state and counts as a try, so it waits as a read would (E3-2); a rate limit backs off 10 minutes,
 * no network 2.
 */
async function refreshClosed($: EngineInterface, options: Options, current: readonly Section[], reason: ClosedReason, now: number, mayFetch: boolean, only?: string): Promise<void> {
  if (options.closedDays <= 0) return
  const chosen = await read($, settings)
  const since = sinceDate(now, options.closedDays)
  for (const section of current) {
    const info = section.info
    if (only !== undefined && section.key !== only) continue
    if (info === null || section.state.kind !== 'ok' || chosen.showClosed?.[section.key] !== true) continue
    // Claimed before the first wait: a check and a claim with waits between them let two calls fetch (B2-BEH-3).
    if (closedInFlight.has(section.key)) continue
    closedInFlight.add(section.key)
    let isLoading = false
    try {
      const have = (await read($, closed))[section.key]
      const stored = asClosedCache(await readStore<unknown>($, storeKeyOf('closed:', section.key)))
      const cache = stored !== undefined && (have === undefined || stored.fetchedAt > have.fetchedAt) ? stored : have
      if (cache !== undefined && cache !== have) await update($, closed, all => ({ ...all, [section.key]: cache }))
      if (!mayFetch || chosen.collapsed[section.key] === true || now < (closedBackoff.get(section.key) ?? 0)) continue
      const tried = closedTriedAt.get(section.key)
      if (!isClosedDue(cache, since, reason, now, closedNudge.has(section.key), tried?.since === since ? tried.at : undefined)) continue
      closedTriedAt.set(section.key, { at: now, since })
      closedNudge.delete(section.key)
      isLoading = true
      await update($, closedLoading, all => ({ ...all, [section.key]: now }))
      const listed = await listClosed($, info, since)
      if ('state' in listed) {
        const failed = listed.state
        if (failed.kind === 'rate-limited') closedBackoff.set(section.key, now + 10 * 60_000)
        else if (failed.kind === 'offline') closedBackoff.set(section.key, now + 2 * 60_000)
        await update($, closedErrors, all => ({ ...all, [section.key]: failed }))
        continue
      }
      const record: ClosedCache = closedRecord(listed.rows, since, now)
      await writeStore($, storeKeyOf('closed:', section.key), record)
      await update($, closed, all => ({ ...all, [section.key]: record }))
      await update($, closedErrors, all => {
        if (all[section.key] === undefined) return all
        const next = { ...all }
        delete next[section.key]

        return next
      })
    } finally {
      closedInFlight.delete(section.key)
      if (isLoading) {
        await update($, closedLoading, all => {
          const next = { ...all }
          delete next[section.key]

          return next
        })
      }
    }
  }
}

/** Expands or collapses a repository's "recently closed" part; expanding reads it when due (the press shows the pane is drawn). */
async function toggleClosed($: EngineInterface, options: Options, sectionKey: string): Promise<void> {
  const next = await saveSettings($, current => {
    const showClosed = { ...(current.showClosed ?? {}) }
    if (showClosed[sectionKey] === true) delete showClosed[sectionKey]
    else showClosed[sectionKey] = true
    const rest = { ...current }
    if (Object.keys(showClosed).length > 0) rest.showClosed = showClosed
    else delete rest.showClosed

    return rest
  })
  if (next.showClosed?.[sectionKey] === true) await refreshClosed($, options, await read($, sections), 'expand', await $.clock.now(), true, sectionKey)
}

// E5: new since the last visit ------------------------------------------------

/** Runs the seen records' store work one task after another (a look, an acknowledgement, the pill, a first run). */
function serialSeen<T>(task: () => Promise<T>): Promise<T> {
  const run = seenChain.then(task)
  seenChain = run.then(
    () => undefined,
    () => undefined,
  )

  return run
}

/**
 * Each default list's baseline, the first time this session lists its repository: the seen record as the store holds
 * it, whatever another session writes to it later. A repository with none (a first run) records its list as seen, and
 * nothing is marked. A filtered list (E14) sets none: its rows are not the repository's open issues.
 */
async function initBaselines($: EngineInterface, options: Options, current: readonly Section[], now: number): Promise<void> {
  const have = await read($, seenBase)
  const added: Record<string, SeenRecord> = {}
  for (const section of current) {
    if (section.info === null || section.state.kind !== 'ok' || section.query !== undefined || have[section.key] !== undefined) continue
    added[section.key] = await serialSeen(() => firstSeen($, storeKeyOf('seen:', section.key), section, now, SEEN_KEEP_FACTOR * options.maxIssues))
  }
  if (Object.keys(added).length > 0) await update($, seenBase, base => ({ ...added, ...base }))
}

async function firstSeen($: EngineInterface, key: string, section: Section, now: number, keep: number): Promise<SeenRecord> {
  const stored = readSeen(await readStore<unknown>($, key))
  if (stored !== null) return stored
  const record = seenRecordOf(section.rows, section.rows, null, now, keep)
  await writeStore($, key, record)

  return record
}

/** The signed-in account the repository's last pull-request read named (E3's record), or a read of another repository on the host. */
function viewerFor(records: Readonly<Record<string, PrRecord>>, section: Section): string | null {
  const own = records[section.key]?.viewer
  if (own !== undefined) return own
  const host = section.info?.host
  if (host === undefined) return null
  for (const [key, record] of Object.entries(records)) if (key.startsWith(`${host}/`) && record.viewer !== undefined) return record.viewer

  return null
}

/**
 * E5's arrivals: the issues of a list never listed by this session before and created after the newest the owner had
 * seen, on a repository this session listed before (never on its first list). A filtered list (E14) counts too, from
 * its query's second list on (B3-BEH-3): its rows join the listed numbers, so an issue that arrives while a filter is on
 * would otherwise never be announced, not even once the filter is cleared. The owner's own, by the login E3's read
 * named, are acknowledged instead: what they filed is no news (E5-c). The others make the refresh's one arrival toast
 * (ranked below a failure and a proposal), while arrival toasts are on and the pane is shown (D X-1).
 */
async function announceArrivals($: EngineInterface, options: Options, current: readonly Section[], previous: readonly Section[]): Promise<void> {
  const base = await read($, seenBase)
  const had = await read($, listed)
  const records = await read($, prs)
  const arrived: Array<{ section: Section; row: IssueRow }> = []
  const own: string[] = []
  const next: Record<string, Record<string, true>> = { ...had }
  let isChanged = false
  for (const section of current) {
    if (section.info === null || section.state.kind !== 'ok') continue
    const known = had[section.key]
    const viewer = viewerFor(records, section)?.toLowerCase()
    // A filter's first list of its query announces nothing, as a repository's first list does: what it brings was
    // there before (a capped default list just did not show it); only its later lists can bring arrivals.
    const isFirstOfQuery = section.query !== undefined && previous.find(found => found.key === section.key)?.query !== section.query
    for (const row of isFirstOfQuery ? [] : arrivalsOf(section.rows, base[section.key], known)) {
      if (viewer !== undefined && row.author.toLowerCase() === viewer) own.push(rowKeyOf(section.key, row.number))
      else arrived.push({ section, row })
    }
    if (known !== undefined && section.rows.every(row => known[String(row.number)] === true)) continue
    isChanged = true
    const numbers: Record<string, true> = { ...(known ?? {}) }
    for (const row of section.rows) numbers[String(row.number)] = true
    // Issue numbers are integer keys, so they list in ascending order: the oldest issues go first past the bound.
    const keys = Object.keys(numbers)
    next[section.key] = keys.length > LISTED_KEEP ? Object.fromEntries(keys.slice(-LISTED_KEEP).map(number => [number, true as const])) : numbers
  }
  // Written only when a number is new: every write redraws the pane.
  if (isChanged) await update($, listed, () => next)
  for (const rowKey of own) await acknowledgeRow($, options, rowKey)
  if (arrived.length === 0 || !options.arrivalToasts || !(await isPaneShown($))) return
  offerToast('arrival', arrivalText(arrived, strings(options.language)), ARRIVAL_TOAST_MS)
}

/**
 * E5: the owner acknowledged one row (opened it, pressed Work on it or Take it here; or it is their own new issue or
 * comment): its mark goes at once, the session's baseline and the stored record take its update time. `newest` stays,
 * so an older issue they have not seen stays new.
 */
async function acknowledgeRow($: EngineInterface, options: Options, rowKey: string): Promise<void> {
  const hash = rowKey.lastIndexOf('#')
  const sectionKey = rowKey.slice(0, hash)
  const found = findRow(await read($, sections), sectionKey, Number(rowKey.slice(hash + 1)))
  const base = (await read($, seenBase))[sectionKey]
  if (found === null || base === undefined) return
  const row = found.row
  const now = await $.clock.now()
  await serialSeen(() => writeAcknowledged($, storeKeyOf('seen:', sectionKey), base, row, now))
  // The baseline changes only when it did not hold the row as it stands (every write redraws the pane).
  if (markOf(row, base) !== null || (row.stateReason === 'REOPENED' && base.reopened?.[String(row.number)] !== true)) {
    await update($, seenBase, current => {
      const had = current[sectionKey]

      return had === undefined ? current : { ...current, [sectionKey]: withRow(had, row, had.at) }
    })
  }
  if ((await read($, glimpsed))[rowKey] !== undefined) {
    await update($, glimpsed, current => {
      const next = { ...current }
      delete next[rowKey]

      return next
    })
  }
  await syncTitle($, options)
}

async function writeAcknowledged($: EngineInterface, key: string, base: SeenRecord, row: IssueRow, now: number): Promise<void> {
  const stored = readSeen(await readStore<unknown>($, key)) ?? base
  const seen = stored.rows[String(row.number)]
  // Nothing to write when the record already holds the row as it stands.
  if (seen !== undefined && seen >= row.updatedAt && (row.stateReason !== 'REOPENED' || stored.reopened?.[String(row.number)] === true)) return
  await writeStore($, key, withRow(stored, row, now))
}

/**
 * E5: the title bar's pill: every row it counts is seen, at once and for the next visit: the rows each section shows,
 * collapsed ones included, the board facet's hidden rows not (R3-INT-4: they were never on screen nor counted). The
 * baseline takes each row as an acknowledgement does (`newest` unchanged, nothing else of the stored record copied in).
 */
async function markAllSeen($: EngineInterface, options: Options): Promise<void> {
  const now = await $.clock.now()
  const base = await read($, seenBase)
  const { plan } = paneLayout(await paneState($, options))
  const seen: Array<{ sectionKey: string; rows: IssueRow[] }> = []
  for (const drawn of plan.sections) {
    const { section, shown } = drawn
    const had = base[section.key]
    if (section.info === null || had === undefined || shown.length === 0) continue
    await serialSeen(() => writeAllSeen($, options, section, shown, had, now))
    seen.push({ sectionKey: section.key, rows: shown })
  }
  if (seen.length > 0) {
    await update($, seenBase, current => {
      const next = { ...current }
      for (const { sectionKey, rows } of seen) {
        const had = next[sectionKey]
        if (had !== undefined) next[sectionKey] = rows.reduce((record, row) => withRow(record, row, record.at), had)
      }

      return next
    })
    const keys = new Set(seen.flatMap(({ sectionKey, rows }) => rows.map(row => rowKeyOf(sectionKey, row.number))))
    if (Object.keys(await read($, glimpsed)).some(rowKey => keys.has(rowKey))) {
      await update($, glimpsed, current => Object.fromEntries(Object.entries(current).filter(([rowKey]) => !keys.has(rowKey))))
    }
  }
  await syncTitle($, options)
}

/**
 * The rows a seen record is kept for (B3-BEH-1) and whose unseen newer issues `newest` never passes: the section's own
 * list, or for a filtered one (E14) the repository's default list as the store keeps it (R3-INT-1).
 */
async function defaultListOf($: EngineInterface, section: Section | undefined, sectionKey: string): Promise<readonly IssueRow[]> {
  if (section !== undefined && !isFilteredList(section)) return section.rows
  const cache = await readStore<RepoCache>($, storeKeyOf('cache:', sectionKey))

  return Array.isArray(cache?.rows) ? cache.rows : []
}

async function writeAllSeen($: EngineInterface, options: Options, section: Section, shown: readonly IssueRow[], base: SeenRecord, now: number): Promise<void> {
  const key = storeKeyOf('seen:', section.key)
  const rows = await defaultListOf($, section, section.key)
  await writeStore($, key, seenRecordOf(shown, rows, readSeen(await readStore<unknown>($, key)) ?? base, now, SEEN_KEEP_FACTOR * options.maxIssues, isFilteredList(section)))
}

/**
 * E5: the owner looked at the pane: a press in it, a scroll or a focus move of theirs, a prompt they sent while it is
 * shown, the command. The rows in view by the layout's estimate count as seen (E5-4: not every drawn row; the engine
 * says nothing of what is in view, so this is an approximation): a marked one gets its glimpse (its mark fades ten
 * minutes later), and each repository's stored record takes them, written at most every 15 s per repository (a later
 * look's rows wait for the next write, so the rows a scroll brought into view are never dropped). Hover never counts.
 */
async function noteLook($: EngineInterface, options: Options): Promise<void> {
  const base = await read($, seenBase)
  // No baseline yet (before the first list, or in an issue session): nothing is marked and nothing is recorded.
  if (Object.keys(base).length === 0 || (await read($, isIssueSession))) return
  const now = await $.clock.now()
  const pane = await paneState($, options)
  const { tops } = paneLayout(pane)
  const covered: RowTop[] = rowsInView(tops, viewport.offset, viewport.bodyRows).filter(found => base[found.sectionKey] !== undefined)
  if (covered.length === 0) return
  const filtered = new Set(pane.sections.filter(isFilteredList).map(section => section.key))
  // A glimpse for each covered row that carries a mark not glimpsed at this update yet; written only when there is one.
  const had = await read($, glimpsed)
  const fresh = covered.filter(found => markOf(found.row, base[found.sectionKey], filtered.has(found.sectionKey)) !== null && had[found.key]?.updatedAt !== found.row.updatedAt)
  const glimpses =
    fresh.length === 0
      ? had
      : await update($, glimpsed, current => {
          const next = { ...current }
          for (const found of fresh) {
            if (next[found.key]?.updatedAt !== found.row.updatedAt) next[found.key] = { at: now, updatedAt: found.row.updatedAt, ...(found.row.stateReason === 'REOPENED' ? { reopened: true as const } : {}) }
          }

          return next
        })
  for (const found of covered) {
    const rows = pendingSeen.get(found.sectionKey) ?? new Map<number, IssueRow>()
    rows.set(found.row.number, found.row)
    pendingSeen.set(found.sectionKey, rows)
    // A filtered look's write leaves `newest` (R3-INT-1), even when the filter is gone by the time it is written.
    if (filtered.has(found.sectionKey)) pendingFiltered.add(found.sectionKey)
  }
  await flushSeen($, options, now)
  armFade($, options, glimpses, now)
}

/** Writes the seen records whose repository no look wrote in the last 15 s; the others once that is over. */
async function flushSeen($: EngineInterface, options: Options, now: number): Promise<void> {
  let wait: number | null = null
  for (const [sectionKey, rows] of [...pendingSeen]) {
    const since = now - (seenWrittenAt.get(sectionKey) ?? Number.NEGATIVE_INFINITY)
    if (since < LOOK_THROTTLE_MS) {
      wait = Math.min(wait ?? LOOK_THROTTLE_MS, LOOK_THROTTLE_MS - since)
      continue
    }
    pendingSeen.delete(sectionKey)
    const wasFiltered = pendingFiltered.delete(sectionKey)
    seenWrittenAt.set(sectionKey, now)
    const covered = [...rows.values()]
    await serialSeen(() => writeLook($, options, sectionKey, covered, wasFiltered, now))
  }
  if (wait === null || seenFlush !== undefined) return
  seenFlush = $.clock.after(wait, () => {
    seenFlush = undefined
    void flushLater($, options)
  })
}

async function flushLater($: EngineInterface, options: Options): Promise<void> {
  await flushSeen($, options, await $.clock.now())
}

/**
 * Writes one repository's record for the rows looks covered. Its `newest` never passes an unseen issue of the default
 * list, and in a filtered list (E14) it stays: such a list says nothing of the issues between its rows (R3-INT-1).
 */
async function writeLook($: EngineInterface, options: Options, sectionKey: string, covered: readonly IssueRow[], wasFiltered: boolean, now: number): Promise<void> {
  const key = storeKeyOf('seen:', sectionKey)
  const previous = readSeen(await readStore<unknown>($, key)) ?? (await read($, seenBase))[sectionKey]
  if (previous === undefined) return
  const section = (await read($, sections)).find(found => found.key === sectionKey)
  const rows = await defaultListOf($, section, sectionKey)
  const isFiltered = wasFiltered || section === undefined || isFilteredList(section)
  await writeStore($, key, seenRecordOf(covered, rows, previous, now, SEEN_KEEP_FACTOR * options.maxIssues, isFiltered))
}

/** Wakes when the next mark fades, to redraw and retitle; armed after every refresh and look, so a reload recovers. */
function armFade($: EngineInterface, options: Options, glimpses: Readonly<Record<string, Glimpse>>, now: number): void {
  fade?.cancel()
  fade = undefined
  const due = nextFade(glimpses, now)
  if (due === null) return
  fade = $.clock.after(due - now + 1_000, () => {
    fade = undefined
    void fadeTick($, options)
  })
}

async function fadeTick($: EngineInterface, options: Options): Promise<void> {
  await foldGlimpses($, await $.clock.now())
  $.ui.invalidate('ui.render')
  await syncTitle($, options)
  armFade($, options, await read($, glimpsed), await $.clock.now())
}

/**
 * E5: the glimpses whose hold has passed go into the session's baselines (R3-INT-3), so a faded mark stays gone when
 * its row leaves the list (a filter, a capped list's churn) and comes back; the others stay, listed or not. Written
 * only when a glimpse faded (every write redraws the pane).
 */
async function foldGlimpses($: EngineInterface, now: number): Promise<void> {
  const had = await read($, glimpsed)
  if (foldFaded({}, had, now) === null) return
  await update($, seenBase, current => foldFaded(current, had, now)?.base ?? current)
  await update($, glimpsed, current => Object.fromEntries(Object.entries(current).filter(([, glimpse]) => now - glimpse.at < MARK_HOLD_MS)))
}

/**
 * E5-c: an issue whose last change was the owner's own comment (within two minutes of its update) is no news to them:
 * its mark goes. Reads only what the session holds: the comments of the issues it read, the login E3's read named.
 */
async function acknowledgeOwnComments($: EngineInterface, options: Options, current: readonly Section[]): Promise<void> {
  const base = await read($, seenBase)
  const known = await read($, details)
  const records = await read($, prs)
  const own: string[] = []
  for (const section of current) {
    const viewer = viewerFor(records, section)?.toLowerCase()
    const record = base[section.key]
    if (viewer === undefined || record === undefined) continue
    for (const row of section.rows) {
      const mark = markOf(row, record, isFilteredList(section))
      if (mark === null || mark === 'new') continue
      const rowKey = rowKeyOf(section.key, row.number)
      const have = known[rowKey]
      const last = have?.comments.at(-1)
      if (have === undefined || have.updatedAt < row.updatedAt || last === undefined || last.author.toLowerCase() !== viewer) continue
      if (Math.abs(Date.parse(last.createdAt) - Date.parse(row.updatedAt)) <= OWN_ACTIVITY_MS) own.push(rowKey)
    }
  }
  for (const rowKey of own) await acknowledgeRow($, options, rowKey)
}

// E4: hover cards -------------------------------------------------------------

/**
 * E4's warm-up: a card shows only what the session holds (no hook runs on hover), so the comments of up to two rows
 * near the pane's window whose details were only seeded from the store are read per refresh, while the pane is shown
 * on the desktop (D X-1) and the cards are on. The comments stay in the session's state; the recap is not touched.
 * It reads only repositories whose list is ok and that no back-off holds (R3-RT-2: a failed list keeps its rows drawn);
 * a rate limit or a lost network it meets backs the repository off, its list too, and ends the warm-up; a row whose
 * read failed waits half an hour unless its issue changes.
 */
async function warmCards($: EngineInterface, options: Options, now: number): Promise<void> {
  if (!options.hoverCards) return
  // Nothing to warm: no row's details are only seeded with comments to read.
  if (!Object.values(await read($, details)).some(have => have.fetchedAt === 0 && have.commentCount > 0)) return
  if (!(await mayRunInBackground($))) return
  const surfaces = await $.session.surfaces().catch(() => [])
  if (!surfaces.some(surface => surface === 'desktop')) return
  const pane = await paneState($, options)
  const { tops } = paneLayout(pane)
  const isReadable = (sectionKey: string) => pane.sections.some(section => section.key === sectionKey && section.state.kind === 'ok') && now >= (backoffUntil.get(sectionKey) ?? 0)
  const due = cardRowsOf(tops, viewport.offset, viewport.bodyRows)
    .filter(found => {
      const have = pane.details[found.key]
      const failed = warmFailed.get(found.key)
      const isHeld = failed !== undefined && failed.updatedAt === found.row.updatedAt && now - failed.at < WARM_RETRY_MS

      return have !== undefined && have.fetchedAt === 0 && have.commentCount > 0 && !isHeld && isReadable(found.sectionKey)
    })
    .slice(0, CARD_WARM_PER_REFRESH)
  for (const found of due) {
    const info = pane.sections.find(section => section.key === found.sectionKey)?.info
    if (info === null || info === undefined || now < (backoffUntil.get(found.sectionKey) ?? 0)) continue
    const viewed = await viewIssue($, info, found.row, now)
    if ('state' in viewed) {
      $.ui.log(`${PLUGIN}: card details of #${found.row.number} failed: ${viewed.state.kind} ${viewed.state.detail ?? ''}`, { to: 'debug' })
      warmFailed.set(found.key, { updatedAt: found.row.updatedAt, at: now })
      backoffFor(found.sectionKey, viewed.state, now)
      if (viewed.state.kind === 'rate-limited' || viewed.state.kind === 'offline') return
      continue
    }
    warmFailed.delete(found.key)
    const fetched = viewed.details
    await update($, details, current => (current[found.key] !== undefined && current[found.key]?.fetchedAt !== 0 ? current : { ...current, [found.key]: fetched }))
  }
}

async function resetStore($: EngineInterface): Promise<void> {
  const keys = await $.store.keys().catch(() => [] as string[])
  for (const key of keys) {
    if (STORE_PREFIXES.some(prefix => key.startsWith(prefix))) await $.store.delete(key).catch(() => undefined)
  }
  named.clear()
  backoffUntil.clear()
  unsaved.clear()
  probeOffUntil.clear()
  prTriedAt.clear()
  prsOffHosts.clear()
  sessionPrNext.clear()
  filteredPrs.clear()
  filteredPrTried.clear()
  boardsReadAt.clear()
  closedBackoff.clear()
  closedTriedAt.clear()
  closedNudge.clear()
  pendingSeen.clear()
  pendingFiltered.clear()
  seenWrittenAt.clear()
  redoFailed.clear()
  warmFailed.clear()
  seenFlush?.cancel()
  seenFlush = undefined
  fade?.cancel()
  fade = undefined
  resetRelations()
  settingsKey = null
  await update($, sections, () => [])
  await update($, details, () => ({}))
  await update($, recaps, () => ({}))
  await update($, mappings, () => ({}))
  await update($, settings, () => DEFAULT_SETTINGS)
  await update($, opened, () => '')
  await update($, tokens, () => 0)
  await update($, prs, () => ({}))
  await update($, sessionPrs, () => ({}))
  // The saved views went with the settings: the filter starts over, and so do the lists' side data.
  await update($, filter, () => DEFAULT_FILTER)
  await update($, searchGen, current => current + 1)
  await update($, facets, () => ({ labels: [], milestones: [] }))
  await update($, boards, () => NO_BOARDS)
  await update($, inbox, () => NO_INBOX)
  await update($, closed, () => ({}))
  await update($, closedLoading, () => ({}))
  await update($, closedErrors, () => ({}))
  // E5: the seen records went with the store: the next list is a first run again, and nothing is marked.
  await update($, seenBase, () => ({}))
  await update($, glimpsed, () => ({}))
  await update($, listed, () => ({}))
}

/**
 * The spike: one throw-away session, started the way the button starts one, to learn which route works and what the
 * app answers; then one quiet read of this session's own metadata, the way the mod's own calls go (never a card).
 */
async function runSpike($: EngineInterface, command: string): Promise<string> {
  const consent = commandConsent(`/${command} spike`)
  const brief = spikeBrief()
  const outcome = await startDesktopSession($, { ...brief, use_worktree: true, branch_name: 'issue-radar-spike' }, consent)
  await update($, route, () => outcome.route)
  const lines: string[] = []
  if (outcome.route === 'none') lines.push(`No route started a session (${outcome.reason ?? '?'}). The button would put the brief into the prompt box.`)
  else {
    lines.push(`start_session via ${outcome.route} (use_worktree: true); session id ${outcome.sessionId ?? 'not parsed'}.`, `Answer: ${outcome.raw || '(empty)'}`)
    if (outcome.sessionId !== null) {
      const detached = await detachSession($, outcome.sessionId, consent)
      lines.push(detached.ok ? 'detach_session: ok.' : `detach_session refused: ${detached.reason ?? '?'}`)
      const look = await lookUpSession($, outcome.sessionId, consent)
      lines.push(look.exists ? `get_session: state ${look.state || '?'}, title "${look.title}", archived ${look.isArchived}` : 'get_session: not found')
    }
  }
  // The route the mod's own reads take (S1 for quiet calls) and what the app tells a session about itself (S4). A
  // measurement: it tries mcp even while an earlier transport failure holds quiet calls back from it.
  const self = await quietDesktop($, 'ccd_session_mgmt', 'get_session', { session_id: 'self' }, { isMeasurement: true })
  if (self.ok) {
    const keys = Object.keys(parseObject(self.structured, self.text))
    lines.push(`get_session self (quiet, via ${self.via}): ${keys.length === 0 ? 'no JSON' : `keys ${keys.slice(0, 40).join(', ')}`}`)
  } else lines.push(`get_session self (quiet): not read (${self.reason})`)
  // S14: whether a mod's own $.mcp.call reaches ccd_pr get_status, for this session and for the mapped issue sessions
  // (S4: are the mapped ids the app's?), and what the answer's fields are called. The mcp route alone: a measurement.
  const now = await $.clock.now()
  const asked = ['self', ...Object.values(await read($, mappings)).map(mapping => mapping.sessionId)].slice(0, 4)
  for (const sessionId of asked) {
    const look = await readPrStatus($, sessionId, now, { isMeasurement: true, isMcpOnly: true })
    lines.push(
      look.kind === 'failed'
        ? `get_status ${sessionId} (quiet, mcp only): not read (${look.reason})`
        : `get_status ${sessionId} (quiet, via mcp): ${look.kind === 'pr' ? `PR #${look.pr.number} ${look.pr.state || '?'}; ` : 'no pull request; '}${look.raw.slice(0, 200) || '(empty)'}`,
    )
  }

  return clean(lines.join('\n'))
}

/** `/issue-radar` and `/issues`: opens the pane, or `reset` clears the store, or `spike` measures the session tools. Top-level, as the engine requires of a function `$` is passed to. */
async function runCommand($: EngineInterface, options: Options, command: string, args: string): Promise<{ text: string }> {
  const S = strings(options.language)
  const word = args.trim().toLowerCase()
  if (word === 'reset') {
    await resetStore($)
    schedule($, options, 0)

    return { text: S.storeCleared }
  }
  if (word === 'spike') return { text: await runSpike($, command) }
  if (!(await surfacesAllowPane($))) return { text: S.unsupported }
  const placed = await $.ui.open({ id: PANE, title: await paneTitle($, options), columns: PANE_COLUMNS })
  wantsPane = true
  armTimer($, options)
  schedule($, options, 0)
  // E5: the owner's command is a look at the pane it opens.
  if (placed.isPlaced) await noteLook($, options).catch(() => undefined)

  return { text: placed.isPlaced ? S.paneOpened : S.paneWaits(placed.reason) }
}

export const register: Register = (on, given) => {
  const options = readOptions(given)
  const S = strings(options.language)

  on('session.start', async ($, e, next) => {
    for (const spec of [
      { name: 'issue-radar', description: S.title, argumentHint: '[reset|spike]' },
      { name: 'issues', description: S.title },
    ]) {
      await $.command.register(spec).catch(error => {
        $.ui.log(`${PLUGIN}: command ${spec.name} not registered: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
      })
    }
    myId = await $.session.id().catch(() => '')
    await loadVersion($)
    // E11 switched off: no other project's issue titles stay on disk.
    if (!options.assignedToMe) await sweepInbox($)
    // E22-1: nothing of a fresh module is loading; a flag a reload left behind would read as a fetch that never ends.
    await update($, closedLoading, () => ({}))
    const known = await loadMappings($)
    const isChild = myId !== '' && Object.values(known).some(mapping => mapping.sessionId === myId)
    if (isChild) {
      await update($, isIssueSession, () => true)
      standDown()
    } else {
      // No pane and no polling inside an issue session; /issue-radar still opens it there.
      armTimer($, options)
      schedule($, options, 600, 'start')
    }

    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    if (wantsPane && !(await read($, isIssueSession)) && (e.surface === 'desktop' || e.surface === 'terminal')) {
      await openPane($, options, false)
      armTimer($, options)
      schedule($, options, 400, 'tool')
    }

    return attached
  })

  // The issue session recognizes its own brief and stays out of the way; a brief this
  // session filled itself (Take it here, or the no-route fallback) is not that case.
  on('prompt.submit', async ($, e, next) => {
    const head = e.text.trimStart().slice(0, BRIEF_HEAD)
    if (e.text.trimStart().startsWith(MARKER) && !ownBriefs.has(head) && !(await read($, isIssueSession))) {
      await update($, isIssueSession, () => true)
      standDown()
      void $.ui.close({ id: PANE }).catch(() => undefined)
    }
    // E5: a prompt the owner sent while the pane is shown is a look at it (the desktop's stamp is S16's question).
    if ((e.origin.kind === 'composer' || e.origin.kind === 'sdk') && !(await read($, isIssueSession)) && (await isPaneShown($))) void noteLook($, options).catch(() => undefined)

    return next(e)
  }).catch(($, e, next) => next(e))

  // E5's looks: a press on the pane's elements, a scroll or focus move of the owner's in it. Each only observes and
  // always passes the event on, and its guard passes it on too (next is replay-safe there), so no press is swallowed.
  on('ui.press', { plugin: PLUGIN, requestId: PANE }, async ($, e, next) => {
    const pressed = await next(e)
    await noteLook($, options).catch(() => undefined)

    return pressed
  }).catch(($, e, next) => next(e))

  on('ui.scroll', { component: 'Pane', requestId: PANE, origin: { kind: 'person' } }, ($, e, next) => {
    // The window moves to e.offset: a look there once it rests (a wheel's ticks make one look).
    viewport = { ...viewport, offset: e.offset, bodyRows: e.bodyRows }
    scrollLook?.cancel()
    scrollLook = $.clock.after(SCROLL_LOOK_MS, () => {
      scrollLook = undefined
      void noteLook($, options).catch(() => undefined)
    })

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.focus', { component: 'Pane', requestId: PANE, origin: { kind: 'person' } }, ($, e, next) => {
    void noteLook($, options).catch(() => undefined)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'issue-radar' }, ($, e) => runCommand($, options, 'issue-radar', e.args))
  on('command.run', { command: 'issues' }, ($, e) => runCommand($, options, 'issues', e.args))

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const input = e as unknown as Record<string, unknown>
    const text = typeof input['command'] === 'string' ? input['command'] : ''
    if (String(e.tool) === 'Bash' && /\bgh\s+(issue|pr)\b|\bgit\s+push\b/.test(text) && wantsPane && !(await read($, isIssueSession))) schedule($, options, 2_500, 'tool')

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (!(await read($, isIssueSession))) armTimer($, options)
    const ui = $.ui.resolve(e)
    const chosen = await read($, settings)
    const activeFilter = await read($, filter)
    // E5, E4: where the window stands, for what a look covers and where the cards go.
    viewport = { offset: e.props.scroll.offset, bodyRows: e.props.scroll.bodyRows, columns: e.props.bodyColumns }

    return renderPane(
      ui,
      {
        sections: await read($, sections),
        details: await read($, details),
        recaps: await read($, recaps),
        mappings: await read($, mappings),
        prs: await read($, prs),
        sessionPrs: await read($, sessionPrs),
        settings: chosen,
        filter: activeFilter,
        filterKey: filterKey(activeFilter, chosen.views ?? []),
        isFilterOpen: await read($, isFilterOpen),
        facets: await read($, facets),
        searchGen: await read($, searchGen),
        boards: await read($, boards),
        inbox: await read($, inbox),
        closed: await read($, closed),
        closedLoading: await read($, closedLoading),
        closedErrors: await read($, closedErrors),
        seenBase: await read($, seenBase),
        glimpsed: await read($, glimpsed),
        options,
        strings: S,
        opened: await read($, opened),
        starting: await read($, starting),
        isRefreshing: await read($, isRefreshing),
        isSettingsOpen: await read($, isSettingsOpen),
        tokens: await read($, tokens),
        version: await read($, version),
        now: await $.clock.now(),
        columns: e.props.bodyColumns,
        rows: e.props.scroll.bodyRows,
        scrollOffset: e.props.scroll.offset,
        surface: e.surface,
        route: routeInUse(),
      },
      {
        refresh: () => schedule($, options, 0, 'press'),
        retry: () => schedule($, options, 0),
        toggleSettings: () => void update($, isSettingsOpen, current => !current),
        close: () => {
          wantsPane = false
          void $.ui.close({ id: PANE }).catch(() => undefined)
        },
        toggleSection: key => void toggleSection($, key),
        toggleRow: key => void toggleRow($, options, key),
        workOn: (sectionKey, number, label) => void workOn($, options, sectionKey, number, label),
        takeHere: (sectionKey, number) => void takeHere($, options, sectionKey, number),
        consent: (key, value) => void consent($, options, key, value),
        addWatch: spec => void addWatch($, options, spec),
        removeWatch: spec => void removeWatch($, options, spec),
        toggleFilter: () => void update($, isFilterOpen, current => !current),
        setFilter: patch => void setFilter($, options, patch),
        setSearch: text => void setSearch($, options, text),
        clearFilter: () => void clearFilter($, options),
        saveView: name => void saveView($, options, name),
        removeView: id => void removeView($, options, id),
        listSubIssues: rowKey => void listSubIssues($, options, rowKey),
        toggleBoards: () => void toggleBoards($),
        retryBoards: host => void retryBoards($, host),
        toggleInbox: () => void toggleInbox($),
        showInSection: rowKey => void showInSection($, options, rowKey),
        toggleClosed: key => void toggleClosed($, options, key),
        markAllSeen: () => void markAllSeen($, options),
      },
    )
  })
}
