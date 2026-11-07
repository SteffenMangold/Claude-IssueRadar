// Issue Radar: the open GitHub issues of the session's repository in a pane,
// and one click that starts a dedicated session per issue. The hooks module:
// the pane, the commands, the refresh pipeline, the hand-off. `$.ui.status`
// has one owner, the issue session's status line (E12); nothing else sets it.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, PromptAutocompleteSuggestion, PromptSubmitInput, Register, RenderSurface, Timer, TurnCompleteReason } from 'claude-code'

import type { Attached, AttachedRecord, Boards, ClosedCache, DoneMapping, Filter, ForkState, Glimpse, Inbox, IssueDetails, IssueMeta, IssueRow, Language, Mapping, Options, PhaseActivity, PhaseAsk, PhaseRecord, PrRecord, PreviousAttempt, Recap, RepoCache, RepoInfo, RepoSettings, RepoState, Section, SeenRecord, SelfIssue, SessionLive, SidebarChoice, StartChoice, StartFacts, StartForm, Triage } from '../types'
import { FIX_LINE, MARKER, branchName, renderBackground, renderBrief, sessionName, sessionTitle, spikeBrief } from './brief'
import type { BriefOptions } from './brief'
import { asClosedCache, closedRecord, isClosedDue, listClosed, sinceDate } from './closed'
import type { ClosedReason } from './closed'
import { MENTION_LIMITS, TOOL_LIMITS, renderIssueText } from './context'
import { DEFAULT_FILTER, MAX_VIEWS, TYPED_CHARS, asSavedViews, cleanViewName, cutText, effectiveQuery, facetsOf, filterKey, metaBound, retainMeta, sameFacets, sanitizeQuery, viewIdOf } from './filter'
import { cleanSpec, compactDetails, dropRelations, firstLine, isRepoSpec, listIssues, metaOf, repoKey, repoLabel, repoSpec, resetRelations, resolveCheckout, resolveNamed, specKey, stateOf, viewIssue, viewIssueNumber, viewParent } from './github'
import type { ToolRead } from './github'
import { MAPPED_MAX, PROBE_MAX, PROBE_PAUSE_MS, fetchBoards, fetchPrLinks } from './graph'
import { asLanguage, strings } from './i18n'
import { INBOX_CAP, asInboxCache, failedInbox, inboxFromRecord, inboxPeriod, isInboxDue, searchAssigned } from './inbox'
import { ISSUE_TOOL, ISSUE_TOOL_SPEC, mayRead, parseToolInput, refusalText, stateText, toolArguments, toolError } from './issuetool'
import type { ToolAsk, Verdict } from './issuetool'
import { ARRIVAL_TOAST_MS, LOOK_THROTTLE_MS, MARK_HOLD_MS, SEEN_KEEP_FACTOR, arrivalText, arrivalsOf, cardRowsOf, foldFaded, isFilteredList, markOf, nextFade, paneLayout, readSeen, rowKeyOf, rowsInView, seenRecordOf, unreadCount, withRow } from './marks'
import type { PaneLike, RowTop } from './marks'
import { briefIssueKey, describeIssue, findMentions, infoFromIssueUrl, isRecentlyAttached, keyOfRemote, mentionRef, parseMentionToken, resolveMentions, suggestIssues, withAttached } from './mentions'
import type { KnownIssue } from './mentions'
import { askOf, parseMarker, phaseFor, proposalsDue, readPhase, samePhases, statusText, toastRef } from './phase'
import type { Marker } from './phase'
import { asRecord, isPrsDue, mergeLinks, recordOf } from './prs'
import { RECAP_VERSION, asRecap, isBetterRecap, isRecapCurrent, isRecapFor, isRecapUsable, recapIssue } from './recap'
import { commandConsent, detachQuietly, detachSession, isTypingRefusal, listSessions, lookUpSession, openSessionIn, parseObject, peekForPress, peekSession, pressConsent, quietDesktop, readPrStatus, readSelfId, routeInUse, settleWithin, startDesktopSession, unarchiveSession } from './session'
import type { Listing, OpenOutcome, Peek, SessionEntry, StartArgs, StartOutcome } from './session'
import { FILE_TRIES, SIDEBAR_GROUP, TITLE_GAP_MS, asSidebarChoice, groupFor, isOffScreen, parseGroupId, parseGroups, parseSections, storedGroupId, viewShowsGroup } from './sidebar'
import { DEFAULT_CHOICE, GUIDANCE_CHARS, asEffort, asModel, asksOptions, cleanGuidance, cleanNote, forkState, looksSecret, optionsHeld, parseGitFacts } from './startform'
import { clean } from './text'
import { probeEngaged, runTiers } from './tiers'
import { offerToast, takeToast } from './toasts'
import { asAttempts, asDone, goneLive, isOwnSession, liveOf, withAttempt } from './tracking'
import { renderPane, shortAgo } from './view'

const PLUGIN = 'issue-radar'
const PANE = 'issue-radar'
const PANE_COLUMNS = 46
const DETAILS_CONCURRENCY = 2
const STORE_PREFIXES = ['cache:', 'recaps:', 'session:', 'settings:', 'debug:', 'prs:', 'inbox:', 'closed:', 'seen:', 'phase:', 'attempts:', 'done:', 'sidebar:'] as const
/** E10: how often a shown pane re-reads its mapped rows' issue-session records from the store (no gh, no model, no desktop call). */
const PHASE_SYNC_MS = 15_000
/** E12: a record without a mapping is swept once it is this old (the pane's hygiene at a session's start). */
const PHASE_KEEP_MS = 24 * 60 * 60_000
/** E22-b: how long the session of a closed issue stays reachable from its closed row. */
const DONE_KEEP_MS = 14 * 24 * 60 * 60_000
/** E1: the shortest gap between two tracking passes the mod asks for itself (a refresh's pass always runs). */
const TRACK_GAP_MS = 10_000
/** E1: how many sessions a pass reads one by one (get_session) beyond the listing, rotating. */
const PEEK_BUDGET = 3
/** E1: re-reads after the pane's own actions: a start, a reopen, a turn of the pane's session while its child is linked. */
const TRACK_AFTER_START_MS = 8_000
const TRACK_AFTER_REOPEN_MS = 3_000
const TRACK_AFTER_TURN_MS = 1_500
/** E1 (A-F12): how long a start whose answer carried no readable id is looked for in the listing, and no second start is made. */
const UNPARSED_MS = 10 * 60_000
/** E12: at how many of its first main-loop turns a session not yet identified asks whether it is an issue session. */
const IDENTIFY_TURNS = 3
/** E12: how long a failed read of this session's desktop id waits before it is tried again. */
const SELF_RETRY_MS = 60_000
/**
 * E12 (B-E12-1 within plan 4.2, B5-BEH-1): how long the first refresh and a desktop attach wait for the desktop-id
 * identification before they go on; one that lands later still stands the session down and closes the pane.
 */
const IDENTIFY_WAIT_MS = 1_500
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
/** E6: how long a tool read of GitHub answers again without a new read (plan section 3: 60 s reuse). */
const TOOL_FRESH_MS = 60_000
/** E6: `fresh: true` reads GitHub at most this often per issue; a model looping on it gets the last read (C-E6-5). */
const TOOL_FRESH_FLOOR_MS = 10_000
/** E6: how many tool reads the module keeps for that reuse (the newest; a reload forgets them). */
const TOOL_READS_KEPT = 20
/** E6: how long the tool waits before it resolves a checkout gh could not resolve again. */
const TOOL_RESOLVE_RETRY_MS = 60_000
/** E2: the typeahead's rows at most. */
const MAX_SUGGESTIONS = 8
/** E2: the issues one prompt carries at most; the others are named in the transcript line. */
const MAX_ATTACH = 3
/** E2: an issue the conversation carries unchanged is not attached again within this many user turns. */
const REATTACH_TURNS = 4
/** E2: the entries the attached record keeps. */
const ATTACHED_KEPT = 100
/** E2: the prompts a person sent (C-E2-10: the desktop stamps a typed prompt composer, bridge, sdk or unclassified). */
const PERSON_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'sdk', 'unclassified'])
const NO_ATTACHED: AttachedRecord = { conversation: '', entries: {} }

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
const attached = atom({ plugin: 'issue-radar', key: 'attached' } as const, NO_ATTACHED, { shape: 'attached-1' })
const selfIssue = atom({ plugin: 'issue-radar', key: 'selfIssue' } as const, null, { shape: 'self-issue-1' })
const ownPhase = atom({ plugin: 'issue-radar', key: 'ownPhase' } as const, null, { shape: 'own-phase-1' })
const desktopId = atom({ plugin: 'issue-radar', key: 'desktopId' } as const, '')
const turnRunning = atom({ plugin: 'issue-radar', key: 'turnRunning' } as const, null, { shape: 'turn-running-1' })
const phases = atom({ plugin: 'issue-radar', key: 'phases' } as const, {}, { shape: 'phases-1' })
const phaseSeen = atom({ plugin: 'issue-radar', key: 'phaseSeen' } as const, { since: 0, seen: {} }, { shape: 'phase-seen-1' })
const sessionLive = atom({ plugin: 'issue-radar', key: 'sessionLive' } as const, {}, { shape: 'session-live-1' })
const attempts = atom({ plugin: 'issue-radar', key: 'attempts' } as const, {}, { shape: 'attempts-1' })
const freshAsk = atom({ plugin: 'issue-radar', key: 'freshAsk' } as const, '')
const done = atom({ plugin: 'issue-radar', key: 'done' } as const, {}, { shape: 'done-1' })
const startForm = atom({ plugin: 'issue-radar', key: 'startForm' } as const, null, { shape: 'start-form-1' })
const startFacts = atom({ plugin: 'issue-radar', key: 'startFacts' } as const, null, { shape: 'start-facts-1' })
const sidebar = atom({ plugin: 'issue-radar', key: 'sidebar' } as const, { choice: 'unasked' }, { shape: 'sidebar-1' })

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
let hasLoggedStatusRaw = false
/** E10: the store-only sync of the mapped rows' issue-session records while the pane is shown. */
let phaseTimer: Timer | undefined
/** E1: a tracking pass in flight (one at a time), when the last one ran, and a re-read the mod asked for. */
let isTracking = false
let lastTrackAt = Number.NEGATIVE_INFINITY
let trackDelayed: Timer | undefined
/** E1: where the rotating get_session reads of a full listing go on. */
let peekCursor = 0
/** E1: the session ids the last listing that answered held, and when: a start without a readable id is adopted only by a new one (A-F12). */
let lastListed: { at: number; ids: Set<string> } | null = null
/**
 * E1 (A-F12): starts whose answer carried no readable session id, by row key: looked for by name or title in the next
 * listings for ten minutes, and no second start meanwhile. Module memory: a reload forgets them (the toast said so).
 */
const unparsed = new Map<string, { title: string; name: string; branch: string; at: number; before: Set<string> | null }>()
/** E12: the identification by the desktop's id in flight (the start refresh waits for it before it decides about the pane). */
let identifying: Promise<boolean> | null = null
/** E12: how many main-loop turns of an unidentified session asked; when a failed read of the desktop id may be tried again. */
let identifyTurns = 0
let selfRetryAt = 0
/** E12: the read of this session's desktop id in flight, shared by every caller, so a second caller waits for it (R5-RT-1). */
let selfRead: Promise<string> | null = null
/**
 * E12: this module found that it is an issue session (identifySelf). Every state read of one hook dispatch sees one moment,
 * so a dispatch that waited for an identification another task finished reads the moment before it: it asks this instead.
 */
let isSelfFound = false
/** E12/E10: the turn hooks' and the dialog hook's work, one after another in hook order, so a turn's end never lands after the next turn's start (R5-RT-2). */
let phaseChain: Promise<void> = Promise.resolve()
/** E1: a re-read the mod asked for while a pass ran: it runs once that pass ends, instead of being dropped (R5-RT-3). */
let trackAgain = false
/** E12: the status line as last set, so an unchanged line is not set again. */
let statusShown: string | undefined
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
/**
 * E6: the issue tool's full name once this session registered it (or, after a hot reload, found it among the
 * session's tools); null before, or where the host adds no tools. Registered is not yet callable: issueToolOf decides.
 */
let issueToolName: string | null = null
/** E6: what this module has seen of the registration, before any attempt. */
const NOT_TRIED = 'not tried yet'
/** E6: why the tool is not registered, for the spike. */
let issueToolProblem = NOT_TRIED
/**
 * E6: the tool's reads of GitHub by row key, the newest 20, with their 20 comments: they answer again within 60 s, and
 * an unlisted issue or an extended read has nowhere else to live (C-E6-5); never in `$.state` or the store (C-E6-2).
 */
const toolReads = new Map<string, { at: number; read: ToolRead }>()
/** E6: when the tool last resolved the checkout itself (a failure is tried again after a minute, not on every call). */
let checkoutTriedAt = Number.NEGATIVE_INFINITY
/** E6: the tool's checkout resolution in flight: calls that overlap share one `gh repo view`, and a refresh waits for it (R4-RT-4). */
let resolvingCheckout: Promise<void> | null = null
/** E6: the tool's demand reads in flight by row key: calls that overlap for one issue share one `gh issue view` (R4-RT-4). */
const toolReading = new Map<string, Promise<Viewed>>()
/** E2: the origin of the last prompt, for the spike (S16: what the desktop stamps on a typed prompt). */
let lastPromptOrigin = ''
/**
 * E20: the start form's note as typed, per row, never in the state: an Input the hook redraws with each keystroke's
 * echo drops characters (V1's rule), so only Enter writes the state. A hot reload forgets a draft; a kept note stays.
 */
const noteDrafts = new Map<string, string>()
/**
 * E21: the main loop's running turn as the turn hooks saw it, in module memory, since a read of the state within one
 * dispatch sees the moment it began (a turn that started during a press would not show). Undefined after a hot reload
 * until the next turn: the state's turnRunning answers then.
 */
let mainTurn: { turnId: string; since: number } | null | undefined
/**
 * E12/E13: the record this issue session wrote last, in module memory as well: the turn hooks and E13's tidy write it
 * from different dispatches, and each must build on the other's latest write, not on its dispatch's moment.
 */
let ownLatest: PhaseRecord | null = null
/** E13: the tidy that runs after an identification or a main-loop turn (its own dispatch), one pending at a time. */
let tidyTimer: Timer | undefined
let isTidying = false
/** E13: when the issue session last compared its title with its issue's (at most every ten minutes). */
let lastTitleCheck = Number.NEGATIVE_INFINITY

type Resolved = { spec: string; info: RepoInfo | null; state: RepoState; isCheckout: boolean }
/** What one `gh issue view` of the tool came back with. */
type Viewed = Awaited<ReturnType<typeof viewIssueNumber>>
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
    issueMentions: flag('issueMentions', true),
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
  // E8 and E20: kept only when they say something; the guidance is cleaned and cut again (another session wrote it).
  if (value['beside'] === true) settled.beside = true
  const guidance = typeof value['guidance'] === 'string' ? cleanGuidance(value['guidance']).text : ''
  if (guidance !== '') settled.guidance = guidance

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
  // E1: the earlier attempts, and E22-b: the sessions of closed issues, come along (another pane may have written them).
  const tries: Record<string, PreviousAttempt[]> = {}
  const finished: Record<string, DoneMapping> = {}
  for (const key of keys) {
    if (key.startsWith('attempts:')) {
      const list = asAttempts(await readStore<unknown>($, key))
      if (list.length > 0) tries[key.slice('attempts:'.length)] = list
      continue
    }
    if (key.startsWith('done:')) {
      const record = asDone(await readStore<unknown>($, key))
      if (record !== undefined) finished[key.slice('done:'.length)] = record
      continue
    }
    if (!key.startsWith('session:')) continue
    const value = asMapping(await readStore<unknown>($, key))
    if (value !== undefined) found[key.slice('session:'.length)] = value
  }
  // Written only on a change: every atom write redraws the pane.
  if (JSON.stringify(await read($, attempts)) !== JSON.stringify(tries)) await update($, attempts, () => tries)
  if (JSON.stringify(await read($, done)) !== JSON.stringify(finished)) await update($, done, () => finished)
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
  // So do the app's word on the old session (E1, A-F11) and its own record (E10); a released row's record leaves the
  // store too: the pane's only write to a key the issue session owns, and hygiene (B crossCutting 5).
  const isOld = (sessionId: string | undefined) => sessionId !== undefined && (mapping === null || sessionId !== mapping.sessionId)
  if (isOld((await read($, sessionLive))[rowKey]?.sessionId)) await update($, sessionLive, current => withoutKey(current, rowKey))
  const record = (await read($, phases))[rowKey]
  if (record !== undefined && (mapping === null || phaseFor(record, mapping) === null)) await update($, phases, current => withoutKey(current, rowKey))
  if (mapping === null) await $.store.delete(storeKeyOf('phase:', rowKey)).catch(() => undefined)
}

