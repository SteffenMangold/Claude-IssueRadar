// GraphQL through the signed-in `gh api graphql`: the argument vector, the
// call, and what its errors mean. The one way the mod speaks GraphQL; the
// queries themselves (named `IssueRadar…` operations) live with the features
// that need them, and a refresh sends at most one request per repository.
import type { EngineInterface } from 'claude-code'

import type { RepoInfo, RepoState } from '../types'
import { gh, parseJson, repoLabel, scopeIn } from './github'
import type { GhResult } from './github'

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

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

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
