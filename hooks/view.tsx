// The pane's drawing: the title bar, one section per repository with its rows
// or its state, the consent row, the settings panel and the footer. The
// desktop gets tints, pills and an icon; the terminal the same layout in plain
// text. Nothing here writes state: every press goes to an action.
import type { Elements, RenderElement, RenderSurface, Space } from 'claude-code'

import type { IssueDetails, IssueRow, Mapping, Options, Recap, RepoSettings, Section, StartRoute } from '../types'
import type { Strings } from './i18n'

type Table = Elements[keyof Elements]

/** What the pane draws from. */
export type ViewState = {
  sections: Section[]
  details: Record<string, IssueDetails>
  recaps: Record<string, Recap>
  mappings: Record<string, Mapping>
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
  refresh: () => void
  toggleSettings: () => void
  close: () => void
  toggleSection: (key: string) => void
  toggleRow: (rowKey: string) => void
  workOn: (sectionKey: string, number: number) => void
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
} as const

/** A color of no ink: a border that keeps its room without showing. */
const CLEAR = '#00000000'
/** The most rows one drawing holds; the engine refuses a tree of more than 20,000 elements. */
const ROW_BUDGET = 200
/** How many label chips a row shows before the rest is counted. */
const LABELS_SHOWN = 4

export function rowKeyOf(sectionKey: string, number: number): string {
  return `${sectionKey}#${number}`
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
  return section.info === null ? section.spec : `${section.info.owner}/${section.info.name}`
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

  /** A small label: a tinted, bordered Box on a graphical surface, a colored run on the terminal. */
  const pill = (text: string, ink: string, hue: string, isRound = false) =>
    isRich ? (
      <Box borderStyle={isRound ? 'round' : 'single'} borderColor={tint(hue, 0.35)} backgroundColor={tint(hue, 0.12)} paddingX="sm" paddingY={0} flexShrink={0}>
        <Text size="caption" weight="medium" color={ink}>
          {text}
        </Text>
      </Box>
    ) : (
      <Text color={ink}>{text}</Text>
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
              {spec}
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
    const host = section.state.host ?? section.info?.host ?? 'github.com'
    const line = (text: string, ink: string = INK.secondary) => (
      <Text size="footnote" color={ink} wrap="wrap">
        {text}
      </Text>
    )
    const retry = <Button key={`retry:${section.key}`} label={S.retry} onPress={actions.refresh} />
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
        case 'no-access':
          return [line(S.noAccess(section.state.detail ?? label), INK.warning), retry]
        case 'issues-disabled':
          return [line(S.issuesDisabled(label))]
        case 'archived':
          return [line(S.archived(label))]
        case 'offline':
          return [line(S.offline, INK.warning), retry]
        case 'rate-limited':
          return [line(S.rateLimited, INK.warning)]
        case 'error':
          return [line(S.error(section.state.detail ?? '?'), INK.error), retry]
        case 'ok':
          return section.rows.length === 0
            ? [line(S.empty(label)), section.info === null ? null : <Link href={`${section.info.url}/issues`} label={S.allIssues} />]
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
  const chips = (row: IssueRow, details: IssueDetails | undefined) => {
    const parts: RenderElement[] = []
    row.labels.slice(0, LABELS_SHOWN).forEach(label => parts.push(labelChip(label.name, label.color)))
    if (row.labels.length > LABELS_SHOWN) {
      parts.push(
        <Text size="caption" color={INK.muted}>
          +{row.labels.length - LABELS_SHOWN}
        </Text>,
      )
    }
    const created = shortAgo(row.createdAt, state.now, S.ago)
    const updated = shortAgo(row.updatedAt, state.now, S.ago)
    const facts: string[] = [created]
    if (updated !== created) facts.push(`↑ ${updated}`)
    if (details !== undefined) facts.push(S.comment(details.commentCount))
    if (row.assignees.length > 0) facts.push(row.assignees.map(name => `@${name}`).join(' '))
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
            {recap.text}
          </Text>
        )
      }
      if (recap !== undefined && recap.error !== undefined && recap.updatedAt >= row.updatedAt) {
        return (
          <Text size="caption" color={INK.muted} wrap="wrap">
            {details?.excerpt ?? ''} <Text color={INK.warning}>({S.recapFailed})</Text>
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
        {details.excerpt === '' ? S.noBody : details.excerpt} <Text color={INK.muted}>({S.noRecap})</Text>
      </Text>
    )
  }

  const openedBlock = (details: IssueDetails | undefined) => {
    // A seeded entry has no body or comments yet: the opened row reads as loading until the details land.
    if (details === undefined || details.fetchedAt === 0) {
      return (
        <Text size="caption" color={INK.muted}>
          …
        </Text>
      )
    }
    const body = details.body.trim() === '' ? (details.excerpt === '' ? S.noBody : details.excerpt) : details.body.replace(/\s+/g, ' ').slice(0, 600)

    return (
      <Box flexDirection="column" rowGap={step('xs', 0)} paddingX={step('sm', 1)} paddingY={step('xs', 0)} borderStyle="round" backgroundColor={wash(HUE.gray, 0.05)}>
        <Text size="caption" wrap="wrap">
          {body}
          {details.body.length > 600 ? ' …' : ''}
        </Text>
        <Text size="caption" weight="semibold" color={INK.secondary}>
          {S.lastComments}
        </Text>
        {details.comments.length === 0 && (
          <Text size="caption" color={INK.muted}>
            {S.noComments}
          </Text>
        )}
        {details.comments.map(comment => (
          <Text size="caption" color={INK.secondary} wrap="wrap">
            <Text weight="medium" color={INK.text}>
              {comment.author}
            </Text>{' '}
            · {shortAgo(comment.createdAt, state.now, S.ago)} · {comment.body.slice(0, 240)}
            {comment.body.length > 240 ? ' …' : ''}
          </Text>
        ))}
        {details.linkedPrs.length > 0 && (
          <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={step('sm', 1)}>
            <Text size="caption" weight="semibold" color={INK.secondary}>
              {S.linkedPrs}
            </Text>
            {details.linkedPrs.map(pr => (
              <Link href={pr.url} label={`#${pr.number} (${pr.state.toLowerCase()})`} />
            ))}
          </Box>
        )}
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
          <Text weight="semibold">{item.title}</Text>
        </Button>
        {chips(item, details)}
        {isOpen ? openedBlock(details) : recapLine(section, item, details, recap)}
        {mapping !== undefined && (
          <Text size="caption" color={INK.muted} wrap="truncate-end">
            {S.sessionLine(mapping.title, fmtTime(mapping.startedAt))}
            {mapping.detached ? '' : ` · ${S.sessionLinked}`}
          </Text>
        )}
        <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={step('sm', 1)} rowGap={step('xs', 0)}>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Link href={item.url} label={S.github} />
          </Box>
          <Button
            key={`work:${key}`}
            label={workLabel}
            variant={mapping === undefined && !isStarting ? 'primary' : undefined}
            dimColor={isStarting}
            onPress={() => {
              if (!isStarting) actions.workOn(section.key, item.number)
            }}
          />
          <Button key={`here:${key}`} plain label={S.takeHere} onPress={() => actions.takeHere(section.key, item.number)} />
        </Box>
      </Box>
    )
  }

  // Sections -------------------------------------------------------------
  let rowsLeft = ROW_BUDGET

  const sectionBlock = (section: Section) => {
    const label = labelOf(section)
    const isCollapsed = settings.collapsed[section.key] === true
    const count = section.rows.length
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
        {section.state.kind === 'ok' && pill(String(count), count > 0 ? INK.text : INK.muted, HUE.gray)}
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
      </Box>
    )
  }

  // Footer ---------------------------------------------------------------
  const fetchedAt = state.sections.reduce<number | null>((latest, section) => (section.fetchedAt !== null && (latest === null || section.fetchedAt > latest) ? section.fetchedAt : latest), null)
  const openCount = state.sections.reduce((sum, section) => sum + section.rows.length, 0)
  const footerParts: string[] = []
  if (fetchedAt !== null) footerParts.push(S.fetched(fmtTime(fetchedAt)))
  footerParts.push(S.openCount(openCount))
  if (options.recaps) footerParts.push(options.recapModel)
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
        issue-radar{state.version === '' ? '' : ` v${state.version}`}
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
