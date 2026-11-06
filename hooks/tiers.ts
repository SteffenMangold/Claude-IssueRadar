// E7's two-tier fetch: whether a repository's timed refresh asks the probe
// instead of the list, what the probe's answer plans, and what both tiers read,
// for the refresh to apply. This module reads GitHub only; the refresh writes
// the store and the state.
import type { EngineInterface } from 'claude-code'

import type { IssueDetails, IssueMeta, IssueRow, RepoCache, RepoInfo, RepoState } from '../types'
import { RELATION_FIELD, hasRelations, metaOf } from './github'
import { PATCH_MAX, PROBE_FROM, PROBE_MAX, fetchChanged, fetchTop, probeIssues } from './graph'
import type { Probe } from './graph'
import type { PrLinks } from './prs'

/**
 * Whether a timed or tool refresh of this repository asks the probe instead of V1's list: the list it would replace
 * exists, the window fits one GraphQL page (the cap at most 100), the repository is large (the last list came back
 * capped, or the probe counted at least PROBE_FROM open issues), and no unclassified failure paused the probe.
 */
export function probeEngaged(cache: RepoCache | undefined, maxIssues: number, now: number, pausedUntil: number): boolean {
  if (cache === undefined || !Array.isArray(cache.rows) || cache.rows.length === 0) return false
  if (maxIssues > PROBE_MAX || now < pausedUntil) return false

  return cache.rows.length >= maxIssues || (cache.total ?? 0) >= PROBE_FROM
}

export type ProbePlan = { kind: 'same' } | { kind: 'patch'; order: number[]; fetch: number[] } | { kind: 'full' }

/**
 * What the probe's answer asks for. New issues (in the probe, not the cache) and changed ones (a newer update time)
 * are read again; none of them and no drop is `same`; up to half the window (at most PATCH_MAX) or drops alone is a
 * `patch` in the probe's order; more is `full`.
 */
export function planFromProbe(probe: Pick<Probe, 'nodes'>, cached: readonly IssueRow[], first: number): ProbePlan {
  const known = new Map(cached.map(row => [row.number, row.updatedAt]))
  const fetch = probe.nodes.filter(node => !known.has(node.number) || node.updatedAt > (known.get(node.number) ?? '')).map(node => node.number)
  const listed = new Set(probe.nodes.map(node => node.number))
  const isDropped = cached.some(row => !listed.has(row.number))
  if (fetch.length === 0 && !isDropped) return { kind: 'same' }
  const patchMax = Math.min(PATCH_MAX, Math.max(1, Math.floor(first / 2)))
  if (fetch.length <= patchMax) return { kind: 'patch', order: probe.nodes.map(node => node.number), fetch }

  return { kind: 'full' }
}

export type TierInput = {
  info: RepoInfo
  /** The window: the cap (which is at most PROBE_MAX here). */
  first: number
  cache: RepoCache
  /** This repository's mapped issue numbers, the oldest mapping first. */
  mapped: readonly number[]
  /** Whether the probe asks the pull requests too (E3 due, the pane shown). */
  withLinks: boolean
  /**
   * Whether the host's schema answers E3's pull-request fields (false once a request was refused for them). Tier 2's
   * patch carries them; without them a patch reads the window instead (IssueRadarTop asks none), and hydrate's
   * `gh issue view` brings the changed issues' stateless links, as V1 has them.
   */
  hasPrFields: boolean
  now: number
}

/** What the two tiers came to. `released` names the mapped issues the probe found closed or gone. */
export type TierOutcome =
  /** An unclassified failure (a schema the host lacks, a 5xx): the refresh pauses the probe and lists as V1 does. */
  | { kind: 'paused'; state: RepoState; released: number[]; isRelations: boolean }
  /** A classified failure (rate limit, offline, signed out, no access, a scope): the last rows stay, the back-off holds. */
  | { kind: 'failed'; state: RepoState; released: number[] }
  | {
      kind: 'done'
      plan: ProbePlan['kind']
      rows: IssueRow[]
      total: number
      meta: Record<string, IssueMeta>
      /** Tier 2's details of the patched issues (body and comments for the state, never the store). */
      details: Map<number, IssueDetails>
      /** Every probed issue's pull requests, when the probe asked for them. */
      links: Map<number, PrLinks> | null
      /** The newest update time the probe saw. */
      asOf: string
      /** The patched issues' pull requests. */
      patchedLinks: Map<number, PrLinks>
      /** The newest update time among the patched issues. */
      patchedAsOf: string
      released: number[]
      cost: number | null
      remaining: number | null
    }

