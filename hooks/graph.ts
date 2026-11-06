// GraphQL through the signed-in `gh api graphql`: the argument vector, the
// call, and what its errors mean. The one way the mod speaks GraphQL, and the
// named `IssueRadar…` operations built from the fragments the features need:
// E7's probe and tier 2 (rows, details), E3's pull-request states and E17's
// relations ride in the same request, so a refresh sends one request per
// repository, and a second only when E7's probe found issues to read again.
import type { EngineInterface } from 'claude-code'

import type { IssueDetails, IssueRow, RepoInfo, RepoState } from '../types'
import { countOf, gh, isRecord, nodesOf, parseGraphDetails, parseGraphRow, parseJson, repoLabel, scopeIn } from './github'
import type { GhResult } from './github'
import { PR_LINKS_MAX, parsePrConnection } from './prs'
import type { PrLinks } from './prs'

/**
 * The longest argument vector sent, in characters. Builders keep a query near 12 KB; this guard refuses what
 * could approach the 32,767-character command line Windows allows. Never `--input -` instead: it fails on
 * Windows (cli/cli#14959).
 */
export const GRAPH_ARGV_MAX = 16_000

export type GraphVar = string | number | boolean

export type GraphError = {
  /** GitHub's error type (`NOT_FOUND`, `RATE_LIMITED`, `INSUFFICIENT_SCOPES` …); empty for a validation error, which has none. */
  type: string
  /** Where in the answer the error sits; empty for a query-wide error. */
  path: string[]
  message: string
}

export type GraphAnswer = { ok: true; data: Record<string, unknown>; errors: GraphError[]; cost: number | null } | { ok: false; state: RepoState }

type Json = Record<string, unknown>

const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * `gh api graphql` with the query and its variables. Strings always go with `-f` (raw): `-F` would read a file for
 * a value starting with `@` and fill `{owner}`/`{repo}` from the working directory. Integers and booleans go with
 * `-F`, which types them. `--hostname` is always named, so neither `GH_HOST` nor the checkout picks the host.
 */
export function graphqlArgs(host: string, query: string, vars: Readonly<Record<string, GraphVar>> = {}): string[] {
  const args = ['api', 'graphql', '--hostname', host, '-f', `query=${query}`]
  for (const [name, value] of Object.entries(vars)) {
    if (!VARIABLE.test(name) || name === 'query' || name === 'operationName') throw new Error(`invalid GraphQL variable name: ${name}`)
    if (typeof value === 'string') args.push('-f', `${name}=${value}`)
    else if (typeof value === 'boolean' || Number.isInteger(value)) args.push('-F', `${name}=${String(value)}`)
    else args.push('-f', `${name}=${String(value)}`)
  }

  return args
}

/** The operation a query names (`query IssueRadarProbe(…)` → `IssueRadarProbe`); null for an anonymous query. */
export function operationOf(query: string): string | null {
  return /^\s*(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query)?.[1] ?? null
}

/** The `errors` of a GraphQL answer, each with its type, path and message; empty when there are none. */
export function graphErrors(body: unknown): GraphError[] {
  if (!isRecord(body) || !Array.isArray(body['errors'])) return []

  return (body['errors'] as unknown[]).filter(isRecord).map(error => ({
    type: typeof error['type'] === 'string' ? error['type'] : '',
    path: Array.isArray(error['path']) ? (error['path'] as unknown[]).map(segment => String(segment)) : [],
    message: typeof error['message'] === 'string' ? error['message'] : '',
  }))
}

/**
 * The repository state a GraphQL error stands for, or null when it stands for none. A rate limit or a missing scope
 * stops the whole query wherever it is reported. Not found or forbidden counts only at the top (no path, or one
 * segment such as `['repository']`); deeper it is one alias's miss, and the rest of the data stands. A validation
 * error (no type, a path into the query) is null too: the caller reports it as an error.
 */
export function classifyGraph(errors: readonly GraphError[], host: string, repo: string): RepoState | null {
  if (errors.some(error => error.type === 'RATE_LIMITED')) return { kind: 'rate-limited', host }
  const scope = errors.find(error => error.type === 'INSUFFICIENT_SCOPES')
  if (scope !== undefined) return { kind: 'missing-scope', host, detail: scopeIn(scope.message) ?? 'read:project' }
  const top = errors.find(error => error.path.length <= 1 && (error.type === 'NOT_FOUND' || error.type === 'FORBIDDEN'))
  if (top !== undefined) return { kind: 'no-access', host, detail: repo }

  return null
}

