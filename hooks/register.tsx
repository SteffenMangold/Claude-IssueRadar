// Issue Radar: the open GitHub issues of the session's repository in a pane,
// and one click that starts a dedicated session per issue. The hooks module:
// the pane, the commands, the refresh pipeline, the hand-off. `$.ui.status`
// has one owner, the issue session's status line (E12); nothing else sets it.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import type { IssueDetails, IssueMeta, IssueRow, Language, Mapping, Options, PrRecord, Recap, RepoCache, RepoInfo, RepoSettings, RepoState, Section } from '../types'
import { MARKER, branchName, renderBackground, renderBrief, sessionName, sessionTitle, spikeBrief } from './brief'
import { dropRelations, isRepoSpec, listIssues, metaOf, repoKey, repoLabel, resetRelations, resolveCheckout, resolveNamed, stateOf, viewIssue, viewParent } from './github'
import { MAPPED_MAX, PROBE_MAX, PROBE_PAUSE_MS, fetchPrLinks } from './graph'
import { asLanguage, strings } from './i18n'
import { asRecord, isPrsDue, mergeLinks, recordOf } from './prs'
import { recapIssue } from './recap'
import { commandConsent, detachSession, focusSession, lookUpSession, parseObject, pressConsent, quietDesktop, readPrStatus, routeInUse, startDesktopSession } from './session'
import { clean } from './text'
import { probeEngaged, runTiers } from './tiers'
import { takeToast } from './toasts'
import { renderPane, rowKeyOf } from './view'