function failure(state: RepoState, released: number[], isRelations: boolean): TierOutcome {
  return state.kind === 'error' ? { kind: 'paused', state, released, isRelations: isRelations && RELATION_FIELD.test(state.detail ?? '') } : { kind: 'failed', state, released }
}

function newest(times: readonly string[]): string {
  return times.reduce((latest, time) => (time > latest ? time : latest), '')
}

function sum(a: number | null, b: number | null): number | null {
  return a === null ? b : b === null ? a : a + b
}

/**
 * Tier 1, then tier 2 as the plan says: `same` reads nothing more; `patch` reads rows, details and pull requests of
 * the new and changed issues and keeps the rest from the cache, in the probe's order; `full` reads the window's rows
 * (their details follow as V1 reads them); on a host that refused the pull-request fields a patch that reads issues is
 * a `full` read, since the patch's query carries those fields. The meta keeps what the store had for unchanged issues,
 * takes tier 2's for the patched ones, and the probe's comment totals for all.
 */
export async function runTiers($: EngineInterface, input: TierInput): Promise<TierOutcome> {
  const { info, first, cache, now } = input
  const withRelations = hasRelations(info, now)
  const probe = await probeIssues($, info, first, input.mapped, input.withLinks)
  if ('state' in probe) return failure(probe.state, [], false)
  const released = [...probe.mapped].filter(([, state]) => state !== 'OPEN').map(([number]) => number)
  const planned = planFromProbe(probe, cache.rows, first)
  const plan: ProbePlan = planned.kind === 'patch' && planned.fetch.length > 0 && !input.hasPrFields ? { kind: 'full' } : planned
  const byNumber = new Map(cache.rows.map(row => [row.number, row]))
  let rows: IssueRow[]
  let details = new Map<number, IssueDetails>()
  let patchedLinks = new Map<number, PrLinks>()
  let total = probe.total
  let cost = probe.cost
  let remaining = probe.remaining
  if (plan.kind === 'full') {
    const top = await fetchTop($, info, first, withRelations)
    if ('state' in top) return failure(top.state, released, withRelations)
    rows = top.rows
    total = Math.max(top.total, rows.length)
    cost = sum(cost, top.cost)
    remaining = top.remaining ?? remaining
  } else {
    if (plan.kind === 'patch' && plan.fetch.length > 0) {
      const patched = await fetchChanged($, info, plan.fetch, withRelations, now)
      if ('state' in patched) return failure(patched.state, released, withRelations)
      for (const row of patched.rows) byNumber.set(row.number, row)
      for (const number of patched.gone) byNumber.delete(number)
      details = patched.details
      patchedLinks = patched.links
      cost = sum(cost, patched.cost)
      remaining = patched.remaining ?? remaining
    }
    rows = probe.nodes.map(node => byNumber.get(node.number)).filter((row): row is IssueRow => row !== undefined)
  }
  const comments = new Map(probe.nodes.map(node => [node.number, node.comments]))
  const meta: Record<string, IssueMeta> = {}
  for (const row of rows) {
    const key = String(row.number)
    const fresh = details.get(row.number)
    const have = fresh === undefined ? cache.meta?.[key] : metaOf(fresh)
    if (have === undefined) continue
    const count = comments.get(row.number)
    meta[key] = count === undefined ? have : { ...have, commentCount: count }
  }

  return {
    kind: 'done',
    plan: plan.kind,
    rows,
    total: Math.max(total, rows.length),
    meta,
    details,
    links: probe.links,
    asOf: newest(probe.nodes.map(node => node.updatedAt)),
    patchedLinks,
    patchedAsOf: newest([...details.values()].map(found => found.updatedAt)),
    released,
    cost,
    remaining,
  }
}