/** `record` without `key`; the same object when it has none (an unchanged atom write still redraws). */
function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]

  return next
}

/**
 * E1: releases a mapping whose session the app reports archived or gone, keeping it as an attempt of the issue (at most
 * three, the newest first): the next brief names it, so the new session looks for its branch and pull request.
 */
async function releaseMapping($: EngineInterface, rowKey: string, mapping: Mapping, endedAs: PreviousAttempt['endedAs'], branch: string | null): Promise<void> {
  const now = await $.clock.now()
  const known = branch ?? mapping.branch ?? null
  const attempt: PreviousAttempt = { sessionId: mapping.sessionId, title: mapping.title, startedAt: mapping.startedAt, endedAs, at: now }
  if (known !== null && known !== '') {
    attempt.branch = known
    // The slug the pane asked for is only the middle of the branch's name (A-F18); the app's own word is the name.
    if (branch === null) attempt.isSlug = true
  }
  const key = storeKeyOf('attempts:', rowKey)
  const list = withAttempt(asAttempts(await readStore<unknown>($, key)), attempt)
  await writeStore($, key, list)
  await update($, attempts, current => ({ ...current, [rowKey]: list }))
  await saveMapping($, rowKey, null)
}

/** E22-b: a mapping whose issue closed is kept as the closed row's session for two weeks, then released as before. */
async function retireMapping($: EngineInterface, rowKey: string, mapping: Mapping | undefined): Promise<void> {
  if (mapping !== undefined) {
    const record: DoneMapping = { v: 1, sessionId: mapping.sessionId, title: mapping.title, startedAt: mapping.startedAt, startedFrom: mapping.startedFrom, closedAt: await $.clock.now() }
    if (await writeStore($, storeKeyOf('done:', rowKey), record)) await update($, done, current => ({ ...current, [rowKey]: record }))
  }
  await saveMapping($, rowKey, null)
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
    attempts: await read($, attempts),
    done: await read($, done),
    isFilterOpen: await read($, isFilterOpen),
    isSettingsOpen: await read($, isSettingsOpen),
    columns: viewport.columns,
    startForm: await read($, startForm),
    isSidebarAsking: await isSidebarAsking($),
  }
}