const PLUGIN = 'issue-radar'
const PANE = 'issue-radar'
const PANE_COLUMNS = 46
const DETAILS_CONCURRENCY = 2
const STORE_PREFIXES = ['cache:', 'recaps:', 'session:', 'settings:', 'debug:', 'prs:'] as const
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
  const num = (key: string, fallback: number) => {
    const value = given[key]
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN

    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
  }
  const flag = (key: string, fallback: boolean) => (typeof given[key] === 'boolean' ? (given[key] as boolean) : fallback)
  const model = typeof given['recapModel'] === 'string' && (given['recapModel'] as string).trim() !== '' ? (given['recapModel'] as string).trim() : 'haiku'

  return {
    openAtStart: flag('openAtStart', true),
    refreshMinutes: num('refreshMinutes', 3),
    maxIssues: Math.max(1, Math.round(num('maxIssues', 30))),
    recaps: flag('recaps', true),
    recapModel: model,
    language: asLanguage(given['language']) as Language,
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

/** The settings as stored, each one missing or of the wrong type at its default; a stored spec is checked again before it reaches gh. */
function readSettings(stored: unknown): RepoSettings {
  const value = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {}
  const watch = Array.isArray(value['watch']) ? (value['watch'] as unknown[]).filter((spec): spec is string => typeof spec === 'string' && isRepoSpec(spec)) : []
  const record = (key: string): Record<string, boolean> => {
    const given = value[key]
    if (typeof given !== 'object' || given === null) return {}

    return Object.fromEntries(Object.entries(given as Record<string, unknown>).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'))
  }

  return { watch, consent: record('consent'), collapsed: record('collapsed') }
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

/**
 * The pane's title, the one composer of it: every open goes through here (`openPane`, the command, the attach), since
 * an open of the same id retitles, and a re-open with a bare title would drop what a later count adds to it (E5).
 */
async function paneTitle($: EngineInterface, options: Options): Promise<string> {
  return strings(options.language).title
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
  const written: RepoCache = { fetchedAt: now, rows: outcome.rows, meta: outcome.meta, total: outcome.total }
  await writeStore($, storeKeyOf('cache:', sectionKey), written)
  backoffUntil.delete(sectionKey)
  let record: PrRecord | undefined
  if (outcome.links !== null) {
    prTriedAt.set(sectionKey, now)
    record = recordOf(outcome.links, outcome.asOf, now)
  }
  if (outcome.patchedLinks.size > 0) {
    const stored = record ?? asRecord(await readStore<unknown>($, storeKeyOf('prs:', sectionKey)))
    // Tier 2's pull requests refresh a record a sweep made; alone they would make a partial one look fresh.
    if (stored !== undefined) record = mergeLinks(stored, outcome.patchedLinks, outcome.patchedAsOf)
  }
  if (record !== undefined) await writeStore($, storeKeyOf('prs:', sectionKey), record)
  const section: Section = { ...base, state: { kind: 'ok' }, rows: outcome.rows, fetchedAt: now, total: outcome.total }

  return { section, meta: outcome.meta, details: outcome.details, record, log: { plan: outcome.plan, cost: outcome.cost, remaining: outcome.remaining, links: outcome.links !== null } }
}

/**
 * Mirrors each listed repository's stored pull-request record into the state (another pane may have read it since),
 * the ones this refresh read taking precedence, and drops the records of repositories no longer listed.
 */
async function loadPrCache($: EngineInterface, current: readonly Section[], fresh: ReadonlyMap<string, PrRecord>): Promise<void> {
  const found: Record<string, PrRecord> = {}
  for (const section of current) {
    if (section.info === null) continue
    const record = fresh.get(section.key) ?? asRecord(await readStore<unknown>($, storeKeyOf('prs:', section.key)))
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
 * probe, or wait for the next one.
 */
async function refreshPrs($: EngineInterface, current: readonly Section[], reason: Reason, now: number, probed: ReadonlySet<string>, log: Record<string, string>): Promise<void> {
  for (const section of current) {
    if (section.state.kind !== 'ok' || section.info === null || section.rows.length === 0 || probed.has(section.key)) continue
    if (prsOffHosts.has(section.info.host)) continue
    const stored = (await read($, prs))[section.key]
    if (!isPrsDue(stored, section.rows, reason, now, prTriedAt.get(section.key), backoffUntil.get(section.key) ?? 0)) continue
    prTriedAt.set(section.key, now)
    const fetched = await fetchPrLinks($, section.info, section.rows.map(row => row.number))
    if ('state' in fetched) {
      notePrFailure($, section, fetched.state, now)
      log[section.key] = `failed: ${fetched.state.kind}`
      continue
    }
    const record = recordOf(fetched.links, newest(section.rows.map(row => row.updatedAt)), now)
    await writeStore($, storeKeyOf('prs:', section.key), record)
    await update($, prs, current => ({ ...current, [section.key]: record }))
    log[section.key] = `read (cost ${fetched.cost ?? '?'})`
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

    for (const target of targets) {
      const sectionKey = target.info === null ? `spec:${target.spec}`.toLowerCase() : repoKey(target.info)
      if (seenKeys.has(sectionKey)) continue
      seenKeys.add(sectionKey)
      const before = previous.find(section => section.key === sectionKey)
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
      const freshFor = Math.max(MIN_PERIOD_MS, options.refreshMinutes * 60_000 * 0.9)
      const isFresh = cachedAt !== null && now - cachedAt < freshFor
      const until = backoffUntil.get(sectionKey) ?? 0
      // A timed refresh trusts a list another pane of the project fetched a moment ago, and waits out a back-off;
      // it adopts that list when it is newer than this pane's, so rows and fetch time agree.
      if (reason === 'timer' && (isFresh || now < until)) {
        const useCache = cachedAt !== null && cachedAt > (before?.fetchedAt ?? 0)
        const total = useCache ? cache?.total : (before?.total ?? cache?.total)
        nextSections.push({
          key: sectionKey,
          spec: target.spec,
          info: target.info,
          state: useCache ? { kind: 'ok' } : (before?.state ?? { kind: 'ok' }),
          rows: useCache ? cachedRows : (before?.rows ?? cachedRows),
          fetchedAt: useCache ? cachedAt : (before?.fetchedAt ?? cachedAt),
          isCheckout: target.isCheckout,
          ...(total === undefined ? {} : { total }),
        })
        continue
      }
      // E7: a large repository's timed or tool refresh asks the probe, and tier 2 only for what changed.
      if ((reason === 'timer' || reason === 'tool') && cache !== undefined && probeEngaged(cache, options.maxIssues, now, probeOffUntil.get(sectionKey) ?? 0)) {
        const stored = asRecord(await readStore<unknown>($, storeKeyOf('prs:', sectionKey)))
        const withLinks = isShown && !prsOffHosts.has(target.info.host) && isPrsDue(stored, cachedRows, reason, now, prTriedAt.get(sectionKey), until)
        const done = await probeSection($, options, target, target.info, sectionKey, { ...cache, rows: cachedRows, meta: cachedMeta.get(sectionKey) ?? {} }, before, now, withLinks)
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
        const total = before?.total ?? cache?.total
        nextSections.push({
          key: sectionKey,
          spec: target.spec,
          info: target.info,
          state: listed.state,
          rows: before?.rows ?? cachedRows,
          fetchedAt: before?.fetchedAt ?? cachedAt,
          isCheckout: target.isCheckout,
          ...(total === undefined ? {} : { total }),
        })
        continue
      }
      backoffUntil.delete(sectionKey)
      const open = new Set(listed.rows.map(row => String(row.number)))
      const meta = Object.fromEntries(Object.entries(cachedMeta.get(sectionKey) ?? {}).filter(([number]) => open.has(number)))
      cachedMeta.set(sectionKey, meta)
      // An uncapped list counts the open issues itself; a capped one keeps the probe's last count while it still fits (E7).
      const total = listed.rows.length < options.maxIssues ? listed.rows.length : cache?.total !== undefined && cache.total >= listed.rows.length ? cache.total : undefined
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
    // Recaps of this session's repositories from the store.
    for (const section of nextSections) {
      if (section.state.kind !== 'ok') continue
      const stored = await readStore<Record<string, Recap>>($, storeKeyOf('recaps:', section.key))
      if (stored === undefined) continue
      await update($, recaps, current => {
        const next = { ...current }
        for (const [number, recap] of Object.entries(stored)) {
          const rowKey = rowKeyOf(section.key, Number(number))
          if (next[rowKey] === undefined && live.has(rowKey)) next[rowKey] = recap
        }

        return next
      })
    }
    await update($, recaps, current => Object.fromEntries(Object.entries(current).filter(([rowKey]) => live.has(rowKey))))
    await update($, opened, current => (current === '' || live.has(current) ? current : ''))
    await update($, sections, () => nextSections)
    // The stored pull-request states draw at once; then the due ones are read, before the details (E3-5).
    await loadPrCache($, nextSections, prUpdates)
    if (isShown) await refreshPrs($, nextSections, reason, now, probed, prLog)
    // The last refresh's outcome, for the spike notes and a look at the store file.
    await writeStore($, 'debug:last', {
      at: now,
      reason,
      root,
      checkout: checkout.state,
      sections: nextSections.map(section => ({ key: section.key, state: section.state, rows: section.rows.length, ...(section.total === undefined ? {} : { total: section.total }) })),
      probe: probeLog,
      prs: prLog,
    })

    await hydrate($, options, nextSections, now)
    await pruneMappings($, options, nextSections)
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

/** Fetches the details of changed issues, a couple at a time, and their recaps where the repository consented. */
async function hydrate($: EngineInterface, options: Options, current: readonly Section[], now: number): Promise<void> {
  const chosen = await read($, settings)
  const known = await read($, details)
  const knownRecaps = await read($, recaps)
  type Task = { section: Section; row: IssueRow }
  const tasks: Task[] = []
  for (const section of current) {
    if (section.state.kind !== 'ok' || section.info === null) continue
    const consented = options.recaps && chosen.consent[section.key] === true
    for (const row of section.rows) {
      const rowKey = rowKeyOf(section.key, row.number)
      const needsDetails = !isCurrent(known[rowKey], row)
      const needsRecap = consented && !isCurrent(knownRecaps[rowKey], row)
      if (needsDetails || needsRecap) tasks.push({ section, row })
    }
  }
  const touchedRepos = new Set<string>()
  if (tasks.length > 0) {
    let next = 0
    const worker = async () => {
      while (next < tasks.length) {
        const task = tasks[next++]
        if (task === undefined) break
        await hydrateOne($, options, task.section, task.row, now)
        touchedRepos.add(task.section.key)
      }
    }
    await Promise.all(Array.from({ length: Math.min(DETAILS_CONCURRENCY, tasks.length) }, worker))
  }
  // One store write per touched repository with the meta and the recaps as they stand now.
  const allDetails = await read($, details)
  const allRecaps = await read($, recaps)
  for (const section of current) {
    if (!touchedRepos.has(section.key)) continue
    const cache = await readStore<RepoCache>($, storeKeyOf('cache:', section.key))
    const meta: Record<string, IssueMeta> = {}
    const repoRecaps: Record<string, Recap> = {}
    for (const row of section.rows) {
      const rowKey = rowKeyOf(section.key, row.number)
      const have = allDetails[rowKey]
      if (have !== undefined) meta[String(row.number)] = metaOf(have)
      const recap = allRecaps[rowKey]
      if (recap !== undefined && recap.error === undefined) repoRecaps[String(row.number)] = recap
    }
    const total = cache?.total ?? section.total
    const merged: RepoCache = { fetchedAt: cache?.fetchedAt ?? section.fetchedAt ?? now, rows: cache?.rows ?? section.rows, meta, ...(total === undefined ? {} : { total }) }
    await writeStore($, storeKeyOf('cache:', section.key), merged)
    // Recaps stay on disk only while the owner wants them for this repository.
    if (options.recaps && chosen.consent[section.key] === true) await writeStore($, storeKeyOf('recaps:', section.key), repoRecaps)
    else await $.store.delete(storeKeyOf('recaps:', section.key)).catch(() => undefined)
  }
}

async function hydrateOne($: EngineInterface, options: Options, section: Section, row: IssueRow, now: number): Promise<IssueDetails | undefined> {
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
  if (consented && have !== undefined && !isCurrent(recap, row)) {
    const made = await recapIssue($, row, have, options.language, options.recapModel, now)
    await update($, recaps, current => ({ ...current, [rowKey]: made }))
    const spent = made.usage.input_tokens + made.usage.output_tokens + made.usage.cache_read_input_tokens + made.usage.cache_creation_input_tokens
    if (spent > 0) await update($, tokens, current => current + spent)
    if (made.error !== undefined) $.ui.log(`${PLUGIN}: recap of #${row.number} failed: ${made.error}`, { to: 'debug' })
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

/** A mapping whose issue is no longer open is dropped; its session closed the issue, or someone did by hand. Only a complete list says an issue is gone. */
async function pruneMappings($: EngineInterface, options: Options, current: readonly Section[]): Promise<void> {
  const all = await read($, mappings)
  for (const section of current) {
    if (section.state.kind !== 'ok' || !isComplete(section, options)) continue
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
    const input = { issueRepo: found.section.info, codeRepo: checkout?.info ?? null, row: found.row, details: fresh, fetchedAt: new Date(now).toISOString() }
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
  const now = await $.clock.now()
  const fresh = await freshDetails($, options, found.section, found.row, now)
  if (fresh === null) return
  const input = { issueRepo: found.section.info, codeRepo: checkout?.info ?? null, row: found.row, details: fresh, fetchedAt: new Date(now).toISOString() }
  if (await fillPrompt($, options, renderBrief(input))) $.ui.toast(S.briefInPrompt)
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
  const have = (await read($, details))[rowKey]
  // A seeded entry has no body or comments: fetch them for the opened row.
  if (have !== undefined && have.fetchedAt !== 0) return
  const hash = rowKey.lastIndexOf('#')
  const found = findRow(await read($, sections), rowKey.slice(0, hash), Number(rowKey.slice(hash + 1)))
  if (found === null) return
  await hydrateOne($, options, found.section, found.row, await $.clock.now())
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

    return next(e)
  })

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

    return renderPane(
      ui,
      {
        sections: await read($, sections),
        details: await read($, details),
        recaps: await read($, recaps),
        mappings: await read($, mappings),
        prs: await read($, prs),
        sessionPrs: await read($, sessionPrs),
        settings: await read($, settings),
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
      },
    )
  })
}