function costOf(data: Json): number | null {
  const limit = data['rateLimit']

  return isRecord(limit) && typeof limit['cost'] === 'number' ? limit['cost'] : null
}

/** What GitHub says is left of the hour's points; eventually consistent, so nothing decides on it (logged only). */
export function remainingOf(data: Json): number | null {
  const limit = data['rateLimit']

  return isRecord(limit) && typeof limit['remaining'] === 'number' ? limit['remaining'] : null
}

/**
 * What a gh answer to a GraphQL request comes to. Exit 1 with `data` and only errors below the top level is
 * partial data, used rather than discarded; exit 4 is signed out whatever stdout holds; anything else is the
 * classified error, or the state gh's own message names.
 */
export function readGraph(ran: GhResult, host: string, repo: string): GraphAnswer {
  const body = parseJson(ran.ok ? ran.stdout : (ran.stdout ?? ''))
  const data = isRecord(body) && isRecord(body['data']) ? body['data'] : null
  const errors = graphErrors(body)
  if (ran.ok) {
    if (data !== null) return { ok: true, data, errors, cost: costOf(data) }

    return { ok: false, state: classifyGraph(errors, host, repo) ?? { kind: 'error', host, detail: 'gh api graphql answered no data' } }
  }
  if (ran.exitCode === 4) return { ok: false, state: ran.state }
  const wall = classifyGraph(errors, host, repo)
  if (wall !== null) return { ok: false, state: wall }
  if (data !== null && errors.length > 0 && errors.every(error => error.path.length >= 2)) return { ok: true, data, errors, cost: costOf(data) }

  return { ok: false, state: ran.state }
}

/** One GraphQL request for a repository's host; a query too long to send is refused before gh runs. */
export async function graphql($: EngineInterface, info: RepoInfo, query: string, vars: Readonly<Record<string, GraphVar>> = {}): Promise<GraphAnswer> {
  let args: string[]
  try {
    args = graphqlArgs(info.host, query, vars)
  } catch (error) {
    return { ok: false, state: { kind: 'error', host: info.host, detail: error instanceof Error ? error.message : String(error) } }
  }
  const length = args.reduce((sum, arg) => sum + arg.length + 1, 0)
  if (length > GRAPH_ARGV_MAX) return { ok: false, state: { kind: 'error', host: info.host, detail: `GraphQL request too long (${length} characters)` } }
  const ran = await gh($, args, { host: info.host, repo: repoLabel(info) })

  return readGraph(ran, info.host, repoLabel(info))
}

// The named operations ----------------------------------------------------

/** E7: a repository with at least this many open issues is probed on the timer instead of listed. */
export const PROBE_FROM = 40
/** GraphQL's page holds 100 issues: above that cap the probe stays off. */
export const PROBE_MAX = 100
/** At most this many issues are read again after one probe (tier 2's patch); more read the whole window. */
export const PATCH_MAX = 10
/** At most this many mapped issues ride in the probe, the oldest mapping first. */
export const MAPPED_MAX = 10
/** An unclassified failure pauses the probe of that repository this long; the V1 list runs meanwhile. */
export const PROBE_PAUSE_MS = 30 * 60_000
/** At most this many issues one pull-request request names (E3). */
export const PRS_MAX = 100

/** A pull request as E3 reads it: state, draft, review decision and the head commit's check rollup. */
const PR_FIELDS = 'number url state isDraft reviewDecision repository { nameWithOwner } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }'
/**
 * An issue's linked pull requests: open and merged, as gh's own view lists them (no includeClosedPrs, E7-1), the
 * newest three. GitHub lists the references oldest first, so `first` would read an old merged attempt and leave out
 * the newest, usually the actionable one; `orderByState` does not help, since it puts merged ones before open ones
 * (both measured live). `totalCount` still counts them all.
 */
const LINKS = `fragment Links on Issue { closedByPullRequestsReferences(last: ${PR_LINKS_MAX}) { totalCount nodes { ${PR_FIELDS} } } }`
/** E17's relations; blockers paged by 50, as gh's list does (E17-2). */
const RELATIONS = 'parent { number state title url } subIssuesSummary { completed total } blockedBy(first: 50) { totalCount nodes { number state title url } }'
const DETAILS = 'fragment Details on Issue { body comments(last: 3) { totalCount nodes { author { login } createdAt body } } }'
const WINDOW = 'issues(states: OPEN, first: $first, orderBy: {field: UPDATED_AT, direction: DESC})'
const LIMIT = 'rateLimit { cost remaining resetAt }'

