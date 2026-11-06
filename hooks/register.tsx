// Issue Radar: the open GitHub issues of the session's repository in a pane,
// and one click that starts a dedicated session per issue. The hooks module:
// the pane, the commands, the refresh pipeline, the hand-off. `$.ui.status`
// has one owner, the issue session's status line (E12); nothing else sets it.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import type { IssueDetails, IssueMeta, IssueRow, Language, Mapping, Options, Recap, RepoCache, RepoInfo, RepoSettings, RepoState, Section } from '../types'
import { MARKER, branchName, renderBackground, renderBrief, sessionName, sessionTitle, spikeBrief } from './brief'
import { isRepoSpec, listIssues, repoKey, repoLabel, resolveCheckout, resolveNamed, stateOf, viewIssue } from './github'
import { asLanguage, strings } from './i18n'
import { recapIssue } from './recap'
import { commandConsent, detachSession, focusSession, lookUpSession, parseObject, pressConsent, quietDesktop, routeInUse, startDesktopSession } from './session'
import { clean } from './text'
import { takeToast } from './toasts'
import { renderPane, rowKeyOf } from './view'

const PLUGIN = 'issue-radar'
const PANE = 'issue-radar'
const PANE_COLUMNS = 46
const DETAILS_CONCURRENCY = 2
const STORE_PREFIXES = ['cache:', 'recaps:', 'session:', 'settings:', 'debug:'] as const
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

function metaOf(details: IssueDetails): IssueMeta {
  return { updatedAt: details.updatedAt, commentCount: details.commentCount, excerpt: details.excerpt, linkedPrs: details.linkedPrs }
}

/** Details or a recap are current while they are at least as new as the row (ISO times compare as text). */
function isCurrent(have: { updatedAt: string } | undefined, row: IssueRow): boolean {
  return have !== undefined && have.updatedAt >= row.updatedAt
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
        nextSections.push({
          key: sectionKey,
          spec: target.spec,
          info: target.info,
          state: useCache ? { kind: 'ok' } : (before?.state ?? { kind: 'ok' }),
          rows: useCache ? cachedRows : (before?.rows ?? cachedRows),
          fetchedAt: useCache ? cachedAt : (before?.fetchedAt ?? cachedAt),
          isCheckout: target.isCheckout,
        })
        continue
      }
      const listed = await listIssues($, target.info, options.maxIssues)
      if ('state' in listed) {
        if (listed.state.kind === 'rate-limited') backoffUntil.set(sectionKey, now + 10 * 60_000)
        else if (listed.state.kind === 'offline') backoffUntil.set(sectionKey, now + 2 * 60_000)
        // The last good list stays visible under the error.
        nextSections.push({ key: sectionKey, spec: target.spec, info: target.info, state: listed.state, rows: before?.rows ?? cachedRows, fetchedAt: before?.fetchedAt ?? cachedAt, isCheckout: target.isCheckout })
        continue
      }
      backoffUntil.delete(sectionKey)
      const open = new Set(listed.rows.map(row => String(row.number)))
      const meta = Object.fromEntries(Object.entries(cachedMeta.get(sectionKey) ?? {}).filter(([number]) => open.has(number)))
      cachedMeta.set(sectionKey, meta)
      const fresh: RepoCache = { fetchedAt: now, rows: listed.rows, meta }
      await writeStore($, storeKeyOf('cache:', sectionKey), fresh)
      nextSections.push({ key: sectionKey, spec: target.spec, info: target.info, state: { kind: 'ok' }, rows: listed.rows, fetchedAt: now, isCheckout: target.isCheckout })
    }

    // Seed details from the cache for issues this session has not fetched yet, and drop what no live row needs.
    const live = new Set(nextSections.flatMap(section => section.rows.map(row => rowKeyOf(section.key, row.number))))
    await update($, details, current => {
      const next: Record<string, IssueDetails> = {}
      for (const [rowKey, have] of Object.entries(current)) if (live.has(rowKey)) next[rowKey] = have
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
    // The last refresh's outcome, for the spike notes and a look at the store file.
    await writeStore($, 'debug:last', {
      at: now,
      reason,
      root,
      checkout: checkout.state,
      sections: nextSections.map(section => ({ key: section.key, state: section.state, rows: section.rows.length })),
    })

    await hydrate($, options, nextSections, now)
    await pruneMappings($, options, nextSections)
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
    const merged: RepoCache = { fetchedAt: cache?.fetchedAt ?? section.fetchedAt ?? now, rows: cache?.rows ?? section.rows, meta }
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

/** A mapping whose issue is no longer open is dropped; its session closed the issue, or someone did by hand. Only an uncapped list says an issue is gone. */
async function pruneMappings($: EngineInterface, options: Options, current: readonly Section[]): Promise<void> {
  const all = await read($, mappings)
  for (const section of current) {
    if (section.state.kind !== 'ok' || section.rows.length >= options.maxIssues) continue
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

/** The fresh details the brief needs; `null` when the issue is closed or gh failed (the owner is told). */
async function freshDetails($: EngineInterface, options: Options, section: Section, row: IssueRow, now: number): Promise<IssueDetails | null> {
  const S = strings(options.language)
  if (section.info === null) return null
  const viewed = await viewIssue($, section.info, row, now)
  if ('state' in viewed) {
    $.ui.toast(clean(S.error(viewed.state.detail ?? viewed.state.kind)))

    return null
  }
  const rowKey = rowKeyOf(section.key, row.number)
  await update($, details, current => ({ ...current, [rowKey]: viewed.details }))
  if (viewed.details.state.toUpperCase() !== 'OPEN') {
    $.ui.toast(S.closedMeanwhile(row.number))
    await update($, sections, current => current.map(found => (found.key === section.key ? { ...found, rows: found.rows.filter(item => item.number !== row.number) } : found)))
    await saveMapping($, rowKey, null)

    return null
  }

  return viewed.details
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
  settingsKey = null
  await update($, sections, () => [])
  await update($, details, () => ({}))
  await update($, recaps, () => ({}))
  await update($, mappings, () => ({}))
  await update($, settings, () => DEFAULT_SETTINGS)
  await update($, opened, () => '')
  await update($, tokens, () => 0)
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
