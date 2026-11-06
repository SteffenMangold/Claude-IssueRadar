// The pane's drawing: the title bar, one section per repository with its rows
// or its state, the consent row, the settings panel and the footer. The
// desktop gets tints, pills and an icon; the terminal the same layout in plain
// text. Nothing here writes state: every press goes to an action. Every string
// that came from GitHub, a model or the owner's settings goes through `clean`
// before it is drawn, as the last step: one control character or image-cell
// mark would get the whole tree refused.
import type { Elements, RenderElement, RenderSurface, Space } from 'claude-code'

import type { IssueDetails, IssueRef, IssueRow, Mapping, Options, PrRecord, Recap, RepoSettings, Section, SessionPr, StartRoute } from '../types'
import type { Strings } from './i18n'
import { linksOf, prChip, prLine, prRefOf } from './prs'
import type { PrTone, ShownPr } from './prs'
import { clean, cleanLine } from './text'

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
/** The most rows one drawing holds; the engine refuses a tree of more than 20,000 elements. */
const ROW_BUDGET = 200
/** How many label chips a row shows before the rest is counted; one fewer once another pill shows (plan 4.6). */
const LABELS_SHOWN = 4
/** The longest text a chip-line pill draws (plan 4.6). */
const PILL_CHARS = 24
/** How many pull-request chips the status strip draws before it counts the rest. */
const PR_CHIPS = 2
/** How many pull requests the opened row lists. */
const PR_LINES = 3