function rowFragment(withRelations: boolean): string {
  return `fragment Row on Issue { number title url createdAt updatedAt state isPinned author { login } labels(first: 100) { nodes { name color } } assignees(first: 20) { nodes { login } } milestone { title }${withRelations ? ` ${RELATIONS}` : ''} }`
}

/** Issue numbers as a query may name them: whole, positive, each once, in the order given. */
function numbersOf(numbers: readonly number[]): number[] {
  return [...new Set(numbers.filter(number => Number.isInteger(number) && number > 0))]
}

/**
 * Tier 1 (E7): the open count and the top `$first` open issues by last update (number, update time, comment total),
 * one alias per mapped issue for its state, and with `withLinks` each issue's pull requests (E3) as well.
 */
export function probeQuery(mapped: readonly number[], withLinks: boolean): string {
  const aliases = numbersOf(mapped)
    .map(number => ` m${number}: issue(number: ${number}) { number state }`)
    .join('')

  return `query IssueRadarProbe($owner: String!, $name: String!, $first: Int!) { repository(owner: $owner, name: $name) { ${WINDOW} { totalCount nodes { number updatedAt comments { totalCount }${withLinks ? ' ...Links' : ''} } }${aliases} } ${LIMIT} }${withLinks ? ` ${LINKS}` : ''}`
}

/** Tier 2's patch (E7): rows, details and pull requests of exactly the issues the probe found new or changed. */
export function rowsQuery(numbers: readonly number[], withRelations: boolean): string {
  const aliases = numbersOf(numbers)
    .map(number => ` i${number}: issue(number: ${number}) { ...Row ...Details ...Links }`)
    .join('')

  return `query IssueRadarRows($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {${aliases} } ${LIMIT} } ${rowFragment(withRelations)} ${DETAILS} ${LINKS}`
}

/** Tier 2's full read (E7): the rows of the whole window; the details follow per changed issue, as V1 reads them. */
export function topQuery(withRelations: boolean): string {
  return `query IssueRadarTop($owner: String!, $name: String!, $first: Int!) { repository(owner: $owner, name: $name) { ${WINDOW} { totalCount nodes { ...Row } } } ${LIMIT} } ${rowFragment(withRelations)}`
}

/** E3 where V1's list ran: the pull requests of exactly the listed issues, one alias each. */
export function prsQuery(numbers: readonly number[]): string {
  const aliases = numbersOf(numbers)
    .map(number => ` i${number}: issue(number: ${number}) { number ...Links }`)
    .join('')

  return `query IssueRadarPrs($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {${aliases} } ${LIMIT} } ${LINKS}`
}

export type ProbeNode = { number: number; updatedAt: string; comments: number }
export type MappedState = 'OPEN' | 'CLOSED' | 'GONE'

/** What the probe found. */
export type Probe = {
  /** The repository's open issues in all. */
  total: number
  nodes: ProbeNode[]
  /** Each mapped issue's state; GONE when the repository no longer resolves it. */
  mapped: Map<number, MappedState>
  /** The probed issues' pull requests, when the probe asked for them. */
  links: Map<number, PrLinks> | null
  cost: number | null
  remaining: number | null
}

/** Whether an alias missed on its own: NOT_FOUND at `['repository', '<alias>']`, the repository itself resolved. */
function missed(errors: readonly GraphError[], alias: string): boolean {
  return errors.some(error => error.type === 'NOT_FOUND' && error.path.length === 2 && error.path[0] === 'repository' && error.path[1] === alias)
}

function noData(info: RepoInfo, what: string): { state: RepoState } {
  return { state: { kind: 'error', host: info.host, detail: `gh api graphql answered no ${what}` } }
}