/** E13: whether the pane draws its question to file issue sessions in the sidebar (desktop only, not asked yet, a row mapped). */
async function isSidebarAsking($: EngineInterface): Promise<boolean> {
  if ((await read($, sidebar)).choice !== 'unasked' || Object.keys(await read($, mappings)).length === 0) return false
  const surfaces = await $.session.surfaces().catch(() => [])

  return surfaces.some(surface => surface === 'desktop')
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
 * while it holds, so a redraw never races the typing (F X-1): E20's start form under a row. The settings panel's
 * fields (the watch list, E20's guidance) draw no value and keep their text across redraws, so they do not count; the
 * filter panel neither (E14). Batch 7's editors add their atoms here.
 */
async function isEditing($: EngineInterface): Promise<boolean> {
  return (await read($, startForm)) !== null
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
  armPhaseSync($, options)
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

/**
 * E10: while the pane is shown and a row is mapped, the mapped rows' issue-session records are read from the store every
 * 15 s (plan 4.5's cheap store-only sync: no gh, no model, no desktop call), whatever the refresh interval says.
 */
function armPhaseSync($: EngineInterface, options: Options): void {
  if (phaseTimer !== undefined) return
  phaseTimer = $.clock.every(PHASE_SYNC_MS, () => {
    void (async () => {
      if (Object.keys(await read($, mappings)).length > 0 && (await mayRunInBackground($))) await syncPhases($, options)
    })().catch(() => undefined)
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
  phaseTimer?.cancel()
  phaseTimer = undefined
  trackDelayed?.cancel()
  trackDelayed = undefined
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
  // E22-b: their sessions stay reachable from the closed rows for a while.
  for (const number of outcome.released) await retireMapping($, rowKeyOf(sectionKey, number), all[rowKeyOf(sectionKey, number)])
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
 * E1: one pass over the mapped rows' sessions, after a refresh as its own task (never awaited by it, A-F4), only while
 * the pane is shown (D X-1), one at a time. One quiet list_sessions (no `linked`, no `include_archived`, A-F3): a mapped
 * id it lists is active; one it misses while it lists fewer than its limit is read once (get_session): found means
 * archived, the app's "not found" gone; a full listing's misses are read three at a time, rotating. Every call is quiet
 * (never a card) and raced against a timeout; a failed listing keeps the last word. The pass only feeds the badge: it
 * never releases a mapping (the click validates, as in V1). Nothing of the listing reaches the store but the spike's
 * note in `debug:sessions` (counts, keys and state words, never a title). Then E3's pull-request reads, folded in here.
 */
async function trackSessions($: EngineInterface, options: Options, current: readonly Section[], isForced: boolean, isReRead = false): Promise<void> {
  if (isTracking) {
    // A re-read the mod asked for (after a start, a reopen) runs once the pass in flight ends (R5-RT-3).
    if (isReRead) trackAgain = true

    return
  }
  isTracking = true
  try {
    if (!(await mayRunInBackground($))) return
    const now = await $.clock.now()
    if (!isForced && now - lastTrackAt < TRACK_GAP_MS) return
    lastTrackAt = now
    const shown = new Set(current.flatMap(section => section.rows.map(row => rowKeyOf(section.key, row.number))))
    const all = await read($, mappings)
    const ids = await ownIds($)
    const wanted = Object.entries(all).filter(([rowKey]) => shown.has(rowKey))
    const pending = [...unparsed.values()].some(start => now - start.at < UNPARSED_MS)
    if (wanted.length === 0 && !pending) {
      if (Object.keys(await read($, sessionLive)).length > 0) await update($, sessionLive, () => ({}))
      if (Object.keys(await read($, sessionPrs)).length > 0) await update($, sessionPrs, () => ({}))

      return
    }
    const listing = await listSessions($)
    const previous = await read($, sessionLive)
    const found: Record<string, SessionLive> = {}
    const toPeek: Array<{ rowKey: string; mapping: Mapping; isComplete: boolean }> = []
    const keep = (rowKey: string, mapping: Mapping) => {
      const had = previous[rowKey]
      if (had?.sessionId === mapping.sessionId) found[rowKey] = had
    }
    for (const [rowKey, mapping] of wanted) {
      // The pane drawn inside its own issue session: the view draws `this session`; the app never lists the current one.
      if (isOwnSession(mapping, ids)) continue
      const entry = listing.ok ? listing.entries.find(item => item.id === mapping.sessionId) : undefined
      if (entry !== undefined) found[rowKey] = liveOf(entry, entry.archived === true ? 'archived' : 'active', now)
      else if (!listing.ok) keep(rowKey, mapping)
      else {
        // Unlisted again after a read said archived or gone: that stands (a restored session is listed again); no read.
        const had = previous[rowKey]
        if (had?.sessionId === mapping.sessionId && (had.presence === 'gone' || had.presence === 'archived')) found[rowKey] = had
        else toPeek.push({ rowKey, mapping, isComplete: !listing.isFull })
      }
    }
    // Missing from a complete listing first (each says archived or gone); then a full listing's misses; each rotating.
    const rotate = <T,>(list: readonly T[]): T[] => (list.length === 0 ? [] : [...list.slice(peekCursor % list.length), ...list.slice(0, peekCursor % list.length)])
    const order = [...rotate(toPeek.filter(item => item.isComplete)), ...rotate(toPeek.filter(item => !item.isComplete))]
    peekCursor += PEEK_BUDGET
    const peeks: string[] = []
    for (const [index, item] of order.entries()) {
      if (index >= PEEK_BUDGET) {
        keep(item.rowKey, item.mapping)
        continue
      }
      const peek = await peekSession($, item.mapping.sessionId)
      peeks.push(peek.kind)
      if (peek.kind === 'gone') found[item.rowKey] = goneLive(item.mapping.sessionId, now)
      else if (peek.kind === 'found') {
        // Found but not listed: archived, when the listing was complete or the app says so; an explicit "not archived" is active.
        const flag = peek.entry.archived
        const presence: SessionLive['presence'] = flag === true || (flag === null && item.isComplete) ? 'archived' : flag === false ? 'active' : 'unknown'
        found[item.rowKey] = { ...liveOf(peek.entry, presence, now), sessionId: item.mapping.sessionId }
      } else keep(item.rowKey, item.mapping)
    }
    // Row by row against the store's mappings as they stand now: a release or a new start during the pass never gets
    // the old session's word back (A-F11); a word a press wrote after the pass began is newer than the pass's (R5-RT-3).
    const latest = await read($, mappings)
    await update($, sessionLive, had => {
      const next: Record<string, SessionLive> = {}
      for (const [rowKey, live] of Object.entries(found)) if (latest[rowKey]?.sessionId === live.sessionId) next[rowKey] = live
      for (const [rowKey, live] of Object.entries(had)) if (live.at > now && latest[rowKey]?.sessionId === live.sessionId) next[rowKey] = live

      return next
    })
    if (listing.ok) {
      await adoptUnparsed($, options, listing.entries, now)
      lastListed = { at: now, ids: new Set(listing.entries.map(entry => entry.id)) }
    }
    await noteSessions($, listing, peeks, now)
    await readSessionPrs($, wanted, found)
  } catch (error) {
    $.ui.log(`${PLUGIN}: tracking the sessions failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
  } finally {
    isTracking = false
    if (trackAgain) {
      trackAgain = false
      scheduleTrack($, options, 0)
    }
  }
}

/** The spike's note on the last pass (S20): how the listing went, the keys of its first entry, the state words met; no title. */
async function noteSessions($: EngineInterface, listing: Listing, peeks: readonly string[], now: number): Promise<void> {
  const words = listing.ok ? [...new Set(listing.entries.map(entry => entry.state).filter(word => word !== ''))].slice(0, 24) : []
  await writeStore($, 'debug:sessions', {
    at: now,
    list: listing.ok ? { ok: true, count: listing.entries.length, isFull: listing.isFull, keys: listing.entries[0]?.keys ?? [] } : { ok: false, reason: listing.reason.slice(0, 200) },
    words,
    peeks,
  })
}

/** This session's ids: its engine id, and its desktop id once known (S4: the two may differ). */
async function ownIds($: EngineInterface): Promise<string[]> {
  return [myId, await read($, desktopId)].filter(id => id !== '')
}

/** Runs a tracking pass after `delayMs` (one pending at a time): the re-read after a start, a reopen, a turn of the pane's session. */
function scheduleTrack($: EngineInterface, options: Options, delayMs: number, isForced = true): void {
  trackDelayed?.cancel()
  trackDelayed = $.clock.after(delayMs, () => {
    trackDelayed = undefined
    void (async () => trackSessions($, options, await read($, sections), isForced, true))().catch(() => undefined)
  })
}

/**
 * E1 (A-F12): a start whose answer carried no readable id is looked for in the listing for ten minutes: exactly one
 * entry named as the start named it (its short name or title), mapped to no row, no earlier attempt of the issue, not
 * archived, and new: started by this session where the app says who started it (a linked session carries `startedBy`),
 * else absent from the listing before the start. It is adopted (mapping, detach, toast), so the duplicate-start guard is
 * back; anything else waits, and nothing is guessed.
 */
async function adoptUnparsed($: EngineInterface, options: Options, entries: readonly SessionEntry[], now: number): Promise<void> {
  if (unparsed.size === 0) return
  const S = strings(options.language)
  for (const [rowKey, start] of [...unparsed]) {
    if (now - start.at >= UNPARSED_MS) {
      unparsed.delete(rowKey)
      continue
    }
    const all = await read($, mappings)
    if (all[rowKey] !== undefined) {
      unparsed.delete(rowKey)
      continue
    }
    const mappedIds = new Set(Object.values(all).map(mapping => mapping.sessionId))
    const earlier = new Set(((await read($, attempts))[rowKey] ?? []).map(attempt => attempt.sessionId))
    const named = entries.filter(entry => (entry.name === start.name || entry.title === start.title) && !mappedIds.has(entry.id) && !earlier.has(entry.id) && entry.archived !== true)
    const ids = named.some(entry => entry.startedBy !== null) ? await knownOwnIds($) : await ownIds($)
    const matches = named.filter(entry => (entry.startedBy !== null ? ids.includes(entry.startedBy) : start.before !== null && !start.before.has(entry.id)))
    const entry = matches[0]
    if (matches.length !== 1 || entry === undefined) continue
    unparsed.delete(rowKey)
    const held = await read($, checkoutKey)
    const adopted: Mapping = { sessionId: entry.id, title: start.title, startedAt: start.at, startedFrom: myId, detached: entry.detached === true, branch: start.branch, ...(held === '' ? {} : { checkoutKey: held }) }
    await saveMapping($, rowKey, adopted)
    if (entry.detached !== true && (await detachQuietly($, entry.id))) await saveMapping($, rowKey, { ...adopted, detached: true })
    $.ui.toast(clean(S.adopted(start.title)), { timeoutMs: 6_000 })
  }
}

/** This session's ids with the desktop's read first where it is not known yet (one quiet read per process at most a minute). */
async function knownOwnIds($: EngineInterface): Promise<string[]> {
  await resolveDesktopId($)

  return ownIds($)
}

/**
 * E3's optional layer, folded into E1's pass: the pull request the app binds to each mapped issue session (`ccd_pr`
 * `get_status`), read quietly (never a card), at most once a minute per session, each session backing off on its own
 * for ten minutes after a failure (E3-1). A session whose list row says it names no pull request, or that is archived or
 * gone, is not asked; one whose row has no such field is (the field is not documented, S20). The app's cache costs no
 * GitHub budget.
 */
async function readSessionPrs($: EngineInterface, wanted: ReadonlyArray<[string, Mapping]>, found: Readonly<Record<string, SessionLive>>): Promise<void> {
  try {
    const live = new Set(wanted.map(([rowKey]) => rowKey))
    const all = Object.fromEntries(wanted)
    for (const [rowKey, mapping] of wanted) {
      const word = found[rowKey]
      if (word !== undefined && (word.pr === 'no' || word.presence === 'gone' || word.presence === 'archived')) continue
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
      await update($, sessionPrs, had => {
        const next = { ...had }
        // The session it was read for goes with it: the row draws it only while its mapping still names that session.
        if (look.kind === 'pr') next[rowKey] = { ...look.pr, sessionId: mapping.sessionId }
        else delete next[rowKey]

        return next
      })
    }
    await update($, sessionPrs, had => Object.fromEntries(Object.entries(had).filter(([rowKey, pr]) => live.has(rowKey) && all[rowKey] !== undefined && all[rowKey]?.sessionId === pr.sessionId)))
  } catch (error) {
    $.ui.log(`${PLUGIN}: reading the sessions' pull requests failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
  }
}

/** A session whose root moved (a `/cd`, a worktree move) forgets the checkout and the watched repositories it resolved (C-E6-7). */
function forgetOtherRoot(root: string): void {
  if (checkout === null || checkout.root === root) return
  checkout = null
  named.clear()
  toolReading.clear()
}

/**
 * The checkout's key decides which settings the session reads: on a change, the stored settings and the key go into the
 * state. The key is taken only once both are in (R4-INT-3): the refresh and the tool adopt it, and a caller that came
 * meanwhile reads and writes the same again rather than going on with the settings of before.
 */
async function adoptSettingsKey($: EngineInterface, key: string): Promise<void> {
  if (settingsKey === key) return
  const stored = key === '' ? undefined : await readStore<unknown>($, storeKeyOf('settings:', key))
  await update($, settings, () => readSettings(stored))
  await update($, checkoutKey, () => key)
  settingsKey = key
}

async function refresh($: EngineInterface, options: Options, reason: Reason): Promise<void> {
  if (isRunning) {
    // The ask is kept with its reason (E7-2, E11-2): a ↻ pressed meanwhile still runs as the owner's press.
    queuedReason = strongerReason(queuedReason, reason)

    return
  }
  isRunning = true
  /** Whether this refresh decides about the pane (the first one): an identification that lands during it stops it (B5-BEH-1). */
  const isFirst = !paneDecided
  try {
    await update($, isRefreshing, () => true)
    const now = await $.clock.now()
    const root = await $.session.root()
    // Another pane, or an issue session of this project, may have started or released a session since the last refresh.
    const known = await loadMappings($)
    // E13: another pane may have answered the sidebar question meanwhile.
    await loadSidebar($)
    // E12 (B-E12-1): before the first refresh decides about the pane, this session asks whether it is an issue session
    // (its desktop id in a mapping); one that is stands down here, before any gh call. The wait is bounded (plan 4.2: no
    // desktop call blocks the GitHub part, B5-BEH-1): an answer that comes later still stands the session down.
    if (!paneDecided) {
      if ((await identifiedSoon($)) || isSelfFound || (await read($, isIssueSession))) {
        standDown()

        return
      }
    }
    forgetOtherRoot(root)
    // After a hot reload the pane is still up while this module's memory is fresh.
    if (!wantsPane && (await isPaneOpen($))) wantsPane = true
    // The checkout first: its settings name the other repositories. A resolution the tool has under way is waited for,
    // not repeated (R4-RT-4).
    if (resolvingCheckout !== null) await resolvingCheckout
    if (checkout === null || checkout.root !== root || checkout.info === null) checkout = { root, ...(await resolveCheckout($, root)) }
    await adoptSettingsKey($, checkout.info === null ? '' : repoKey(checkout.info))
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
    // E20 (B-E20-7): a start form whose row left the list, or whose issue got a session meanwhile (another pane), closes.
    const form = await read($, startForm)
    if (form !== null && (!live.has(form.rowKey) || known[form.rowKey] !== undefined)) await closeForm($, form.rowKey)
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

    // E12 (B5-BEH-1): an identification that landed during the first refresh stood the session down: no details, no
    // recaps, and the pane this refresh may have opened after it closed goes again.
    if (isFirst && (isSelfFound || (await read($, isIssueSession)))) {
      standDown()
      if (await isPaneOpen($)) void $.ui.close({ id: PANE }).catch(() => undefined)

      return
    }
    await hydrate($, options, nextSections, now, isShown)
    // E5-c: an update the owner made by their own comment is no news to them.
    await acknowledgeOwnComments($, options, nextSections)
    // E4: the comments of the rows near the window, for their hover cards (two per refresh, while shown on the desktop).
    await warmCards($, options, now)
    await pruneMappings($, options, nextSections)
    // E10: the mapped rows' issue-session records, from the store only (plan 4.5); its proposal toast joins this refresh's.
    await syncPhases($, options)
    // E22 after the details: the expanded closed lists that are due, fetched only while the pane is shown (D X-1); the
    // store's lists are drawn either way (B2-BEH-4).
    await refreshClosed($, options, nextSections, reason, now, isShown)
    // E5: the title's count as the refresh left it, and the next fade (a reload's lost timer is armed again here).
    await syncTitle($, options)
    armFade($, options, await read($, glimpsed), await $.clock.now())
    // The desktop's part comes last and is not awaited: no desktop call holds up the GitHub part (A-F4). E1's pass
    // (the listing, a few reads) and E3's pull-request reads of the issue sessions.
    void trackSessions($, options, nextSections, true)
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
  const tries = await read($, attempts)
  for (const section of current) {
    if (section.state.kind !== 'ok' || section.query !== undefined || !isComplete(section, options)) continue
    const open = new Set(section.rows.map(row => rowKeyOf(section.key, row.number)))
    // E22-b: the session of an issue that closed stays reachable from its closed row for a while.
    for (const [rowKey, mapping] of Object.entries(all)) {
      if (rowKey.startsWith(`${section.key}#`) && !open.has(rowKey)) await retireMapping($, rowKey, mapping)
    }
    // E1: the earlier attempts of an issue that closed go with it.
    for (const rowKey of Object.keys(tries)) {
      if (!rowKey.startsWith(`${section.key}#`) || open.has(rowKey)) continue
      await $.store.delete(storeKeyOf('attempts:', rowKey)).catch(() => undefined)
      await update($, attempts, had => withoutKey(had, rowKey))
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
    await retireMapping($, rowKey, (await read($, mappings))[rowKey])
    // E22: the repository's closed list, when expanded, is read again on the next refresh (once it is 30 s old).
    closedNudge.add(section.key)

    return null
  }

  return settled
}

/** What a press that may start a session came to: a session started or handled, the brief in the prompt box, or nothing yet (the form stays open). */
type StartResult = 'started' | 'fallback' | 'kept'

/**
 * "Bearbeiten" / "Zur Session" (as `label` says): the issue's session, opened after the click validated it (E1), or a
 * new one started with `choice` (E20's form), else with Work on it's defaults and the repository's `beside` (E8). The
 * store, not this pane's copy, says whether the issue has a session: another pane may have started one. `surface` is
 * where the press came from: only a desktop press opens a session in the window.
 */
async function workOn($: EngineInterface, options: Options, sectionKey: string, number: number, label: string, surface: RenderSurface, choice?: StartChoice): Promise<StartResult> {
  const S = strings(options.language)
  const rowKey = rowKeyOf(sectionKey, number)
  if (inFlight.has(rowKey)) return 'kept'
  inFlight.add(rowKey)
  await setStarting($, rowKey, true)
  try {
    // E5: working on a row acknowledges it.
    await acknowledgeRow($, options, rowKey)
    // What the owner pressed, in the words they saw, for a desktop call that has to take the typed route.
    const consent = pressConsent(label, `issue ${rowKey}`)
    const mapping = await reloadMapping($, rowKey)
    if (mapping !== undefined) {
      await reEnter($, options, rowKey, mapping, number, consent, surface)

      return 'started'
    }
    // A start whose answer carried no id is looked for first: no second session meanwhile (A-F12).
    const pending = unparsed.get(rowKey)
    if (pending !== undefined && (await $.clock.now()) - pending.at < UNPARSED_MS) {
      $.ui.toast(S.startPending(number), { timeoutMs: 6_000 })
      scheduleTrack($, options, 0)

      return 'started'
    }

    return await startIssueSession($, options, sectionKey, number, consent, choice ?? (await defaultChoice($)), surface)
  } finally {
    inFlight.delete(rowKey)
    await setStarting($, rowKey, false)
  }
}

/** Work on it's choice: understand first, own worktree, the pane session's model and effort, and E8's `beside` as the repository's setting says. */
async function defaultChoice($: EngineInterface): Promise<StartChoice> {
  return { ...DEFAULT_CHOICE, beside: (await read($, settings)).beside === true }
}

/**
 * Starts the issue's session (V1's start, with E20's choice): the brief names the earlier attempts (E1), the pane's id
 * (E12), the mode, the place and the owner's guidance and note (E20); a fork carries this conversation (E21). A model or
 * effort the app refuses is dropped once, and one it took is read back (B-E20-4). The new session opens beside this one
 * when asked (E8), before the detach; one toast says how it went. A start without a readable id is looked for in the
 * listing (A-F12). The tracking pass reads the new session 8 s later.
 */
async function startIssueSession($: EngineInterface, options: Options, sectionKey: string, number: number, consent: string, choice: StartChoice, surface: RenderSurface): Promise<StartResult> {
  const S = strings(options.language)
  const rowKey = rowKeyOf(sectionKey, number)
  const found = findRow(await read($, sections), sectionKey, number)
  if (found === null || found.section.info === null) return 'kept'
  const now = await $.clock.now()
  const fresh = await freshDetails($, options, found.section, found.row, now)
  if (fresh === null) return 'kept'
  const input = { issueRepo: found.section.info, codeRepo: checkout?.info ?? null, row: found.row, details: fresh, fetchedAt: new Date(now).toISOString(), triage: await triageFor($, options, rowKey, fresh) }
  const previous = (await read($, attempts))[rowKey] ?? []
  const root = checkout?.root ?? (await $.session.root())
  // E20/E21: a shared checkout and a fork name this session's branch as it is now, not as it was when the form opened.
  const facts = choice.place === 'worktree' ? null : await readStartFacts($, root)
  // E6: Phase 1 names the issue tool where this session's model can call it (the issue session's own is not known here).
  const briefing: BriefOptions = {
    issueTool: await issueToolOf($),
    fromId: myId,
    previous,
    mode: choice.mode,
    place: choice.place,
    root,
    sourceBranch: facts?.branch ?? '',
    isSourceWorktree: facts?.isWorktree === true,
    guidance: (await read($, settings)).guidance ?? '',
    note: choice.note,
  }
  const prompt = renderBrief(input, briefing)
  const title = sessionTitle(found.row)
  const name = sessionName(found.row, found.section.info.name)
  const branch = branchName(found.row)
  const before = lastListed !== null && now - lastListed.at < UNPARSED_MS ? lastListed.ids : null
  let args: StartArgs
  if (choice.place === 'fork') {
    // B-E21-2: whether this conversation may be carried is asked again right before the start (a turn may have begun).
    const state = await forkStateOf($, surface, facts)
    if (state !== 'ok') {
      $.ui.toast(state === 'busy' ? S.captionForkBusy : S.captionForkNone, { timeoutMs: 6_000 })

      return 'kept'
    }
    args = { title, name, prompt, context: 'fork' }
  } else {
    const background = renderBackground(input, root, briefing)
    args = choice.place === 'shared' ? { title, name, prompt, background, use_worktree: false } : { title, name, prompt, background, branch_name: branch, use_worktree: true }
    if (choice.model !== 'inherit') args.model = choice.model
    if (choice.effort !== 'inherit') args.effort = choice.effort
  }
  const notes: string[] = []
  let readBack = asksOptions(choice)
  let outcome: StartOutcome = await startDesktopSession($, args, consent)
  // E20: a model or an effort the app refused is dropped once; the session then inherits both, and the toast says so.
  if (outcome.route === 'none' && readBack && /\b(?:model|effort)\b/i.test(outcome.reason ?? '')) {
    const plain: StartArgs = { ...args }
    delete plain.model
    delete plain.effort
    outcome = await startDesktopSession($, plain, consent)
    if (outcome.route !== 'none') notes.push(S.noteOptionsDropped)
    readBack = false
  }
  await update($, route, () => outcome.route)
  if (outcome.route === 'none') {
    // V1's fallback, worded for this session (no shared checkout, no fork; mode, guidance and note stay). A refused fork
    // is never retried as a fresh start: that would drop the conversation the owner chose to carry (E21).
    const isFilled = await fillPrompt($, options, renderBrief(input, { ...briefing, place: 'here' }))
    $.ui.toast(clean(S.sessionNotStarted(outcome.reason ?? '?')), { timeoutMs: 8_000 })

    return isFilled ? 'fallback' : 'kept'
  }
  if (outcome.sessionId === null) {
    $.ui.toast(S.noIdParsed, { timeoutMs: 8_000 })
    unparsed.set(rowKey, { title, name, branch, at: now, before })
    scheduleTrack($, options, TRACK_AFTER_START_MS)

    return 'started'
  }
  // The checkout's key as this pane resolved it travels along: the issue session finds the project's lists under it
  // without gh, where its git remote names another (a fork's origin; R4-INT-2). Only an own worktree's branch is the slug.
  const held = await read($, checkoutKey)
  const started: Mapping = {
    sessionId: outcome.sessionId,
    title,
    startedAt: now,
    startedFrom: myId,
    detached: false,
    ...(choice.place === 'worktree' ? { branch } : {}),
    mode: choice.mode,
    place: choice.place,
    ...(held === '' ? {} : { checkoutKey: held }),
  }
  await saveMapping($, rowKey, started)
  // E8: beside this session, before the detach (whether a detach ends the right to split is S15), only for a press from
  // the desktop. A refusal is told, never retried: the app says it changed nothing (A-F1, A-F17).
  if (choice.beside && surface === 'desktop') {
    const shown = await openBeside($, outcome.sessionId, consent)
    if (shown.outcome === 'refused') {
      $.ui.log(`${PLUGIN}: open_session_in split ${outcome.sessionId} refused: ${shown.reason}`, { to: 'debug' })
      notes.push(S.noteNotBeside)
    }
  }
  const detached = await detachSession($, outcome.sessionId, consent)
  const settled: Mapping = detached.ok ? { ...started, detached: true } : started
  if (detached.ok) await saveMapping($, rowKey, settled)
  else notes.push(S.noteLinked)
  // B-E20-4: the app ignores a model above this session's without a word; the new session is read back.
  if (readBack && !(await holdsOptions($, outcome.sessionId, choice, consent))) notes.push(S.noteOptionsDropped)
  // One toast for the start (A crossCutting 6e): what went otherwise is named in it.
  if (notes.length === 0) $.ui.toast(clean(S.startedNote(title, notes)))
  else $.ui.toast(clean(S.startedNote(title, notes)), { timeoutMs: 8_000 })
  // B-X-1: issue sessions now write the shared store at every turn, and whether two processes' writes of different keys
  // both survive is not measured yet: the mapping that keeps the issue from a second session is read back once.
  if (!unsaved.has(rowKey) && asMapping(await readStore<unknown>($, storeKeyOf('session:', rowKey)))?.sessionId !== settled.sessionId) {
    $.ui.log(`${PLUGIN}: the mapping of ${rowKey} was lost from the store after the start; written again`, { to: 'debug' })
    await saveMapping($, rowKey, settled)
  }
  scheduleTrack($, options, TRACK_AFTER_START_MS)

  return 'started'
}

/**
 * E8: a session the pane started, opened in split view beside this one. Prose cannot tell a refusal ("changes nothing
 * and says so") from a no-op ("already visible"), so an answer that is no error is checked against the window's layout
 * (quiet, never a card, A-F17): a layout that answers as JSON without the session's id says it is not in view.
 */
async function openBeside($: EngineInterface, sessionId: string, consent: string): Promise<OpenOutcome> {
  const opened = await openSessionIn($, sessionId, 'split', consent)
  if (opened.outcome === 'refused') return opened
  const layout = await quietDesktop($, 'ccd_window', 'get_window_layout', {})
  if (!layout.ok) return opened
  const data = parseObject(layout.structured, layout.text)
  if (Object.keys(data).length === 0 || JSON.stringify(data).includes(sessionId)) return opened

  return { outcome: 'refused', reason: 'not in the window layout after the split' }
}

/** B-E20-4: whether the session the app started runs on the model and effort the form asked; true when the app does not say. */
async function holdsOptions($: EngineInterface, sessionId: string, choice: StartChoice, consent: string): Promise<boolean> {
  const peek = await peekForPress($, sessionId, consent)

  return peek.kind !== 'found' || optionsHeld(choice, { model: peek.entry.model, effort: peek.entry.effort })
}

/**
 * E20/E21: what the form reads of this session: its branch and whether its folder is a linked worktree (one local git
 * call, repo hooks off), whether tracked files are dirty (another), the context's tokens and the model (the engine), the
 * effort (one quiet get_session 'self'). Each failure leaves its field empty.
 */
async function readStartFacts($: EngineInterface, root: string): Promise<StartFacts> {
  const now = await $.clock.now()
  const head = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD', '--path-format=absolute', '--git-dir', '--git-common-dir'], { cwd: root, timeoutMs: 5_000 }).catch(() => null)
  const git = parseGitFacts(head !== null && head.exitCode === 0 ? head.stdout : '')
  const status = head !== null && head.exitCode === 0 ? await $.process.run(['git', 'status', '--porcelain', '--untracked-files=no'], { cwd: root, timeoutMs: 5_000 }).catch(() => null) : null
  const usage = await $.session.usage().catch(() => null)
  const model = await $.session.model().catch(() => '')
  const self = await peekSession($, 'self')

  return {
    root,
    branch: git.branch,
    isWorktree: git.isWorktree,
    isDirty: status !== null && status.exitCode === 0 && status.stdout.trim() !== '',
    contextTokens: typeof usage?.context.tokens === 'number' ? usage.context.tokens : null,
    model,
    effort: self.kind === 'found' ? (self.entry.effort ?? '') : '',
    at: now,
  }
}

/**
 * E21: whether the form may carry this conversation now (startform.ts forkState). The running turn comes from the turn
 * hooks' module memory where this module saw one, else from the state (which a drawing reads, so it redraws at a turn's
 * end).
 */
async function forkStateOf($: EngineInterface, surface: RenderSurface, facts: StartFacts | null): Promise<ForkState> {
  const held = await read($, turnRunning)
  const turns = await $.session.turns().catch(() => 0)

  return forkState({
    surface,
    isIssueSession: await read($, isIssueSession),
    isWorktree: facts?.isWorktree === true,
    turns,
    running: mainTurn === undefined ? held : mainTurn,
    now: await $.clock.now(),
  })
}

// E20: the start form -----------------------------------------------------------

/** "▾" on a row: opens the start form under it (one row at a time) or closes it; the desktop's choices read this session's facts. */
async function toggleStartForm($: EngineInterface, rowKey: string, surface: RenderSurface): Promise<void> {
  const current = await read($, startForm)
  if (current !== null && current.rowKey === rowKey) {
    await closeForm($, rowKey)

    return
  }
  if (current !== null) noteDrafts.delete(current.rowKey)
  noteDrafts.delete(rowKey)
  const chosen = await read($, settings)
  const form: StartForm = { rowKey, ...DEFAULT_CHOICE, beside: chosen.beside === true }
  await update($, startForm, () => form)
  if (surface === 'desktop') {
    const facts = await readStartFacts($, checkout?.root ?? (await $.session.root()))
    await update($, startFacts, () => facts)
  }
}

/** Closes the start form of `rowKey` (another row's stays) and drops its draft. */
async function closeForm($: EngineInterface, rowKey: string): Promise<void> {
  noteDrafts.delete(rowKey)
  await update($, startForm, current => (current !== null && current.rowKey === rowKey ? null : current))
}

/** A choice picked in the form of `rowKey`. */
async function patchForm($: EngineInterface, rowKey: string, patch: Partial<StartChoice>): Promise<void> {
  await update($, startForm, current => (current === null || current.rowKey !== rowKey ? current : { ...current, ...patch }))
}

/** Enter in the note: kept in the state (drawn as a caption); the typing itself only in the module's drafts. */
async function keepNote($: EngineInterface, rowKey: string, text: string): Promise<void> {
  noteDrafts.set(rowKey, text)
  await patchForm($, rowKey, { note: cleanNote(text) })
}

/** The form's choice with the note as typed (a draft not yet kept counts); null when the note looks like a secret (told). */
async function formChoice($: EngineInterface, options: Options, rowKey: string): Promise<StartChoice | null> {
  const form = await read($, startForm)
  if (form === null || form.rowKey !== rowKey) return null
  const note = cleanNote(noteDrafts.get(rowKey) ?? form.note)
  if (looksSecret(note)) {
    $.ui.toast(strings(options.language).noteSecret, { timeoutMs: 6_000 })

    return null
  }

  return { mode: form.mode, place: form.place, model: asModel(form.model), effort: asEffort(form.effort), beside: form.beside, note }
}

/** "Starten": Work on it with the form's choice; the form closes only after a start or the prompt-box fallback (B-E20-7). */
async function startFromForm($: EngineInterface, options: Options, rowKey: string, label: string, surface: RenderSurface): Promise<void> {
  const choice = await formChoice($, options, rowKey)
  if (choice === null) return
  const hash = rowKey.lastIndexOf('#')
  const result = await workOn($, options, rowKey.slice(0, hash), Number(rowKey.slice(hash + 1)), label, surface, choice)
  if (result !== 'kept') await closeForm($, rowKey)
}

/** "Hier übernehmen" in the form: the same brief (mode, note, guidance) in this prompt box. */
async function hereFromForm($: EngineInterface, options: Options, rowKey: string): Promise<void> {
  const choice = await formChoice($, options, rowKey)
  if (choice === null) return
  const hash = rowKey.lastIndexOf('#')
  if (await takeHere($, options, rowKey.slice(0, hash), Number(rowKey.slice(hash + 1)), choice)) await closeForm($, rowKey)
}

/**
 * E20: the repository's guidance, appended to every brief started from this checkout (plan 4.8). Kept in the settings,
 * cleaned and cut to 1,000 characters (a toast says when it was cut); a text that looks like a token or a key is refused.
 */
async function saveGuidance($: EngineInterface, options: Options, text: string): Promise<void> {
  const S = strings(options.language)
  if (text.trim() === '') return
  if (looksSecret(text)) {
    $.ui.toast(S.guidanceSecret, { timeoutMs: 6_000 })

    return
  }
  const cleaned = cleanGuidance(text)
  await saveSettings($, current => withGuidance(current, cleaned.text))
  if (cleaned.isCut) $.ui.toast(S.guidanceCut(GUIDANCE_CHARS))
}

/** The settings with `text` as the guidance; none for an empty one. */
function withGuidance(current: RepoSettings, text: string): RepoSettings {
  const next = { ...current }
  if (text === '') delete next.guidance
  else next.guidance = text

  return next
}

/** E8: the ⚙ panel's switch: open each new issue session beside this one (per repository, off by default). */
async function toggleBeside($: EngineInterface): Promise<void> {
  await saveSettings($, current => {
    const next = { ...current }
    if (current.beside === true) delete next.beside
    else next.beside = true

    return next
  })
}

/** Whether a session reads as archived: the app's own flag, or the last pass found it missing from a complete listing. */
async function isArchivedNow($: EngineInterface, rowKey: string, mapping: Mapping, peek: Peek): Promise<boolean> {
  if (peek.kind !== 'found') return false
  if (peek.entry.archived !== null) return peek.entry.archived
  const live = (await read($, sessionLive))[rowKey]

  return live?.sessionId === mapping.sessionId && live.presence === 'archived'
}

/**
 * E1's click on a mapped row: the session is validated by one quiet read (A-F13: never a card), asked once more through
 * callDesktop with the press's words only where the mod's own route cannot reach the app (R5-INT-1, plan 4.2), and the
 * acting call goes through callDesktop. The app's own "not found" releases the mapping as an attempt; an archived session
 * is offered again (Wieder öffnen / Neu starten) and nothing is released; anything else is opened.
 */
async function reEnter($: EngineInterface, options: Options, rowKey: string, mapping: Mapping, number: number, consent: string, surface: RenderSurface): Promise<void> {
  const S = strings(options.language)
  // The pane drawn inside the issue session itself: there is nothing to open.
  if (isOwnSession(mapping, await ownIds($))) return
  const peek = await peekForPress($, mapping.sessionId, consent)
  if (peek.kind === 'gone') {
    await releaseMapping($, rowKey, mapping, 'gone', null)
    $.ui.toast(S.released(number))

    return
  }
  if (await isArchivedNow($, rowKey, mapping, peek)) {
    await markArchived($, rowKey, mapping, peek)
    $.ui.toast(S.archivedChoose(number), { timeoutMs: 6_000 })

    return
  }
  await openMapped($, options, mapping, peek, consent, surface)
}

/** Notes a session the click found archived, so the row offers Wieder öffnen and Neu starten at once. */
async function markArchived($: EngineInterface, rowKey: string, mapping: Mapping, peek: Peek): Promise<void> {
  const now = await $.clock.now()
  const live: SessionLive =
    peek.kind === 'found' ? liveOf(peek.entry, 'archived', now) : { sessionId: mapping.sessionId, presence: 'archived', state: null, raw: '', link: null, branch: null, pr: 'no', at: now }
  await update($, sessionLive, current => ({ ...current, [rowKey]: live }))
}

/**
 * Opens a mapped session in the window, for a press from the desktop by the pane that started it (open_session_in
 * acts only on a session this session started). Who started it: the app's `parentSessionId` against this session's
 * desktop id where the app names a parent (A-F14), else the mapping's `startedFrom`. Any other pane, or a refusal of the
 * app (not on screen, a text field holds the cursor), says where to find the session.
 */
async function openMapped($: EngineInterface, options: Options, mapping: Mapping, peek: Peek, consent: string, surface: RenderSurface): Promise<boolean> {
  const S = strings(options.language)
  const title = (peek.kind === 'found' ? peek.entry.title : '') || mapping.title
  const parent = peek.kind === 'found' ? (peek.entry.parentSessionId ?? peek.entry.startedBy) : null
  const isStarter = parent !== null && parent !== '' ? (await knownOwnIds($)).includes(parent) || mapping.startedFrom === myId : mapping.startedFrom === myId
  if (!isStarter || surface !== 'desktop') {
    $.ui.toast(clean(S.openElsewhere(title)), { timeoutMs: 6_000 })

    return false
  }
  // E8: with "beside" on, the session opens in split view, so the pane stays in view (focus would replace this session).
  const beside = (await read($, settings)).beside === true
  const opened = beside ? await openBeside($, mapping.sessionId, consent) : await openSessionIn($, mapping.sessionId, 'focus', consent)
  if (opened.outcome !== 'refused') return true
  $.ui.log(`${PLUGIN}: open_session_in ${mapping.sessionId} refused: ${opened.reason}`, { to: 'debug' })
  // A-F17: with the switch off, a focus the cursor held back is only told (open it from the sidebar, or drag it beside); never a split unasked.
  $.ui.toast(clean(!beside && isTypingRefusal(opened.reason) ? S.focusTyping(title) : S.openElsewhere(title)), { timeoutMs: 6_000 })

  return false
}

/**
 * "Wieder öffnen" on an archived row: the session is restored (unarchive_session, the press's words), then opened. The
 * pass's word may be old (the owner restored it from the sidebar meanwhile, R5-RT-3): the app's own flag decides, else a
 * listing taken now, and the pass's word only when neither answers. A refusal to restore a session no flag of the app
 * called archived still opens it; the listing is read again 3 s later whatever happened.
 */
async function reopen($: EngineInterface, options: Options, sectionKey: string, number: number, label: string, surface: RenderSurface): Promise<void> {
  const S = strings(options.language)
  const rowKey = rowKeyOf(sectionKey, number)
  if (inFlight.has(rowKey)) return
  inFlight.add(rowKey)
  await setStarting($, rowKey, true)
  try {
    // E5: going back to the issue's session acknowledges the row, as Work on it does (R5-INT-2).
    await acknowledgeRow($, options, rowKey)
    const consent = pressConsent(label, `issue ${rowKey}`)
    const mapping = await reloadMapping($, rowKey)
    if (mapping === undefined) return
    const peek = await peekForPress($, mapping.sessionId, consent)
    if (peek.kind === 'gone') {
      await releaseMapping($, rowKey, mapping, 'gone', null)
      $.ui.toast(S.released(number))

      return
    }
    if (peek.kind === 'unknown') {
      $.ui.toast(clean(S.reopenFailed(peek.reason)), { timeoutMs: 6_000 })

      return
    }
    const ended = await endedNow($, mapping, peek)
    const isArchived = ended === 'archived' || (typeof ended !== 'string' && (await isArchivedNow($, rowKey, mapping, peek)))
    let isActive = !isArchived
    if (isArchived) {
      const restored = await unarchiveSession($, mapping.sessionId, consent)
      if (restored.ok) {
        isActive = true
        $.ui.toast(clean(S.reopened(peek.entry.title || mapping.title)))
      } else if (peek.entry.archived === true) {
        // The app itself calls it archived and would not restore it: nothing to open.
        $.ui.toast(clean(S.reopenFailed(restored.reason)), { timeoutMs: 6_000 })

        return
      } else $.ui.log(`${PLUGIN}: unarchive_session ${mapping.sessionId} refused (${restored.reason}); opening it as it is`, { to: 'debug' })
    }
    if (isActive) {
      const now = await $.clock.now()
      await update($, sessionLive, current => ({ ...current, [rowKey]: liveOf(peek.entry, 'active', now) }))
    }
    await openMapped($, options, mapping, peek, consent, surface)
  } finally {
    inFlight.delete(rowKey)
    await setStarting($, rowKey, false)
    scheduleTrack($, options, TRACK_AFTER_REOPEN_MS)
  }
}

/** "Neu starten": the row asks for an explicit confirmation first (plan section 3); one row at a time. */
async function askFresh($: EngineInterface, rowKey: string): Promise<void> {
  await update($, freshAsk, current => (current === rowKey ? '' : rowKey))
}

/**
 * The confirmed "Neu starten" (plan section 3, A-F2, A-F3): never a second live session. The old session is checked
 * again: the app's "not found" (gone), its own archived flag, or a fresh complete listing without it while the app still
 * finds it (archived) let the start go on, and the old session becomes an attempt the new brief names; a session that is
 * still listed, or one that cannot be checked, stops it.
 */
async function startAfresh($: EngineInterface, options: Options, sectionKey: string, number: number, label: string, surface: RenderSurface): Promise<void> {
  const S = strings(options.language)
  const rowKey = rowKeyOf(sectionKey, number)
  await update($, freshAsk, () => '')
  if (inFlight.has(rowKey)) return
  inFlight.add(rowKey)
  await setStarting($, rowKey, true)
  try {
    // E5: starting the issue afresh acknowledges the row, as Work on it does (R5-INT-2).
    await acknowledgeRow($, options, rowKey)
    const consent = pressConsent(label, `issue ${rowKey}`)
    const mapping = await reloadMapping($, rowKey)
    if (mapping !== undefined) {
      const peek = await peekForPress($, mapping.sessionId, consent)
      if (peek.kind === 'unknown') {
        $.ui.toast(clean(S.checkFailed(peek.reason)), { timeoutMs: 8_000 })

        return
      }
      if (peek.kind === 'found') {
        const ended = await endedNow($, mapping, peek)
        if (ended === 'active') {
          $.ui.toast(clean(S.stillActive(peek.entry.title || mapping.title)), { timeoutMs: 8_000 })
          const now = await $.clock.now()
          await update($, sessionLive, current => ({ ...current, [rowKey]: liveOf(peek.entry, 'active', now) }))

          return
        }
        if (ended !== 'archived') {
          $.ui.toast(clean(S.checkFailed(ended.reason)), { timeoutMs: 8_000 })

          return
        }
        await releaseMapping($, rowKey, mapping, 'archived', peek.entry.branch)
      } else await releaseMapping($, rowKey, mapping, 'gone', null)
    }
    await startIssueSession($, options, sectionKey, number, consent, await defaultChoice($), surface)
  } finally {
    inFlight.delete(rowKey)
    await setStarting($, rowKey, false)
  }
}

/** Whether a session the app still finds is archived for certain: its own flag, else a complete listing taken now without it. */
async function endedNow($: EngineInterface, mapping: Mapping, peek: Extract<Peek, { kind: 'found' }>): Promise<'archived' | 'active' | { reason: string }> {
  if (peek.entry.archived !== null) return peek.entry.archived ? 'archived' : 'active'
  const listing = await listSessions($)
  if (!listing.ok) return { reason: listing.reason }
  if (listing.entries.some(entry => entry.id === mapping.sessionId)) return 'active'

  return listing.isFull ? { reason: 'the session list is longer than one read' } : 'archived'
}

/**
 * E22-b: the session of a closed issue, opened from its closed row by the pane that started it; anyone else is told where
 * it is. The ladder's rules (B5-BEH-2): gone drops the record; archived (the app's flag, else a complete listing taken now
 * without it) is restored first with the press's words, as Wieder öffnen does, so no toast says an archived session runs.
 */
async function openDone($: EngineInterface, options: Options, rowKey: string, label: string, surface: RenderSurface): Promise<void> {
  const S = strings(options.language)
  const record = (await read($, done))[rowKey]
  if (record === undefined || inFlight.has(rowKey)) return
  inFlight.add(rowKey)
  try {
    const consent = pressConsent(label, `issue ${rowKey}`)
    const mapping: Mapping = { sessionId: record.sessionId, title: record.title, startedAt: record.startedAt, startedFrom: record.startedFrom, detached: true }
    const peek = await peekForPress($, record.sessionId, consent)
    if (peek.kind === 'gone') {
      await $.store.delete(storeKeyOf('done:', rowKey)).catch(() => undefined)
      await update($, done, current => withoutKey(current, rowKey))
      $.ui.toast(S.released(Number(rowKey.slice(rowKey.lastIndexOf('#') + 1))))

      return
    }
    if (peek.kind === 'found' && (await endedNow($, mapping, peek)) === 'archived') {
      const restored = await unarchiveSession($, record.sessionId, consent)
      if (!restored.ok) {
        $.ui.toast(clean(S.reopenFailed(restored.reason)), { timeoutMs: 6_000 })

        return
      }
      $.ui.toast(clean(S.reopened(peek.entry.title || record.title)))
    }
    await openMapped($, options, mapping, peek, consent, surface)
  } finally {
    inFlight.delete(rowKey)
  }
}

/**
 * "Hier übernehmen": the brief in this session's own prompt box (V1), with the repository's guidance (E20) and, from the
 * start form, its mode and note. True when the box took it.
 */
async function takeHere($: EngineInterface, options: Options, sectionKey: string, number: number, choice?: Pick<StartChoice, 'mode' | 'note'>): Promise<boolean> {
  const S = strings(options.language)
  const found = findRow(await read($, sections), sectionKey, number)
  if (found === null || found.section.info === null) return false
  const rowKey = rowKeyOf(sectionKey, number)
  // E5: taking a row here acknowledges it.
  await acknowledgeRow($, options, rowKey)
  const now = await $.clock.now()
  const fresh = await freshDetails($, options, found.section, found.row, now)
  if (fresh === null) return false
  const input = { issueRepo: found.section.info, codeRepo: checkout?.info ?? null, row: found.row, details: fresh, fetchedAt: new Date(now).toISOString(), triage: await triageFor($, options, rowKey, fresh) }
  // E1: the earlier attempts are named here too; E12: the marker names this session, so sending the brief here never
  // makes it an issue session, even after a hot reload.
  const brief = renderBrief(input, {
    issueTool: await issueToolOf($),
    fromId: myId,
    previous: (await read($, attempts))[rowKey] ?? [],
    mode: choice?.mode ?? 'understand',
    place: 'here',
    guidance: (await read($, settings)).guidance ?? '',
    note: choice?.note ?? '',
  })
  if (!(await fillPrompt($, options, brief))) return false
  $.ui.toast(S.briefInPrompt)

  return true
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

// E6: the issue tool ------------------------------------------------------------

/**
 * Declares the read-only `issue` tool (C-E6-8: once the start is scheduled, and only in a git repository). A host that
 * adds no tools at run time, `--bare`, `--tools ""` or a deny rule leave it unregistered: the brief and the context
 * block then name gh alone, and the spike says why.
 */
async function registerIssueTool($: EngineInterface): Promise<void> {
  try {
    const { tool } = await $.tool.register(ISSUE_TOOL_SPEC)
    if (tool === ISSUE_TOOL) {
      issueToolName = tool
      issueToolProblem = ''

      return
    }
    issueToolName = null
    issueToolProblem = `registered as ${tool}, which no hook of this mod serves`
  } catch (error) {
    issueToolName = null
    issueToolProblem = error instanceof Error ? error.message : String(error)
  }
  $.ui.log(`${PLUGIN}: the issue tool is not registered: ${issueToolProblem}`, { to: 'debug' })
}

/**
 * The issue tool's name where the model can call it now, else null (R4-RT-3), read where it is used: the registration
 * resolves even when a deny rule withholds the tool from the session's tools, or when it is not listed after 8 s; and
 * a hot reload forgets this module's memory while the engine keeps the registration and this module's hook serves it.
 * A registration this module saw fail stays failed; a list that cannot be read leaves the registration's word.
 */
async function issueToolOf($: EngineInterface): Promise<string | null> {
  if (issueToolName === null && issueToolProblem !== NOT_TRIED) return null
  const tools = await $.tool.list().catch(() => null)
  if (tools === null) return issueToolName
  if (tools.some(tool => tool.name === ISSUE_TOOL)) {
    issueToolName = ISSUE_TOOL
    issueToolProblem = ''

    return ISSUE_TOOL
  }
  if (issueToolName !== null) issueToolProblem = "registered, but not among the session's tools: a deny rule withholds it, or the host has not listed it yet"

  return null
}

/** The spike's line for the tool (S18): its name where the model can call it, else why not. */
async function issueToolLine($: EngineInterface): Promise<string> {
  const usable = await issueToolOf($)
  if (usable !== null) return `issue tool: ${usable}`

  return issueToolName === null ? `issue tool: not registered (${issueToolProblem || '?'})` : `issue tool: not callable (${issueToolProblem})`
}

/** The checkout as the tool sees it: its repository when known, its key and its settings (the watch list, the consents). */
type ProjectView = { info: RepoInfo | null; state: RepoState; key: string; settings: RepoSettings }

/**
 * The checkout's repository and settings outside a refresh (E6): an issue session never refreshes, yet reads its own
 * issue. With `canFetch` an unknown checkout is resolved here, one `gh repo view` kept for the next refresh (a failure
 * is tried again after a minute, not on every call); without, only what the session already holds is used. The
 * settings are read from the store each time: another pane may have changed the watch list.
 */
async function ensureProject($: EngineInterface, canFetch: boolean, now: number): Promise<ProjectView> {
  const root = await $.session.root()
  forgetOtherRoot(root)
  if (canFetch && (checkout === null || (checkout.info === null && now - checkoutTriedAt >= TOOL_RESOLVE_RETRY_MS))) {
    // Calls the model makes at once share one resolution (R4-RT-4).
    if (resolvingCheckout === null) resolvingCheckout = resolveToolCheckout($, root, now)
    await resolvingCheckout
  }
  const info = checkout?.info ?? (await read($, sections)).find(section => section.isCheckout)?.info ?? null
  const key = info === null ? await read($, checkoutKey) : repoKey(info)
  if (info !== null) await adoptSettingsKey($, key)
  const chosen = key === '' ? await read($, settings) : readSettings(await readStore<unknown>($, storeKeyOf('settings:', key)))

  return { info, state: checkout?.state ?? { kind: 'error', detail: 'the checkout is not resolved in this session' }, key, settings: chosen }
}

/** The tool's own resolution of the checkout, one at a time (R4-RT-4): kept for the next refresh, as the refresh keeps its own. */
async function resolveToolCheckout($: EngineInterface, root: string, now: number): Promise<void> {
  try {
    checkoutTriedAt = now
    checkout = { root, ...(await resolveCheckout($, root)) }
  } catch (error) {
    $.ui.log(`${PLUGIN}: the issue tool could not resolve the checkout: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
  } finally {
    resolvingCheckout = null
  }
}

/** One demand read of an issue (E6); calls that overlap for the same issue share it (R4-RT-4). */
async function readIssueOnce($: EngineInterface, info: RepoInfo, number: number, rowKey: string, now: number): Promise<Viewed> {
  const pending = toolReading.get(rowKey)
  if (pending !== undefined) return pending
  const reading = viewIssueNumber($, info, number, now)
  toolReading.set(rowKey, reading)
  try {
    return await reading
  } finally {
    if (toolReading.get(rowKey) === reading) toolReading.delete(rowKey)
  }
}

type ToolTarget = { info: RepoInfo; key: string }

/**
 * The repository a tool call names: none is the checkout's; any other must be the checkout's under another spelling or
 * one the checkout's settings watch (resolved once, kept in `named` as the refresh keeps it). Anything else is refused
 * with the gh command the model can run instead, so the tool never reads a repository the owner did not choose.
 */
async function resolveToolRepo($: EngineInterface, project: ProjectView, repo: string | null, number: number, canFetch: boolean): Promise<ToolTarget | { error: string }> {
  if (repo === null) {
    if (project.info === null) return { error: `this folder's repository is not known to Issue Radar (${stateText(project.state, 'it')}); read the issue with gh issue view ${number} -R owner/name.` }

    return { info: project.info, key: project.key }
  }
  const wanted = specKey(repo)
  if (project.info !== null && repoKey(project.info) === wanted) return { info: project.info, key: project.key }
  const listed = (await read($, sections)).find(section => section.info !== null && section.key === wanted)
  if (listed?.info !== null && listed?.info !== undefined) return { info: listed.info, key: listed.key }
  const spec = project.settings.watch.find(found => specKey(found) === wanted)
  if (spec === undefined) {
    const checkoutSpec = project.info === null ? 'not resolved' : repoSpec(project.info)
    const watched = project.settings.watch.length === 0 ? 'none' : project.settings.watch.join(', ')

    return {
      error: `${repo} is not a repository Issue Radar watches for this project (checkout ${checkoutSpec}; watched ${watched}). The owner can add it in the Issues pane's settings; or read it with gh issue view ${number} -R ${repo}.`,
    }
  }
  const known = named.get(spec)
  if (known !== undefined) return known.info === null ? { error: `${stateText(known.state, spec)}.` } : { info: known.info, key: repoKey(known.info) }
  if (!canFetch) return { error: `${spec} is not resolved in this session, and Issue Radar reads GitHub only in desktop and terminal sessions.` }
  const resolved = await resolveNamed($, spec)
  if (resolved.info !== null || resolved.state.kind === 'no-access' || resolved.state.kind === 'issues-disabled' || resolved.state.kind === 'archived') named.set(spec, resolved)

  return resolved.info === null ? { error: `${stateText(resolved.state, spec)}.` } : { info: resolved.info, key: repoKey(resolved.info) }
}

/** One copy of an issue the tool may answer from: a read of its own, or what the pane holds. */
type ToolCopy = { row: IssueRow; details: IssueDetails | undefined; isLoaded: boolean; state: string; stateReason: string; source: 'cache' | 'github'; at: number }

/**
 * What the session holds of one issue: the listed row (the pane's section; the store's default list in a session
 * without it, or where a filter's matches leave it out, R4-INT-1), the pane's details of it (or the store's excerpt),
 * and the tool's own last read.
 */
async function toolCopies($: EngineInterface, target: ToolTarget, number: number): Promise<{ listed: IssueRow | undefined; held: ToolCopy | undefined; pane: ToolCopy | undefined }> {
  const rowKey = rowKeyOf(target.key, number)
  const section = (await read($, sections)).find(found => found.key === target.key)
  let listed = section?.rows.find(row => row.number === number)
  let have: IssueDetails | undefined = (await read($, details))[rowKey]
  if (listed === undefined && (section === undefined || isFilteredList(section))) {
    const cache = await readStore<RepoCache>($, storeKeyOf('cache:', target.key))
    listed = (Array.isArray(cache?.rows) ? cache.rows : []).find(row => isRowLike(row) && row.number === number)
    const seeded = seededDetails(cache?.meta?.[String(number)])
    if (have === undefined && listed !== undefined && seeded !== undefined && isCurrent(seeded, listed)) have = seeded
  }
  const own = toolReads.get(rowKey)

  return {
    listed,
    held: own === undefined ? undefined : { row: own.read.row, details: own.read.details, isLoaded: true, state: own.read.details.state, stateReason: own.read.stateReason, source: 'github', at: own.at },
    pane: listed === undefined ? undefined : { row: listed, details: have, isLoaded: have !== undefined && have.fetchedAt !== 0 && isCurrent(have, listed), state: 'OPEN', stateReason: listed.stateReason ?? '', source: 'cache', at: have?.fetchedAt ?? 0 },
  }
}

/** Keeps a tool read for 60 s of reuse, the newest 20. */
function keepToolRead(rowKey: string, at: number, found: ToolRead): void {
  toolReads.delete(rowKey)
  toolReads.set(rowKey, { at, read: found })
  while (toolReads.size > TOOL_READS_KEPT) {
    const oldest = toolReads.keys().next().value
    if (oldest === undefined) break
    toolReads.delete(oldest)
  }
}

/**
 * A tool read of an issue the pane lists goes into the session's details as the pane keeps them (C-E6-2: three
 * comments of 600 characters; the recap prompt and the opened row read them), so the pane benefits; never older than
 * what it holds, never a closed issue (the refresh and Work on it deal with closures), never the store. Under a filter
 * (E14) an open issue of the default list counts as listed too (R4-INT-1); the next refresh drops it while it is hidden.
 */
async function shareToolRead($: EngineInterface, rowKey: string, found: ToolRead): Promise<void> {
  if (found.details.state !== 'OPEN') return
  const sectionKey = rowKey.slice(0, rowKey.lastIndexOf('#'))
  const section = (await read($, sections)).find(candidate => candidate.key === sectionKey)
  if (section === undefined) return
  const isNumber = (row: unknown) => isRowLike(row) && row.number === found.row.number
  const isListed = section.rows.some(isNumber) || (isFilteredList(section) && (await defaultListOf($, section, sectionKey)).some(isNumber))
  if (!isListed) return
  const compact = compactDetails(found.details)
  await update($, details, current => {
    const had = current[rowKey]
    if (had !== undefined && had.fetchedAt !== 0 && had.updatedAt > compact.updatedAt) return current

    return { ...current, [rowKey]: had?.tree === undefined ? compact : { ...compact, tree: had.tree } }
  })
}

/**
 * The recap and triage a tool answer may carry: the pane's, or the store's in a session without the section or where a
 * filter hides the row (the refresh keeps only the shown rows' recaps); only where the pane would use them.
 */
async function toolRecap($: EngineInterface, options: Options, chosen: RepoSettings, sectionKey: string, row: IssueRow): Promise<Recap | undefined> {
  const rowKey = rowKeyOf(sectionKey, row.number)
  let recap = (await read($, recaps))[rowKey]
  const section = (await read($, sections)).find(found => found.key === sectionKey)
  if (recap === undefined && (section === undefined || isFilteredList(section))) {
    const stored = await readStore<Record<string, unknown>>($, storeKeyOf('recaps:', sectionKey))
    recap = typeof stored === 'object' && stored !== null ? asRecap(stored[String(row.number)]) : undefined
  }

  return isRecapUsable(options, chosen, sectionKey, recap, row) ? recap : undefined
}

type ToolAnswer = { result: string } | { result: string; isError: true } | { deny: string }

/**
 * The tool's answer (E6). It checks the input, asks the owner's permission settings (C-E6-1), finds the repository
 * among those the checkout watches, and answers from the copy the session holds while that is current: its own read
 * within 60 s (10 s for `fresh`), or the pane's details for up to three comments. Otherwise it reads the issue once with
 * `gh issue view`, only on desktop and terminal and never while the repository is backed off; a failed read backs it
 * off as a failed list does and answers the copy it holds, saying so. It writes nothing but the session's details of a
 * listed row (compact) and the attached record; never the store, never GitHub.
 */
async function answerIssueTool($: EngineInterface, options: Options, input: Record<string, unknown>, agentId: string | undefined): Promise<ToolAnswer> {
  const args = toolArguments(input)
  const ask: ToolAsk | { error: string } = parseToolInput(args)
  if ('error' in ask) return toolError(ask.error)
  // C-E6-1: answering in core's place skips the permission check beneath, so the hook asks for the verdict itself.
  const verdict: Verdict | null = await $.tool.check({ tool: ISSUE_TOOL, input: args }).catch(error => {
    $.ui.log(`${PLUGIN}: the issue tool's permission check failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })

    return null
  })
  if (verdict !== null && !mayRead(verdict)) return { deny: refusalText(verdict) }
  const canFetch = await surfacesAllowPane($)
  const now = await $.clock.now()
  const project = await ensureProject($, canFetch, now)
  const target = await resolveToolRepo($, project, ask.repo, ask.number, canFetch)
  if ('error' in target) return toolError(target.error)
  const n = ask.number
  const label = repoLabel(target.info)
  const spec = repoSpec(target.info)
  const rowKey = rowKeyOf(target.key, n)
  const copies = await toolCopies($, target, n)
  const isEnough = (have: IssueDetails | undefined) => have !== undefined && have.comments.length >= Math.min(ask.comments, have.commentCount)
  const isNewEnough = (copy: ToolCopy) => copies.listed === undefined || copy.row.updatedAt >= copies.listed.updatedAt
  let answer: ToolCopy | undefined
  let note: string | undefined
  const held = copies.held
  if (held !== undefined && isEnough(held.details) && isNewEnough(held) && now - held.at < (ask.fresh ? TOOL_FRESH_FLOOR_MS : TOOL_FRESH_MS)) {
    answer = held
    if (ask.fresh) note = `Read from GitHub ${Math.round((now - held.at) / 1_000)} s ago; a fresh read happens at most once per 10 s.`
  } else if (!ask.fresh && copies.pane !== undefined && copies.pane.isLoaded && isEnough(copies.pane.details)) answer = copies.pane
  if (answer === undefined) {
    // What answers when GitHub cannot: the tool's last read, else the pane's details (loaded, else its excerpt).
    const fallback = held ?? copies.pane
    const said = (why: string) => `${why}; this is the copy Issue Radar holds${fallback?.isLoaded === true ? '' : ' (no issue text or comments loaded)'}.`
    if (!canFetch) {
      if (fallback === undefined) return toolError(`Issue Radar reads GitHub only in desktop and terminal sessions; #${n} is not cached here.`)
      answer = fallback
      note = said('GitHub is read only in desktop and terminal sessions')
    } else if (now < (backoffUntil.get(target.key) ?? 0)) {
      if (fallback === undefined) return toolError(`GitHub was rate-limiting or unreachable a moment ago, and Issue Radar waits before it reads ${label} again; #${n} is not cached. Try again in a few minutes, or use gh issue view ${n} -R ${spec}.`)
      answer = fallback
      note = said('GitHub was rate-limiting or unreachable a moment ago')
    } else {
      const viewed = await readIssueOnce($, target.info, n, rowKey, now)
      if ('state' in viewed) {
        if (viewed.isMissing) return toolError(`#${n} does not exist in ${label}.`)
        backoffFor(target.key, viewed.state, now)
        $.ui.log(`${PLUGIN}: the issue tool's read of ${label}#${n} failed: ${viewed.state.kind} ${viewed.state.detail ?? ''}`, { to: 'debug' })
        if (fallback === undefined) return toolError(`${stateText(viewed.state, label)}; #${n} could not be read.`)
        answer = fallback
        note = said(`GitHub could not be read just now (${stateText(viewed.state, label)})`)
      } else {
        if (viewed.isPullRequest) return toolError(`#${n} in ${label} is a pull request; this tool reads issues (gh pr view ${n} -R ${spec}).`)
        keepToolRead(rowKey, now, viewed.read)
        await shareToolRead($, rowKey, viewed.read)
        answer = { row: viewed.read.row, details: viewed.read.details, isLoaded: true, state: viewed.read.details.state, stateReason: viewed.read.stateReason, source: 'github', at: now }
      }
    }
  }
  const recap = await toolRecap($, options, project.settings, target.key, answer.row)
  const text = renderIssueText({
    ref: `${label}#${n}`,
    spec,
    row: answer.row,
    state: answer.state,
    stateReason: answer.stateReason,
    details: answer.details,
    isLoaded: answer.isLoaded,
    recap,
    isMetadataOnly: false,
    purpose: 'tool',
    source: answer.source,
    at: answer.at,
    limits: { ...TOOL_LIMITS, comments: ask.comments },
    toolName: issueToolName,
    ...(note === undefined ? {} : { note }),
  })
  // E2 does not attach what the main conversation just read; a subagent's read is not the conversation's (C-E6-3).
  if (agentId === undefined && options.issueMentions) await recordAttached($, [{ rowKey, updatedAt: answer.row.updatedAt }], 'tool')

  return { result: text }
}

// E2: issues in the prompt ------------------------------------------------------

/** A row of the store's list as far as E2 reads it (the store is another session's writing, so it is checked). */
function isRowLike(value: unknown): value is IssueRow {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>

  return typeof row['number'] === 'number' && typeof row['title'] === 'string' && typeof row['updatedAt'] === 'string' && typeof row['url'] === 'string' && Array.isArray(row['labels']) && Array.isArray(row['assignees'])
}

/** `host/owner/name` of a section key as a repository, for a stored row whose URL names none. */
function infoOfKey(key: string): KnownIssue['info'] | null {
  const [host, owner, name] = key.split('/')

  return host === undefined || owner === undefined || name === undefined ? null : { host, owner, name }
}

/** What E2 knows of the project's open issues, with the settings, recaps and stored excerpts that go with them. */
type Known = { issues: KnownIssue[]; settings: RepoSettings; recaps: Record<string, Recap>; seeds: Record<string, IssueDetails> }

/**
 * Adds a repository's default list as the store keeps it (its rows, their stored recaps and excerpts) to what E2 knows,
 * except the numbers it knows already: the pane's own rows and recaps come first.
 */
function addStoredIssues(known: Known, sectionKey: string, info: KnownIssue['info'] | null, isCheckout: boolean, cache: RepoCache | undefined, stored: unknown): void {
  const have = new Set(known.issues.filter(issue => issue.sectionKey === sectionKey).map(issue => issue.row.number))
  const storedRecaps = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {}
  for (const row of (Array.isArray(cache?.rows) ? cache.rows : []).filter(isRowLike)) {
    const rowInfo = info ?? infoFromIssueUrl(row.url) ?? infoOfKey(sectionKey)
    if (have.has(row.number) || rowInfo === null) continue
    have.add(row.number)
    const rowKey = rowKeyOf(sectionKey, row.number)
    known.issues.push({ sectionKey, info: rowInfo, isCheckout, row })
    const recap = asRecap(storedRecaps[String(row.number)])
    if (recap !== undefined && known.recaps[rowKey] === undefined) known.recaps[rowKey] = recap
    const seeded = seededDetails(cache?.meta?.[String(row.number)])
    if (seeded !== undefined && isCurrent(seeded, row)) known.seeds[rowKey] = seeded
  }
}

/**
 * The checkout's key in a session without lists, never a gh call (C-E2-4): the one this session resolved; else the one
 * the pane that started this issue session resolved, from its mapping (R4-INT-2: in a fork gh, and so the pane's
 * lists, take `upstream` while `origin` names the fork); else the one the git remote names.
 */
async function heldCheckoutKey($: EngineInterface): Promise<string> {
  const held = await read($, checkoutKey)
  if (held !== '') return held
  const id = await $.session.id().catch(() => '')
  const own = id === '' ? undefined : Object.values(await read($, mappings)).find(mapping => mapping.sessionId === id && typeof mapping.checkoutKey === 'string' && mapping.checkoutKey !== '')
  if (own?.checkoutKey !== undefined) return own.checkoutKey
  const remote = (await $.session.repo().catch(() => null))?.remote ?? ''

  return keyOfRemote(remote) ?? ''
}

/**
 * The open issues the session lists: the pane's sections, else the store's lists of the checkout and the repositories
 * it watches (an issue session, or a pane before its first list). A section a filter narrows (E14: a view, a search,
 * sub-issues) draws only the filter's matches, so its repository's other open issues come from the store's default
 * list (R4-INT-1; plan section 3 allows the store); an issue the filter hides is mentioned all the same. Never gh,
 * never a resolution (C-E2-4).
 */
async function knownIssues($: EngineInterface): Promise<Known> {
  const listedSections = (await read($, sections)).filter(section => section.info !== null && (section.rows.length > 0 || isFilteredList(section)))
  if (listedSections.length > 0) {
    const known: Known = { issues: [], settings: await read($, settings), recaps: { ...(await read($, recaps)) }, seeds: {} }
    for (const section of listedSections) {
      const info = section.info
      if (info === null) continue
      for (const row of section.rows) known.issues.push({ sectionKey: section.key, info, isCheckout: section.isCheckout, row })
      if (!isFilteredList(section)) continue
      const cache = await readStore<RepoCache>($, storeKeyOf('cache:', section.key))
      addStoredIssues(known, section.key, info, section.isCheckout, cache, await readStore<unknown>($, storeKeyOf('recaps:', section.key)))
    }

    return known
  }
  const key = await heldCheckoutKey($)
  const known: Known = { issues: [], settings: DEFAULT_SETTINGS, recaps: {}, seeds: {} }
  if (key === '') return known
  known.settings = readSettings(await readStore<unknown>($, storeKeyOf('settings:', key)))
  for (const sectionKey of new Set([key, ...known.settings.watch.map(specKey)])) {
    const cache = await readStore<RepoCache>($, storeKeyOf('cache:', sectionKey))
    if (!Array.isArray(cache?.rows) || cache.rows.length === 0) continue
    addStoredIssues(known, sectionKey, null, sectionKey === key, cache, await readStore<unknown>($, storeKeyOf('recaps:', sectionKey)))
  }

  return known
}

/**
 * The typeahead's rows for a `#` token (E2): the known open issues, never a gh or model call, none on vscode or mobile.
 * Each row's dim line is the recap where the pane may use it, else the repository, two labels and the age.
 */
async function issueSuggestions($: EngineInterface, options: Options, token: string): Promise<PromptAutocompleteSuggestion[]> {
  const asked = parseMentionToken(token)
  if (asked === null || !(await surfacesAllowPane($))) return []
  const known = await knownIssues($)
  if (known.issues.length === 0) return []
  const now = await $.clock.now()
  const S = strings(options.language)
  const describe = (issue: KnownIssue): string => {
    const recap = known.recaps[rowKeyOf(issue.sectionKey, issue.row.number)]
    if (isRecapUsable(options, known.settings, issue.sectionKey, recap, issue.row) && recap.text !== '') return recap.text.length > 90 ? `${recap.text.slice(0, 89)}…` : recap.text

    return describeIssue(issue, shortAgo(issue.row.updatedAt, now, S.ago))
  }

  return suggestIssues(known.issues, asked, describe, MAX_SUGGESTIONS)
}

/**
 * What the session holds of a mentioned issue: the pane's details when they are a read as new as the row, the tool's
 * own read, else the stored excerpt and counts. Nothing is read from GitHub on Enter (plan section 3).
 */
async function mentionDetails($: EngineInterface, known: Known, issue: KnownIssue): Promise<{ details: IssueDetails | undefined; isLoaded: boolean }> {
  const rowKey = rowKeyOf(issue.sectionKey, issue.row.number)
  const have = (await read($, details))[rowKey]
  if (have !== undefined && have.fetchedAt !== 0 && isCurrent(have, issue.row)) return { details: have, isLoaded: true }
  const own = toolReads.get(rowKey)
  if (own !== undefined && own.read.row.updatedAt >= issue.row.updatedAt) return { details: compactDetails(own.read.details), isLoaded: true }

  return { details: have ?? known.seeds[rowKey], isLoaded: false }
}

/** What a prompt carries (E2): its context blocks, the references for the transcript line, and the record to keep. */
type MentionPlan = {
  context: string[]
  attached: string[]
  excerptOnly: string[]
  metaOnly: string[]
  capped: string[]
  records: Array<{ rowKey: string; updatedAt: string | null }>
  /** The user turn the prompt enters at. */
  turn: number
}

/**
 * The context blocks a person's prompt gets for the open issues it mentions (E2): composer, bridge, sdk or unclassified
 * origins only, no command, no meta prompt; quoted text and data blocks are not read (C-E2-3). At most three issues,
 * in mention order, skipping those the conversation carries unchanged from the last four turns. Only what the session
 * holds goes in, and a repository whose recaps the owner declined gives metadata only (C-E2-8). Null when nothing is
 * attached (C-E2-5): the prompt then goes on as it came.
 */
async function planMentions($: EngineInterface, options: Options, e: PromptSubmitInput): Promise<MentionPlan | null> {
  if (!PERSON_ORIGINS.has(e.origin.kind) || e.command !== undefined || e.isMeta === true) return null
  const mentions = findMentions(e.text)
  if (mentions.length === 0) return null
  const known = await knownIssues($)
  const resolved = resolveMentions(mentions, known.issues)
  if (resolved.length === 0) return null
  const turn = await $.session.turns().catch(() => -1)
  const conversation = await $.session.id().catch(() => '')
  const record = await read($, attached)
  const entries = record.conversation === conversation ? record.entries : {}
  const due = resolved.filter(issue => !isRecentlyAttached(entries[rowKeyOf(issue.sectionKey, issue.row.number)], issue.row.updatedAt, turn, REATTACH_TURNS))
  if (due.length === 0) return null
  // The tool is named only where the model can call it now (R4-RT-3).
  const toolName = await issueToolOf($)
  const plan: MentionPlan = { context: [], attached: [], excerptOnly: [], metaOnly: [], capped: due.slice(MAX_ATTACH).map(mentionRef), records: [], turn }
  for (const issue of due.slice(0, MAX_ATTACH)) {
    const rowKey = rowKeyOf(issue.sectionKey, issue.row.number)
    const ref = mentionRef(issue)
    const isMetadataOnly = known.settings.consent[issue.sectionKey] === false
    const held = await mentionDetails($, known, issue)
    const recap = known.recaps[rowKey]
    plan.context.push(
      renderIssueText({
        ref: `${issue.info.owner}/${issue.info.name}#${issue.row.number}`,
        spec: repoSpec(issue.info),
        row: issue.row,
        state: 'OPEN',
        stateReason: issue.row.stateReason ?? '',
        details: held.details,
        isLoaded: held.isLoaded,
        recap: isRecapUsable(options, known.settings, issue.sectionKey, recap, issue.row) ? recap : undefined,
        isMetadataOnly,
        purpose: 'mention',
        source: 'cache',
        at: held.details?.fetchedAt ?? 0,
        limits: MENTION_LIMITS,
        toolName,
      }),
    )
    plan.attached.push(ref)
    if (isMetadataOnly) plan.metaOnly.push(ref)
    else if (!held.isLoaded) plan.excerptOnly.push(ref)
    plan.records.push({ rowKey, updatedAt: issue.row.updatedAt })
  }

  return plan
}

/**
 * Notes issues as carried by this conversation at `turn` (the session's turn count when not given); nothing when the
 * count cannot be read. Keyed by the conversation's id, so a /clear or a resume starts afresh (C-E2-2).
 */
async function recordAttached($: EngineInterface, entries: ReadonlyArray<{ rowKey: string; updatedAt: string | null }>, via: Attached['via'], turn?: number): Promise<void> {
  if (entries.length === 0) return
  const at = turn ?? (await $.session.turns().catch(() => -1))
  if (at < 0) return
  const conversation = await $.session.id().catch(() => '')
  await update($, attached, current => withAttached(current, conversation, entries, at, via, ATTACHED_KEPT))
}

/** After the prompt entered: the record, and one dim transcript line (never sent to the model) saying what went in. */
async function noteMentions($: EngineInterface, options: Options, plan: MentionPlan): Promise<void> {
  await recordAttached($, plan.records, 'prompt', plan.turn)
  const S = strings(options.language)
  const parts = [S.mentionAttached(plan.attached.join(', '))]
  if (plan.excerptOnly.length > 0) parts.push(S.mentionExcerptOnly(plan.excerptOnly.join(', ')))
  if (plan.metaOnly.length > 0) parts.push(S.mentionMetaOnly(plan.metaOnly.join(', ')))
  if (plan.capped.length > 0) parts.push(S.mentionCapped(plan.capped.join(', ')))
  $.ui.log(clean(parts.join('; ')))
}

/** A hand-off brief carries its issue (C-E2-3): recorded as attached, whatever stands before its marker line. */
async function recordBrief($: EngineInterface, text: string): Promise<void> {
  const rowKey = briefIssueKey(text)
  if (rowKey !== null) await recordAttached($, [{ rowKey, updatedAt: null }], 'brief')
}

// E12: the issue session's identity, its own record and its status line ------------

/**
 * This session's id as the desktop app names it (get_session 'self', quiet: never a card), once per module and kept in
 * the state; a failure is tried again a minute later at the earliest. Empty while unknown (S4).
 */
async function resolveDesktopId($: EngineInterface): Promise<string> {
  const known = await read($, desktopId)
  if (known !== '') return known
  // A read in flight is shared, never counted as a failed one (R5-RT-1): the check and the claim run without a wait between.
  if (selfRead === null) selfRead = readDesktopId($)
  const pending = selfRead
  const id = await pending
  if (selfRead === pending) selfRead = null

  return id
}

/** One read of this session's desktop id (resolveDesktopId shares it); only a failed read holds the next back a minute. */
async function readDesktopId($: EngineInterface): Promise<string> {
  try {
    if ((await $.clock.now()) < selfRetryAt) return ''
    const self = await readSelfId($)
    if (self.id === '') {
      selfRetryAt = (await $.clock.now()) + SELF_RETRY_MS
      $.ui.log(`${PLUGIN}: this session's desktop id was not read: ${self.reason}`, { to: 'debug' })

      return ''
    }
    await update($, desktopId, () => self.id)

    return self.id
  } catch {
    return ''
  }
}

/**
 * E12 at a desktop attach (R5-RT-1): an identification already running is waited for, never replaced, and only one that
 * found nothing is asked again.
 */
async function identifyAfter($: EngineInterface, options: Options, prior: Promise<boolean> | null): Promise<boolean> {
  if (prior !== null && (await prior)) return true

  return identifyByMapping($, options)
}

/** E12 (B5-BEH-1, plan 4.2): waits for the identification in flight, at most IDENTIFY_WAIT_MS; false when none ran or it did not answer in time. */
async function identifiedSoon($: EngineInterface): Promise<boolean> {
  return identifying === null ? false : settleWithin($, identifying, IDENTIFY_WAIT_MS, false)
}

/** The issue a row key names, as SelfIssue says it; `fix` when the owner chose "just fix it" (E20). */
function selfOf(rowKey: string, via: SelfIssue['via'], mode?: string): SelfIssue | null {
  const hash = rowKey.lastIndexOf('#')
  const number = Number(rowKey.slice(hash + 1))
  const parts = rowKey.slice(0, hash).split('/')
  if (hash < 0 || !Number.isInteger(number) || number <= 0 || parts.length < 3) return null

  return { rowKey, number, repo: parts.slice(-2).join('/'), isSpike: false, via, ...(mode === 'fix' ? { mode: 'fix' as const } : {}) }
}

/**
 * Makes this session the issue session for `found` (plan 4.5): it stands down as V1's issue session does (no timer, no
 * pane, no gh), and its status line names the issue. An identity found by mapping replaces one found by the marker,
 * never the reverse.
 */
async function identifySelf($: EngineInterface, options: Options, found: SelfIssue): Promise<void> {
  const current = await read($, selfIssue)
  const settled = current !== null && current.via === 'mapping' && found.via !== 'mapping' ? current : found
  if (current === null || current.rowKey !== settled.rowKey || current.via !== settled.via || current.mode !== settled.mode) {
    await update($, selfIssue, () => settled)
    $.ui.log(`${PLUGIN}: this session works on ${settled.rowKey} (found by its ${settled.via})`, { to: 'debug' })
  }
  if (!(await read($, isIssueSession))) await update($, isIssueSession, () => true)
  isSelfFound = true
  standDown()
  if (await isPaneOpen($)) void $.ui.close({ id: PANE }).catch(() => undefined)
  await applyStatus($, options, settled, ownLatest ?? (await read($, ownPhase)))
  // E13: an issue session files itself once it knows it is one (in a dispatch of its own, which sees this one's writes).
  if (!settled.isSpike) scheduleTidy($, options, 1_000)
}

/**
 * Plan 4.5 (a): a mapping names this session, by its engine id or by its desktop id. The desktop's id is read only when
 * a mapping could be this session's at all (one another session started; a pane's own mappings never name itself), on a
 * surface that may be the desktop. The store is read fresh: the mapping may have landed after this session started.
 */
async function identifyByMapping($: EngineInterface, options: Options): Promise<boolean> {
  if ((await read($, selfIssue)) !== null) return true
  const all = await loadMappings($)
  const match = async (): Promise<boolean> => {
    const ids = await ownIds($)
    const found = Object.entries(all).find(([, mapping]) => isOwnSession(mapping, ids))
    const self = found === undefined ? null : selfOf(found[0], 'mapping', found[1].mode)
    if (self === null) return false
    await identifySelf($, options, self)

    return true
  }
  if (await match()) return true
  if ((await read($, desktopId)) !== '') return false
  const isCandidate = Object.values(all).some(mapping => mapping.startedFrom !== myId && mapping.sessionId !== myId)
  const surfaces = await $.session.surfaces().catch(() => [])
  if (!isCandidate || !(surfaces.length === 0 || surfaces.some(surface => surface === 'desktop'))) return false
  if ((await resolveDesktopId($)) === '') return false

  return match()
}

/**
 * Plan 4.5 (b): the marker as this session's FIRST user message. A brief this session wrote itself (Take it here, the
 * prompt-box fallback) names this session in its marker, or is one of the heads it filled (B-E12-3), and is no hand-off.
 */
async function identifyByMarker($: EngineInterface, options: Options, text: string): Promise<boolean> {
  const marker = parseMarker(text)
  if (marker === null || (await isOwnBrief($, text, marker))) return false
  if (marker.kind === 'spike') await identifySelf($, options, { rowKey: 'spike', number: 0, repo: '', isSpike: true, via: 'marker' })
  else await identifySelf($, options, { rowKey: marker.rowKey, number: marker.number, repo: marker.repo, isSpike: false, via: 'marker', ...(text.includes(FIX_LINE) ? { mode: 'fix' as const } : {}) })

  return true
}

/** Whether a brief is this session's own: its marker names this session, or this session filled its head into the box. */
async function isOwnBrief($: EngineInterface, text: string, marker: Marker | null): Promise<boolean> {
  if (ownBriefs.has(text.trimStart().slice(0, BRIEF_HEAD))) return true

  return marker !== null && marker.fromId !== '' && (await ownIds($)).includes(marker.fromId)
}

/** The first user message of this session: the transcript's first, else the prompt at hand when the transcript holds none yet. */
async function firstUserText($: EngineInterface, fallback: string): Promise<string> {
  const messages = await $.session.messages().catch(() => [])

  return messages.find(message => message.role === 'user')?.text ?? fallback
}

/**
 * E12's one write point (plan 4.5): the issue session's own record under `phase:<rowKey>`, with its state, what its last
 * finished turn asked, and when. A start of a turn or dialog that changes nothing is not written; a turn's end always
 * is. The session's id is read each time (a /clear goes on under a new one). E13's fields ride along unchanged unless
 * `extra` sets them. Nothing for the spike's session (it shows its line only) and nothing outside an issue session.
 */
async function writePhase($: EngineInterface, options: Options, activity: PhaseActivity, ask: PhaseAsk, isTurnEnd: boolean, extra: Partial<Pick<PhaseRecord, 'title' | 'filedGroupId' | 'filedAt' | 'fileTries'>> = {}): Promise<PhaseRecord | null> {
  const self = await read($, selfIssue)
  if (self === null) return null
  // The module's last write first: the turn hooks and E13's tidy write from different dispatches (each reads its own moment).
  const before = ownLatest ?? (await read($, ownPhase))
  const isSameState = !isTurnEnd && before !== null && before.activity === activity && before.ask === ask
  if (isSameState && Object.keys(extra).length === 0) return before
  const engineId = await $.session.id().catch(() => myId)
  const known = await read($, desktopId)
  // An E13 stamp changes no state: it keeps the state's time, so no pane takes it for a new proposal or a newer word (E10, E1).
  const at = isSameState && before !== null ? before.at : await $.clock.now()
  const record: PhaseRecord = { v: 1, sessionId: known === '' ? engineId : known, activity, ask, at, turns: (before?.turns ?? 0) + (isTurnEnd ? 1 : 0) }
  if (known !== '' && engineId !== '' && engineId !== known) record.engineId = engineId
  for (const field of ['title', 'filedGroupId', 'filedAt', 'fileTries'] as const) {
    const value = extra[field] ?? before?.[field]
    if (value !== undefined) (record as Record<string, unknown>)[field] = value
  }
  if (!self.isSpike) await writeStore($, storeKeyOf('phase:', self.rowKey), record)
  ownLatest = record
  await update($, ownPhase, () => record)
  await applyStatus($, options, self, record)

  return record
}

/**
 * The status line's one owner (plan 4.4): `Issue #42 · acme/widgets` in an issue session, with the waiting proposal; the
 * spike's session shows its own name (S19). On a surface that draws no pane (vscode, mobile) the line is cleared
 * (B-E12-5). The values just written are passed in, since a read in the same dispatch sees the moment before (B-E12-4).
 */
async function applyStatus($: EngineInterface, options: Options, self: SelfIssue | null, record: PhaseRecord | null): Promise<void> {
  const text = self === null || !(await surfacesAllowPane($)) ? undefined : statusText(strings(options.language), self, record)
  if (text === statusShown) return
  statusShown = text
  $.ui.status(text)
}

/**
 * A main-loop turn starts. An issue session records that it works; a session not identified yet looks at its first
 * user message for the marker, then (at its first three turns) at the mappings for its id (B-E12-1: the mapping may land
 * after the session started). Runs beside the turn, never in its way (B-E12-5).
 */
async function noteTurnStart($: EngineInterface, options: Options, turnId: string, text: string): Promise<void> {
  const now = await $.clock.now()
  await update($, turnRunning, () => ({ turnId, since: now }))
  if ((await read($, selfIssue)) === null && identifyTurns < IDENTIFY_TURNS) {
    identifyTurns += 1
    if (!(await identifyByMarker($, options, await firstUserText($, text)))) await identifyByMapping($, options)
  }
  if ((await read($, selfIssue)) !== null) await writePhase($, options, 'working', 'none', false)
}

/**
 * A main-loop turn ends. An issue session records what it ended on: waiting for the owner (an answer, or the owner's
 * interrupt) with what the answer asked, or stopped on an error or a refusal. A pane session reads its mapped rows'
 * records (E10's floor), and the app's listing 1.5 s later while a session it started is still linked to it (the app
 * continues the pane's session after such a child's turn).
 */
async function noteTurnEnd($: EngineInterface, options: Options, reason: TurnCompleteReason, answer: string): Promise<void> {
  await update($, turnRunning, () => null)
  if ((await read($, selfIssue)) !== null) {
    const isAnswered = reason === 'answer' || reason === 'aborted'
    await writePhase($, options, isAnswered ? 'waiting' : 'error', reason === 'answer' ? askOf(answer) : 'none', true)
    // E13: filing, title and the unread mark, in a dispatch of their own a moment later (they never hold up the record).
    scheduleTidy($, options, 400, reason)

    return
  }
  if ((await read($, isIssueSession)) || !wantsPane) return
  await syncPhases($, options)
  if (Object.values(await read($, mappings)).some(mapping => mapping.startedFrom === myId && !mapping.detached)) scheduleTrack($, options, TRACK_AFTER_TURN_MS, false)
}

/**
 * Runs `work` once every earlier turn or dialog step has finished (R5-RT-2: the hooks start them as their own tasks, so
 * without the chain a turn's end could land after the next turn's start and leave its record behind). Never rejects.
 */
function inOrder(work: () => Promise<void>): Promise<void> {
  const next = phaseChain.then(work).catch(() => undefined)
  phaseChain = next

  return next
}

/** A question dialog (AskUserQuestion) or a plan approval (ExitPlanMode) opens or closes in an issue session's main loop. */
async function noteDialog($: EngineInterface, options: Options, tool: string, isOpen: boolean): Promise<void> {
  if (isOpen) await writePhase($, options, 'waiting', tool === 'ExitPlanMode' ? 'proposal' : 'question', false)
  else await writePhase($, options, 'working', 'none', false)
}

// E10: what the pane makes of the issue sessions' records ---------------------------

/**
 * Reads the mapped rows' issue-session records from the store (plan 4.5: store only, so every pane of the project sees
 * them, B-E10-3) and keeps the ones that speak for the current session of their row. A proposal not toasted yet in this
 * session, and newer than it, is offered as the refresh's toast (rank: proposal) while the pane is shown on a surface
 * that draws it; outside a refresh the toast is shown at once. The rows are picked inside the atom's update, so two syncs
 * at once never toast one proposal twice (B-E10-5). No session messages, no pings (plan section 3).
 */
async function syncPhases($: EngineInterface, options: Options): Promise<void> {
  if (await read($, isIssueSession)) return
  const all = await read($, mappings)
  const found: Record<string, PhaseRecord> = {}
  for (const [rowKey, mapping] of Object.entries(all)) {
    const accepted = phaseFor(readPhase(await readStore<unknown>($, storeKeyOf('phase:', rowKey))), mapping)
    if (accepted !== null) found[rowKey] = accepted
  }
  if (!samePhases(await read($, phases), found)) await update($, phases, () => found)
  if (!(await isPaneShown($)) || !(await surfacesAllowPane($))) return
  let due: string[] = []
  await update($, phaseSeen, seen => {
    due = proposalsDue(found, seen)
    if (due.length === 0) return seen
    const marked = { ...seen.seen }
    for (const rowKey of due) marked[rowKey] = found[rowKey]?.at ?? 0

    return { since: seen.since, seen: marked }
  })
  if (due.length === 0) return
  const S = strings(options.language)
  const home = await read($, checkoutKey)
  const refs = due.map(rowKey => toastRef(rowKey, home))
  offerToast('proposal', refs.length === 1 ? S.proposalToast(refs[0] ?? '') : S.proposalsToast(refs.join(', ')), 8_000)
  if (!isRunning) flushToasts($)
}

// E13: issue sessions in the sidebar ----------------------------------------------------

/** The installation-wide sidebar choice from the store into the state (written only on a change: every write redraws). */
async function loadSidebar($: EngineInterface): Promise<SidebarChoice> {
  const choice = asSidebarChoice(await readStore<unknown>($, 'sidebar:choice'))
  if ((await read($, sidebar)).choice !== choice) await update($, sidebar, () => ({ choice }))

  return choice
}

/** The owner's answer in the pane (the question, or the ⚙ switch): kept for the installation; running issue sessions read it at their next turn. */
async function setSidebarChoice($: EngineInterface, value: boolean): Promise<void> {
  await writeStore($, 'sidebar:choice', { file: value, at: await $.clock.now() })
  await update($, sidebar, () => ({ choice: value ? ('on' as const) : ('off' as const) }))
}

/** Runs E13's tidy after `delayMs`, in a dispatch of its own (it reads what the identification or the turn just wrote); one pending at a time. */
function scheduleTidy($: EngineInterface, options: Options, delayMs: number, reason?: TurnCompleteReason): void {
  tidyTimer?.cancel()
  tidyTimer = $.clock.after(delayMs, () => {
    tidyTimer = undefined
    void tidySelf($, options, reason).catch(() => undefined)
  })
}

/**
 * E13, inside an issue session only and only for 'self' (plan section 3): while the owner said yes (read from the store
 * each time, so a later yes reaches running sessions), the session files itself under "Issues" once, follows a GitHub
 * rename of its issue while its title is still the one the mod gave it, and after a finished turn marks itself unread
 * when the app says it is open nowhere. Every call quiet (never a card). Nothing before the session's first record (its
 * first turn's end), and nothing for the spike's session.
 */
async function tidySelf($: EngineInterface, options: Options, reason: TurnCompleteReason | undefined): Promise<void> {
  const self = await read($, selfIssue)
  if (self === null || self.isSpike || isTidying) return
  if (asSidebarChoice(await readStore<unknown>($, 'sidebar:choice')) !== 'on') return
  const record = ownLatest ?? (await read($, ownPhase))
  if (record === null) return
  isTidying = true
  try {
    const now = await $.clock.now()
    const wantsFile = record.filedAt === undefined && (record.fileTries ?? 0) < FILE_TRIES
    const wantsTitle = now - lastTitleCheck >= TITLE_GAP_MS
    if (wantsFile || wantsTitle) {
      const me = await peekSession($, 'self')
      if (wantsFile) await fileSelf($, options, me, record)
      if (wantsTitle) {
        lastTitleCheck = now
        await syncSelfTitle($, options, self, me)
      }
    }
    if (reason !== undefined && reason !== 'aborted') await markIfAway($)
  } catch (error) {
    $.ui.log(`${PLUGIN}: tidying the sidebar failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
  } finally {
    isTidying = false
  }
}

/** An E13 field in the session's own record, through its one write point; the state stays as it is (writePhase keeps its time). */
async function stampSelf($: EngineInterface, options: Options, extra: Partial<Pick<PhaseRecord, 'title' | 'filedGroupId' | 'filedAt' | 'fileTries'>>): Promise<void> {
  const before = ownLatest ?? (await read($, ownPhase))
  if (before === null) return
  await writePhase($, options, before.activity, before.ask, false, extra)
}

/**
 * Files this session under the "Issues" group, once (A-F7): a session in a group already (the owner's filing) is only
 * noted; a pinned one is left alone (a move unpins it); nothing moves unless the sidebar's list groups by custom groups
 * (a move would switch the owner's view otherwise); the stored group the app no longer lists was removed by the owner,
 * so it is never made again and the pane asks anew; a group is made only when the app's list of groups answered. A try
 * the app could not answer counts (at most five); one the layout did not allow does not.
 */
async function fileSelf($: EngineInterface, options: Options, me: Peek, record: PhaseRecord): Promise<void> {
  const S = strings(options.language)
  const now = await $.clock.now()
  const countTry = async () => stampSelf($, options, { fileTries: (record.fileTries ?? 0) + 1 })
  if (me.kind !== 'found' || me.entry.group === undefined) {
    await countTry()

    return
  }
  if (me.entry.group !== null) {
    await stampSelf($, options, { filedAt: now, filedGroupId: me.entry.group })

    return
  }
  if (me.entry.pinned === true) return
  const sectionsAnswer = await quietDesktop($, 'ccd_sidebar', 'list_sections', {})
  const listed = sectionsAnswer.ok ? parseSections(sectionsAnswer.structured, sectionsAnswer.text) : null
  if (listed === null) return
  const groupsAnswer = await quietDesktop($, 'ccd_sidebar', 'list_groups', {})
  const groups = groupsAnswer.ok ? parseGroups(groupsAnswer.structured, groupsAnswer.text) : null
  if (groups === null) {
    await countTry()

    return
  }
  const storedId = storedGroupId(await readStore<unknown>($, 'sidebar:group'))
  if (storedId !== null && !groups.some(group => group.id === storedId)) {
    await $.store.delete('sidebar:group').catch(() => undefined)
    await $.store.delete('sidebar:choice').catch(() => undefined)
    $.ui.log(`${PLUGIN}: the sidebar group ${storedId} is gone; issue sessions file themselves again only after a new yes`, { to: 'debug' })

    return
  }
  let group = groupFor(groups, storedId)
  if (!viewShowsGroup(listed, group?.id ?? null)) return
  if (group === undefined) {
    const created = await quietDesktop($, 'ccd_sidebar', 'create_group', { name: SIDEBAR_GROUP })
    const id = created.ok ? parseGroupId(created.structured, created.text) : null
    if (id === null) {
      await countTry()

      return
    }
    group = { id, name: SIDEBAR_GROUP, order: groups.length }
    $.ui.toast(S.groupCreated)
  }
  await writeStore($, 'sidebar:group', { id: group.id, name: group.name, at: now })
  const moved = await quietDesktop($, 'ccd_sidebar', 'move_sessions', { session_ids: ['self'], group_id: group.id })
  if (moved.ok) await stampSelf($, options, { filedAt: now, filedGroupId: group.id })
  else await countTry()
}

/**
 * Follows a GitHub rename of this session's issue (the panes' stored list, no gh call) only while the session's title is
 * the one the mod gave it: the mapping's (what start_session got) or one the mod set and noted since (A-F6). A session
 * the store's mapping does not name (marker only) is never retitled; any other title is the owner's and stays.
 */
async function syncSelfTitle($: EngineInterface, options: Options, self: SelfIssue, me: Peek): Promise<void> {
  if (me.kind !== 'found' || me.entry.title === '') return
  const mapping = asMapping(await readStore<unknown>($, storeKeyOf('session:', self.rowKey)))
  if (mapping === undefined || !isOwnSession(mapping, [...(await ownIds($)), me.entry.id])) return
  const mine = (ownLatest ?? (await read($, ownPhase)))?.title ?? mapping.title
  if (me.entry.title !== mine) return
  const cache = await readStore<RepoCache>($, storeKeyOf('cache:', self.rowKey.slice(0, self.rowKey.lastIndexOf('#'))))
  const row = (Array.isArray(cache?.rows) ? cache.rows : []).filter(isRowLike).find(found => found.number === self.number)
  if (row === undefined) return
  const expected = sessionTitle(row)
  if (expected === mine) return
  const set = await quietDesktop($, 'ccd_session_mgmt', 'set_session_title', { session_id: 'self', title: expected })
  if (set.ok) await stampSelf($, options, { title: expected })
}

/** After a finished turn: unread only when ccd_view's layout positively says this session is open nowhere (A-F9); anything else leaves it. */
async function markIfAway($: EngineInterface): Promise<void> {
  const layout = await quietDesktop($, 'ccd_view', 'get_layout', {})
  if (!layout.ok || isOffScreen(layout.structured, layout.text) !== true) return
  await quietDesktop($, 'ccd_sidebar', 'set_unread', { session_id: 'self', unread: true })
}

/** The spike's line for E13 (S22): the sidebar's sections and how they group, the groups, and what get_layout says; read-only, the mcp route alone. */
async function sidebarLine($: EngineInterface): Promise<string> {
  const quiet = { isMeasurement: true, isMcpOnly: true }
  const sectionsAnswer = await quietDesktop($, 'ccd_sidebar', 'list_sections', {}, quiet)
  const groupsAnswer = await quietDesktop($, 'ccd_sidebar', 'list_groups', {}, quiet)
  const layout = await quietDesktop($, 'ccd_view', 'get_layout', {}, quiet)
  const listed = sectionsAnswer.ok ? parseSections(sectionsAnswer.structured, sectionsAnswer.text) : null
  const groups = groupsAnswer.ok ? parseGroups(groupsAnswer.structured, groupsAnswer.text) : null
  const away = layout.ok ? isOffScreen(layout.structured, layout.text) : null
  const sectionsText = listed === null ? `not read (${sectionsAnswer.ok ? 'no list in the answer' : sectionsAnswer.reason})` : listed.map(found => `${found.id}:${found.kind || '?'}:${found.groupBy || '-'}${found.isShown ? '' : ':hidden'}`).join(', ') || 'none'
  const groupsText = groups === null ? `not read (${groupsAnswer.ok ? 'no list in the answer' : groupsAnswer.reason})` : String(groups.length)
  const layoutText = away === null ? `unreadable (${layout.ok ? layout.text.slice(0, 80) : layout.reason})` : away ? 'views empty' : 'views listed'

  return `sidebar (quiet, mcp only): sections ${sectionsText}; groups ${groupsText}; get_layout ${layoutText}`
}

/**
 * The pane's hygiene at a session's start: issue-session records whose row has no mapping and that are a day old, and
 * unreadable ones; closed issues' sessions two weeks after the issue closed (E22-b).
 */
async function sweepStale($: EngineInterface, now: number): Promise<void> {
  const keys = await $.store.keys().catch(() => [] as string[])
  for (const key of keys) {
    if (key.startsWith('phase:')) {
      const record = readPhase(await readStore<unknown>($, key))
      const isMapped = asMapping(await readStore<unknown>($, storeKeyOf('session:', key.slice('phase:'.length)))) !== undefined
      if (record === null || (!isMapped && now - record.at > PHASE_KEEP_MS)) await $.store.delete(key).catch(() => undefined)
    } else if (key.startsWith('done:')) {
      const record = asDone(await readStore<unknown>($, key))
      if (record === undefined || now - record.closedAt > DONE_KEEP_MS) await $.store.delete(key).catch(() => undefined)
    }
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
  toolReads.clear()
  toolReading.clear()
  checkoutTriedAt = Number.NEGATIVE_INFINITY
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
  // E2: what the conversation carries is attached again on its next mention.
  await update($, attached, () => NO_ATTACHED)
  // E1, E10, E22-b: the sessions' records, the app's word on them, the attempts and the closed issues' sessions went with
  // the store; the proposals toasted stay toasted (a reset never toasts one again).
  unparsed.clear()
  lastListed = null
  peekCursor = 0
  await update($, phases, () => ({}))
  await update($, sessionLive, () => ({}))
  await update($, attempts, () => ({}))
  await update($, freshAsk, () => '')
  await update($, done, () => ({}))
  // E13: the sidebar choice went with the store: the pane asks again (the group is found again by name, never made twice).
  await update($, sidebar, () => ({ choice: 'unasked' as const }))
}

/**
 * The spike: one throw-away session, started the way the button starts one, to learn which route works and what the
 * app answers; then one quiet read of this session's own metadata, the way the mod's own calls go (never a card).
 */
async function runSpike($: EngineInterface, command: string): Promise<string> {
  const consent = commandConsent(`/${command} spike`)
  // E12: the marker names this session (read now: a /clear goes on under another id, B-E10-5), so the spike's session
  // shows its own status line (S19) and this one never takes the brief for a hand-off.
  const brief = spikeBrief(await $.session.id().catch(() => myId))
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
  let selfId = ''
  if (self.ok) {
    const data = parseObject(self.structured, self.text)
    const keys = Object.keys(data)
    lines.push(`get_session self (quiet, via ${self.via}): ${keys.length === 0 ? 'no JSON' : `keys ${keys.slice(0, 40).join(', ')}`}`)
    selfId = typeof data['sessionId'] === 'string' ? data['sessionId'] : typeof data['id'] === 'string' ? data['id'] : ''
    if (selfId !== '' && (await read($, desktopId)) === '') await update($, desktopId, () => selfId)
  } else lines.push(`get_session self (quiet): not read (${self.reason})`)
  // S4 (E12): whether the desktop's id of this session is its engine id.
  lines.push(`session ids: engine ${myId || '?'}, desktop ${selfId || 'not read'}`)
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
  // S20 (E1): what the app's session list holds: how many, the keys of an entry, the state words; never a title. The
  // mcp route alone: a measurement.
  const listing = await listSessions($, { isMeasurement: true, isMcpOnly: true })
  if (listing.ok) {
    const words = [...new Set(listing.entries.map(entry => entry.state).filter(word => word !== ''))].slice(0, 12)
    lines.push(
      `list_sessions (quiet, via ${listing.via}): ${listing.entries.length} active${listing.isFull ? ' (the limit)' : ''}; keys ${listing.entries[0]?.keys.join(', ') || 'none'}; state words ${words.join(', ') || 'none'}; pull-request field ${listing.entries.some(entry => entry.pr !== 'unknown') ? 'present' : 'absent'}`,
    )
  } else lines.push(`list_sessions (quiet): not read (${listing.reason})`)
  // S22 (E13): how the sidebar groups, which groups there are, and whether get_layout tells "open nowhere"; read-only.
  lines.push(await sidebarLine($))
  // S19 (E12): the spike's session sets its status line; the owner looks for it.
  lines.push('status line: the spike session shows "Issue-Radar-Spike" under its prompt where the app draws a plugin status line (S19)')
  // S18 (E6): whether this host adds a plugin's tool at run time; S16 (E2, E5): what the desktop stamps on a typed prompt.
  lines.push(await issueToolLine($), `last prompt origin: ${lastPromptOrigin || 'none yet'}`)

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
    // E12: a session that already knew it was an issue session (a hot reload, B-E12-2) stays stood down with its line.
    const wasChild = (await read($, isIssueSession)) || (await read($, selfIssue)) !== null
    const isChild = wasChild || (myId !== '' && Object.values(known).some(mapping => mapping.sessionId === myId))
    if (isChild) {
      if ((await read($, selfIssue)) === null) await identifyByMapping($, options)
      await update($, isIssueSession, () => true)
      standDown()
      await applyStatus($, options, await read($, selfIssue), await read($, ownPhase))
      // E13: a reloaded issue session looks at its filing again (the tidy reads the state in a dispatch of its own).
      scheduleTidy($, options, 1_000)
    } else {
      // E13: whether the pane asks to file issue sessions in the sidebar.
      await loadSidebar($)
      // No pane and no polling inside an issue session; /issue-radar still opens it there.
      armTimer($, options)
      schedule($, options, 600, 'start')
      // E12 (B-E12-1): whether this session's desktop id names a mapping, asked once; the start refresh waits for it a
      // moment (IDENTIFY_WAIT_MS, B5-BEH-1).
      identifying = identifyByMapping($, options).catch(() => false)
      // E10: proposals made before this session began are not toasted; E12, E22-b: the store's hygiene.
      const now = await $.clock.now()
      await update($, phaseSeen, seen => (seen.since === 0 ? { ...seen, since: now } : seen))
      await sweepStale($, now)
    }
    // E6: the issue tool, in issue sessions too (their brief's phase 1 reads with it), once the start is scheduled, and
    // only in a git repository (C-E6-8); awaited, so it is listed by turn one.
    if ((await $.session.repo().catch(() => null)) !== null) await registerIssueTool($)
    else issueToolProblem = 'no git repository here'

    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    // E12: a desktop that attaches may answer what this session's id is (B-E12-1); an identification still running is
    // waited for, never replaced (R5-RT-1), at most IDENTIFY_WAIT_MS (B5-BEH-1). An issue session shows its line again.
    if (e.surface === 'desktop' && (await read($, selfIssue)) === null && (await read($, desktopId)) === '') identifying = identifyAfter($, options, identifying).catch(() => false)
    // This dispatch's reads see the moment it began: an identification that landed while it waited is known by the
    // answer and the module flag only, and it has set the line itself.
    const isFound = (await identifiedSoon($)) || isSelfFound
    if (wantsPane && !isFound && !(await read($, isIssueSession)) && (e.surface === 'desktop' || e.surface === 'terminal')) {
      await openPane($, options, false)
      armTimer($, options)
      schedule($, options, 400, 'tool')
    }
    const self = await read($, selfIssue)
    if (self !== null) await applyStatus($, options, self, await read($, ownPhase))

    return attached
  })

  // The issue session recognizes its own brief and stays out of the way; a brief this
  // session filled itself (Take it here, or the no-route fallback) is not that case.
  // E2: a person's prompt that mentions open issues carries them as context, from what
  // the session holds only (never gh on Enter). A failure lets the prompt through as it
  // came: the .catch passes it on (next is replay-safe there).
  on('prompt.submit', async ($, e, next) => {
    lastPromptOrigin = e.origin.kind
    if (e.text.trimStart().startsWith(MARKER) && (await read($, selfIssue)) === null) {
      const marker = parseMarker(e.text)
      if (!(await isOwnBrief($, e.text, marker))) {
        // E12 (plan 4.5): the marker as the session's FIRST user message makes it the issue session (its line, its
        // record); a marker in a later prompt only stands the session down, as V1 did (A-F5).
        const isFirst = (await firstUserText($, e.text)) === e.text
        if (!(isFirst && (await identifyByMarker($, options, e.text))) && !(await read($, isIssueSession))) {
          await update($, isIssueSession, () => true)
          standDown()
          void $.ui.close({ id: PANE }).catch(() => undefined)
        }
      }
    }
    // E5: a prompt the owner sent while the pane is shown is a look at it (the desktop's stamp is S16's question).
    if ((e.origin.kind === 'composer' || e.origin.kind === 'sdk') && !(await read($, isIssueSession)) && (await isPaneShown($))) void noteLook($, options).catch(() => undefined)
    if (!options.issueMentions) return next(e)
    // A hand-off brief, wherever its marker stands (a draft before it), carries its own issue and attaches nothing (C-E2-3).
    const isBrief = e.text.includes(MARKER)
    if (isBrief) await recordBrief($, e.text)
    const plan = isBrief ? null : await planMentions($, options, e)
    const entered = await next(plan === null ? e : { ...e, context: [...(e.context ?? []), ...plan.context] })
    if (plan !== null && entered.drop === undefined) await noteMentions($, options, plan)

    return entered
  }).catch(($, e, next) => next(e))

  // E12: the main loop's turns. Each hook passes the turn on first and does its work beside it (B-E12-5): an issue
  // session records what it is doing; a session not yet identified looks for its marker; a pane reads its rows' records.
  // The work runs in hook order through one chain (R5-RT-2): a turn's end never lands after the next turn's start.
  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    // E21: the running turn, at once and in module memory (a press's dispatch would not see the state's write).
    if (e.agentId === undefined) mainTurn = { turnId: e.turnId, since: await $.clock.now() }
    if (e.agentId === undefined) void inOrder(() => noteTurnStart($, options, e.turnId, e.text))

    return started
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const finished = await next(e)
    if (e.agentId === undefined) mainTurn = null
    if (e.agentId === undefined) void inOrder(() => noteTurnEnd($, options, e.reason, e.answer))

    return finished
  }).catch(($, e, next) => next(e))

  // E12/E10: a question dialog or a plan approval in an issue session's main loop: waiting while it is open (the plan
  // approval is the proposal). The dialog's answer is the owner's; this hook only notes the state around it.
  on('tool.call', { tool: ['AskUserQuestion', 'ExitPlanMode'] }, async ($, e, next) => {
    if (e.agentId !== undefined || (await read($, selfIssue)) === null) return next(e)
    await inOrder(() => noteDialog($, options, String(e.tool), true))
    const ran = await next(e)
    await inOrder(() => noteDialog($, options, String(e.tool), false))

    return ran
  }).catch(($, e, next) => next(e))

  // E2: the `#` typeahead, only while the setting is on (the engine raises the event only while a plugin hooks it). The
  // terminal asks it; the desktop app 4.23118 does not send the ask (C-E2-1), so there the attach at Enter remains.
  if (options.issueMentions) {
    // The matcher lets through the tokens holding a `#`; issueSuggestions reads them with MENTION_TOKEN.
    on('prompt.autocomplete', { token: /#/ }, async ($, e, next) => {
      const below = await next(e)
      const mine = await issueSuggestions($, options, e.token)

      return mine.length === 0 ? below : { suggestions: [...below.suggestions, ...mine] }
    }).catch(($, e, next) => next(e))

    // A compaction of the main conversation drops the blocks it carried: they are attached again on the next mention.
    on('session.compact', { trigger: /^(?:manual|auto|plugin)$/ }, async ($, e, next) => {
      const done = await next(e)
      if (e.agentId === undefined && done.skip === undefined) await update($, attached, () => NO_ATTACHED)

      return done
    }).catch(($, e, next) => next(e))

    // A /clear or a resume goes on under another conversation (C-E2-2); the record is keyed by its id as well.
    on('session.end', async ($, e, next) => {
      if (e.reason === 'clear' || e.reason === 'resume') await update($, attached, () => NO_ATTACHED).catch(() => undefined)

      return next(e)
    }).catch(($, e, next) => next(e))
  }

  // E6: the read-only issue tool (ISSUE_TOOL, spelled out so validate names it), answered here in core's place: no next,
  // so nothing beneath runs and nothing is written.
  on('tool.call', { tool: 'mcp__issue-radar__issue' }, ($, e) => answerIssueTool($, options, e as unknown as Record<string, unknown>, e.agentId)).catch(() =>
    toolError('could not answer this call; read the issue with gh issue view.'),
  )

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
    // E20/E21: the start form, what it read of this session, and whether it may carry this conversation (asked only while
    // a form is open on the desktop, so the running turn is read, and redraws, only then).
    const form = await read($, startForm)
    const facts = await read($, startFacts)
    const fork = form !== null && e.surface === 'desktop' ? await forkStateOf($, e.surface, facts) : 'none'

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
        phases: await read($, phases),
        sessionLive: await read($, sessionLive),
        attempts: await read($, attempts),
        freshAsk: await read($, freshAsk),
        done: await read($, done),
        startForm: form,
        startFacts: facts,
        forkState: fork,
        sidebar: (await read($, sidebar)).choice,
        ownIds: await ownIds($),
        myId,
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
        workOn: (sectionKey, number, label, surface) => void workOn($, options, sectionKey, number, label, surface),
        reopen: (sectionKey, number, label, surface) => void reopen($, options, sectionKey, number, label, surface),
        askFresh: rowKey => void askFresh($, rowKey),
        startAfresh: (sectionKey, number, label, surface) => void startAfresh($, options, sectionKey, number, label, surface),
        openDone: (rowKey, label, surface) => void openDone($, options, rowKey, label, surface),
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
        toggleForm: (rowKey, surface) => void toggleStartForm($, rowKey, surface),
        patchForm: (rowKey, patch) => void patchForm($, rowKey, patch),
        draftNote: (rowKey, text) => {
          noteDrafts.set(rowKey, text)
        },
        keepNote: (rowKey, text) => void keepNote($, rowKey, text),
        startFromForm: (rowKey, label, surface) => void startFromForm($, options, rowKey, label, surface),
        hereFromForm: rowKey => void hereFromForm($, options, rowKey),
        cancelForm: rowKey => void closeForm($, rowKey),
        saveGuidance: text => void saveGuidance($, options, text),
        clearGuidance: () => void saveSettings($, current => withGuidance(current, '')),
        toggleBeside: () => void toggleBeside($),
        sidebarChoice: value => void setSidebarChoice($, value),
      },
    )
  })
}