export function rowKeyOf(sectionKey: string, number: number): string {
  return `${sectionKey}#${number}`
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
  const S = state.strings
  const { options, settings } = state
  const step = (rich: Space, plain: number): Space => (isRich ? rich : plain)
  const wash = (hue: string, alpha: number) => (isRich ? tint(hue, alpha) : undefined)

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
      </Box>
      <Box flexDirection="row" alignItems="center" columnGap={step('xs', 1)}>
        {tool('refresh', state.isRefreshing ? '…' : '↻', S.refresh, actions.refresh)}
        {tool('settings', '⚙', S.settings, actions.toggleSettings)}
        {tool('close', '✕', S.close, actions.close)}
      </Box>
    </Box>
  )

  // Settings panel -------------------------------------------------------
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
        case 'ok':
          return section.rows.length === 0
            ? [line(S.empty(label)), section.info === null ? null : <Link href={clean(`${section.info.url}/issues`)} label={S.allIssues} />]
            : []
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
   * The chip line (plan 4.6, line 2): E17's blocked pill, the labels (at most four, three once another pill shows,
   * then `+n`), E17's progress and parent pills, the facts text last.
   */
  const chips = (section: Section, row: IssueRow, details: IssueDetails | undefined) => {
    const key = rowKeyOf(section.key, row.number)
    const sectionRepo = repoOfSection(section)
    // Rows come from the store too: every part of the relations is read as possibly absent.
    const relations = row.relations
    const lead: RenderElement[] = []
    const tail: RenderElement[] = []
    const open = relations?.blockedBy?.open ?? 0
    const firstBlocker = relations?.blockedBy?.refs?.[0]
    if (open > 0 && firstBlocker !== undefined) {
      lead.push(keyedPill(`blocked:${key}`, S.blockedChip(refLabel(firstBlocker, sectionRepo), open - 1), INK.warning, HUE.amber))
    }
    const subIssues = relations?.subIssues ?? null
    if (subIssues !== null) {
      const isDone = subIssues.completed >= subIssues.total
      tail.push(keyedPill(`subs:${key}`, S.subProgress(subIssues.completed, subIssues.total), isDone ? INK.success : INK.accent, isDone ? HUE.green : HUE.blue))
    }
    const parent = relations?.parent ?? null
    if (parent !== null) tail.push(keyedPill(`parent:${key}`, S.partOf(refLabel(parent, sectionRepo)), INK.muted, HUE.gray))
    const labelsShown = lead.length + tail.length > 0 ? LABELS_SHOWN - 1 : LABELS_SHOWN
    const parts: RenderElement[] = [...lead]
    row.labels.slice(0, labelsShown).forEach(label => parts.push(labelChip(clean(label.name), label.color)))
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

  /** The pull requests a row shows (E3): GraphQL's states, the details' links, the issue session's own. */
  const prsOf = (section: Section, item: IssueRow, details: IssueDetails | undefined) => {
    const key = rowKeyOf(section.key, item.number)
    const session = state.sessionPrs[key]

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
      </Box>
    )
  }

  const openedBlock = (section: Section, item: IssueRow, details: IssueDetails | undefined) => {
    // A seeded entry has no body or comments yet: the opened row reads as loading until the details land.
    if (details === undefined || details.fetchedAt === 0) {
      return (
        <Text size="caption" color={INK.muted}>
          …
        </Text>
      )
    }
    // Cleaned after the fold as well: trimming a leading space could bare a combining mark, which gets a tree refused.
    const text = cleanLine(details.body)
    const body = text === '' ? (details.excerpt === '' ? S.noBody : clean(details.excerpt)) : text.slice(0, 600)

    return (
      <Box flexDirection="column" rowGap={step('xs', 0)} paddingX={step('sm', 1)} paddingY={step('xs', 0)} borderStyle="round" backgroundColor={wash(HUE.gray, 0.05)}>
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
        <Button key={`row-title:${key}`} plain onPress={() => actions.toggleRow(key)}>
          <Text color={INK.muted}>#{item.number} </Text>
          <Text weight="semibold">{clean(item.title)}</Text>
        </Button>
        {chips(section, item, details)}
        {isOpen ? openedBlock(section, item, details) : recapLine(section, item, details, recap)}
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
  let rowsLeft = ROW_BUDGET

  /**
   * The pointer to the rest on GitHub (E7): `… +382 weitere auf GitHub ↗` once the open count is known and exceeds the
   * rows; while it is unknown, a capped list says it shows only the most recently updated, beside a link to all.
   */
  const pointer = (section: Section) => {
    const count = section.rows.length
    if (section.info === null || section.state.kind !== 'ok' || count === 0) return null
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

  const sectionBlock = (section: Section) => {
    const label = labelOf(section)
    const isCollapsed = settings.collapsed[section.key] === true
    const count = section.rows.length
    const counted = section.total !== undefined && section.total > count ? `${count}/${section.total}` : String(count)
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
    const drawn = section.rows.slice(0, Math.max(0, rowsLeft))
    rowsLeft -= drawn.length
    const rest = section.rows.length - drawn.length

    return (
      <Box key={`sec:${section.key}`} flexDirection="column" rowGap={step('xs', 0)}>
        {header}
        {stateBlock(section)}
        {consentBlock(section)}
        {drawn.map(item => row(section, item))}
        {rest > 0 && (
          <Text size="caption" color={INK.muted}>
            … +{rest}
          </Text>
        )}
        {pointer(section)}
      </Box>
    )
  }

  // Footer ---------------------------------------------------------------
  const fetchedAt = state.sections.reduce<number | null>((latest, section) => (section.fetchedAt !== null && (latest === null || section.fetchedAt > latest) ? section.fetchedAt : latest), null)
  const openCount = state.sections.reduce((sum, section) => sum + section.rows.length, 0)
  const footerParts: string[] = []
  if (fetchedAt !== null) footerParts.push(S.fetched(fmtTime(fetchedAt)))
  footerParts.push(S.openCount(openCount))
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
      {settingsPanel}
      <Box flexDirection="column" flexGrow={1} paddingY={step('sm', 0)} rowGap={step('sm', 0)}>
        {state.sections.length === 0 ? (
          <Box paddingX={step('sm', 1)}>
            <Text color={INK.secondary}>{S.loading('…')}</Text>
          </Box>
        ) : (
          state.sections.map(sectionBlock)
        )}
      </Box>
      {hairline()}
      {footer}
    </Box>
  )
}