/** Tier 1 (E7): one request, one point at the default window. */
export async function probeIssues($: EngineInterface, info: RepoInfo, first: number, mapped: readonly number[], withLinks: boolean): Promise<Probe | { state: RepoState }> {
  const numbers = numbersOf(mapped).slice(0, MAPPED_MAX)
  const answer = await graphql($, info, probeQuery(numbers, withLinks), { owner: info.owner, name: info.name, first })
  if (!answer.ok) return { state: answer.state }
  const repository = answer.data['repository']
  const issues = isRecord(repository) ? repository['issues'] : undefined
  if (!isRecord(repository) || !isRecord(issues)) return noData(info, 'issues')
  const nodes: ProbeNode[] = []
  const links = withLinks ? new Map<number, PrLinks>() : null
  for (const node of nodesOf(issues)) {
    if (!isRecord(node)) continue
    const number = Number(node['number'])
    if (!Number.isInteger(number) || number <= 0) continue
    const comments = node['comments']
    nodes.push({ number, updatedAt: typeof node['updatedAt'] === 'string' ? node['updatedAt'] : '', comments: countOf(isRecord(comments) ? comments['totalCount'] : undefined) ?? 0 })
    links?.set(number, parsePrConnection(node['closedByPullRequestsReferences']))
  }
  const states = new Map<number, MappedState>()
  for (const number of numbers) {
    const alias = `m${number}`
    const value = repository[alias]
    if (isRecord(value)) states.set(number, String(value['state']).toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN')
    else if (value === null && missed(answer.errors, alias)) states.set(number, 'GONE')
  }

  return { total: countOf(issues['totalCount']) ?? nodes.length, nodes, mapped: states, links, cost: answer.cost, remaining: remainingOf(answer.data) }
}

/** What tier 2's patch read: the issues still open with their details and pull requests, and those closed or gone. */
export type Patched = {
  rows: IssueRow[]
  details: Map<number, IssueDetails>
  links: Map<number, PrLinks>
  /** Closed since the probe, or no longer resolved: their rows go. */
  gone: number[]
  cost: number | null
  remaining: number | null
}

/** Tier 2's patch (E7): one request for at most PATCH_MAX issues; an alias that answers nothing else keeps its old row. */
export async function fetchChanged($: EngineInterface, info: RepoInfo, numbers: readonly number[], withRelations: boolean, now: number): Promise<Patched | { state: RepoState }> {
  const asked = numbersOf(numbers).slice(0, PATCH_MAX)
  const answer = await graphql($, info, rowsQuery(asked, withRelations), { owner: info.owner, name: info.name })
  if (!answer.ok) return { state: answer.state }
  const repository = answer.data['repository']
  if (!isRecord(repository)) return noData(info, 'repository')
  const patched: Patched = { rows: [], details: new Map(), links: new Map(), gone: [], cost: answer.cost, remaining: remainingOf(answer.data) }
  for (const number of asked) {
    const alias = `i${number}`
    const node = repository[alias]
    if (node === null && missed(answer.errors, alias)) {
      patched.gone.push(number)
      continue
    }
    const row = parseGraphRow(node)
    if (row === null || !isRecord(node)) continue
    if (String(node['state']).toUpperCase() !== 'OPEN') {
      patched.gone.push(number)
      continue
    }
    patched.rows.push(row)
    patched.details.set(number, parseGraphDetails(node, row, now))
    patched.links.set(number, parsePrConnection(node['closedByPullRequestsReferences']))
  }

  return patched
}

/** Tier 2's full read (E7): the rows of the top `first` open issues and the open count. */
export async function fetchTop($: EngineInterface, info: RepoInfo, first: number, withRelations: boolean): Promise<{ rows: IssueRow[]; total: number; cost: number | null; remaining: number | null } | { state: RepoState }> {
  const answer = await graphql($, info, topQuery(withRelations), { owner: info.owner, name: info.name, first })
  if (!answer.ok) return { state: answer.state }
  const repository = answer.data['repository']
  const issues = isRecord(repository) ? repository['issues'] : undefined
  if (!isRecord(issues)) return noData(info, 'issues')
  const rows = nodesOf(issues)
    .map(parseGraphRow)
    .filter((row): row is IssueRow => row !== null)

  return { rows, total: countOf(issues['totalCount']) ?? rows.length, cost: answer.cost, remaining: remainingOf(answer.data) }
}

/** E3 where V1's list ran: the listed issues' pull requests, at most PRS_MAX issues; an alias that misses has none. */
export async function fetchPrLinks($: EngineInterface, info: RepoInfo, numbers: readonly number[]): Promise<{ links: Map<number, PrLinks>; cost: number | null; remaining: number | null } | { state: RepoState }> {
  const asked = numbersOf(numbers).slice(0, PRS_MAX)
  const answer = await graphql($, info, prsQuery(asked), { owner: info.owner, name: info.name })
  if (!answer.ok) return { state: answer.state }
  const repository = answer.data['repository']
  if (!isRecord(repository)) return noData(info, 'repository')
  const links = new Map<number, PrLinks>()
  for (const number of asked) {
    const node = repository[`i${number}`]
    if (isRecord(node)) links.set(number, parsePrConnection(node['closedByPullRequestsReferences']))
  }

  return { links, cost: answer.cost, remaining: remainingOf(answer.data) }
}
