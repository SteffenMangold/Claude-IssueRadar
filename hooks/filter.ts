// E14: the pane's one filter over every section, as pure functions: the views,
// the search and what is stripped from it, the facets, the sort, the grouping
// and the saved views. A filtered list asks gh with effectiveQuery's text as ONE
// argument (`--search=<query>`), so a leading `-` (`-label:bug`) never reads as
// a flag; the default filter is V1's list, call and cache alike. Also E14-1's
// bound on what the store keeps of issues a list no longer shows.
import type { Facets, Filter, FilterGroup, FilterSort, IssueMeta, IssueRow, SavedView } from '../types'
import { clean } from './text'

export const DEFAULT_FILTER: Filter = { view: 'open', search: '', label: '', milestone: '', sort: 'updated', group: 'none', board: '' }
export const VIEWS = ['open', 'mine', 'unassigned', 'recent', 'blocked', 'epics'] as const
export type BuiltInView = (typeof VIEWS)[number]
export const SORTS: readonly FilterSort[] = ['updated', 'created', 'oldest', 'comments', 'reactions']
export const GROUPS: readonly FilterGroup[] = ['none', 'label', 'milestone', 'assignee']
/** Saved views per checkout repository. */
export const MAX_VIEWS = 8
/** A saved view's name, in characters. */
export const VIEW_NAME_CHARS = 24
/** The search as typed, in characters, before it is sanitized. */
export const TYPED_CHARS = 500
/** The sanitized search, in characters. */
export const SEARCH_CHARS = 200
/** The whole query gh is asked, in characters. */
export const QUERY_CHARS = 256
/** The longest search link the pane draws: the engine refuses a tree whose Link address passes 2,048 (E14-2). */
export const SEARCH_URL_MAX = 2_000
export const LABEL_FACETS = 20
export const MILESTONE_FACETS = 10
/** The picker value that stands for "any": never a value GitHub could name, so the options stay unique. */
export const ANY = '*'
/** The days the `recent` view reaches back. */
export const RECENT_DAYS = 7

const SORT_QUALIFIER: Record<FilterSort, string> = {
  updated: 'sort:updated-desc',
  created: 'sort:created-desc',
  oldest: 'sort:created-asc',
  comments: 'sort:comments-desc',
  reactions: 'sort:reactions-+1-desc',
}

/**
 * Qualifiers that would leave the repository, the open state or the issues (gh adds that scope itself), or that only
 * pull requests have. Measured live: `is:pr` exits 1, `is:closed` brings closed rows back, `is:draft` and `is:merged`
 * leak number-0 nodes. Matched on the token without its parentheses (E14-3), a leading `-` included.
 */
const DROP =
  /^-?(?:(?:repo|org|user|owner|state|draft|review|reviewed-by|review-requested|user-review-requested|team-review-requested|status|base|head|merged):|is:(?:open|closed|pr|pull-request|issue|draft|merged|unmerged)$|type:(?:pr|pull-request|issue)$)/i
/** GitHub search's operators, upper case only (`or` is a word). */
const OPERATOR = /^(?:AND|OR|NOT)$/
/** A search token: a run of non-space characters, quoted parts kept whole (`label:"help wanted"`). */
const TOKEN = /(?:[^\s"]+|"[^"]*")+/g

/** `text` cut to `max` code points: a cut never splits a surrogate pair. */
export function cutText(text: string, max: number): string {
  const points = Array.from(text)

  return points.length <= max ? text : points.slice(0, max).join('')
}

/** The UTC date `days` before `now`, as `closed:>=` and `updated:>=` take it. */
export function utcDay(now: number, days: number): string {
  return new Date(now - days * 86_400_000).toISOString().slice(0, 10)
}

/** The parentheses of a token outside its quoted parts. */
function parensOf(token: string): string {
  return token.replace(/"[^"]*"/g, '').replace(/[^()]/g, '')
}

function isBalanced(tokens: readonly string[]): boolean {
  let depth = 0
  for (const mark of tokens.map(parensOf).join('')) {
    depth += mark === '(' ? 1 : -1
    if (depth < 0) return false
  }

  return depth === 0
}

/**
 * What of a typed search reaches gh, and what was left out (the filter line names it). Tokens that would leave the
 * repository or the open issues are dropped (DROP), then operators left dangling, leading, trailing or doubled
 * (`label:bug OR is:closed` would become `label:bug OR`, which GitHub answers with nothing, E14-3), then every
 * parenthesis outside quotes once they no longer pair up. Cut to 200 characters.
 */
export function sanitizeQuery(text: string): { query: string; dropped: string[] } {
  const tokens = clean(text).match(TOKEN) ?? []
  const dropped: string[] = []
  const kept: string[] = []
  for (const token of tokens) {
    if (DROP.test(token.replace(/[()]/g, ''))) dropped.push(token)
    else kept.push(token)
  }
  const tidy: string[] = []
  for (const token of kept) {
    const last = tidy[tidy.length - 1]
    if (OPERATOR.test(token) && (last === undefined || OPERATOR.test(last))) dropped.push(token)
    else tidy.push(token)
  }
  const trailing: string[] = []
  while (tidy.length > 0 && OPERATOR.test(tidy[tidy.length - 1] ?? '')) trailing.unshift(tidy.pop() ?? '')
  dropped.push(...trailing)
  const paired = isBalanced(tidy) ? tidy : tidy.map(token => token.replace(/"[^"]*"|[()]/g, part => (part.startsWith('"') ? part : ''))).filter(token => token !== '')

  return { query: cutText(paired.join(' '), SEARCH_CHARS), dropped }
}

export function isBuiltInView(view: string): view is BuiltInView {
  return (VIEWS as readonly string[]).includes(view)
}

/**
 * A view's own query, the spellings measured live: `assignee:@me`, `no:assignee`, `updated:>=<UTC date 7 days ago>`,
 * `is:blocked`, `has:sub-issue` (singular: GitHub ignores the plural silently); a saved view's sanitized query; empty
 * for `open` and for a view that is gone.
 */
export function viewQuery(view: string, saved: readonly SavedView[], now: number): string {
  switch (view) {
    case 'open':
      return ''
    case 'mine':
      return 'assignee:@me'
    case 'unassigned':
      return 'no:assignee'
    case 'recent':
      return `updated:>=${utcDay(now, RECENT_DAYS)}`
    case 'blocked':
      return 'is:blocked'
    case 'epics':
      return 'has:sub-issue'
  }
  const custom = saved.find(found => found.id === view)

  return custom === undefined ? '' : sanitizeQuery(custom.query).query
}

/** A label or milestone as a qualifier, its quotes taken out; empty for none. */
function facetQualifier(name: string, value: string): string {
  const bare = value.replace(/"/g, '').trim()

  return bare === '' ? '' : `${name}:"${bare}"`
}

/** The query from the view's text, the search, the facets and the sort (unless the text sorts itself); null for V1's list. */
function composeQuery(f: Filter, viewText: string): string | null {
  const parts = [viewText, sanitizeQuery(f.search).query, facetQualifier('label', f.label), facetQualifier('milestone', f.milestone)].filter(part => part !== '')
  if (parts.length === 0 && f.sort === 'updated') return null
  const text = parts.join(' ')
  const sorted = /(?:^|\s)-?sort:/i.test(text) ? text : [text, SORT_QUALIFIER[f.sort] ?? SORT_QUALIFIER.updated].filter(part => part !== '').join(' ')

  return cutText(sorted, QUERY_CHARS)
}

/**
 * What a filtered list asks gh (`--search=<this>`): the view's query, the sanitized search, `label:"…"`,
 * `milestone:"…"` and the sort qualifier, cut to 256 characters. Null for the default filter, or one whose parts are
 * all empty and sorted as V1 sorts: that is V1's list, the same call and the same cache.
 */
export function effectiveQuery(f: Filter, saved: readonly SavedView[], now: number): string | null {
  return composeQuery(f, viewQuery(f.view, saved, now))
}

/**
 * Which filter asked a list: its query with the `recent` view's date left out, so it stays the same over UTC midnight;
 * undefined for V1's list. Two filters that ask the same (a search saved as a view and that view) share it. A section
 * whose key is not the current filter's is drawn as loading until its list comes (E14-5).
 */
export function filterKey(f: Filter, saved: readonly SavedView[]): string | undefined {
  return composeQuery(f, f.view === 'recent' ? `updated:>=-${RECENT_DAYS}d` : viewQuery(f.view, saved, 0)) ?? undefined
}

/** Whether the filter is the default one in every part (the filter line and its ✕ show otherwise). */
export function isDefaultFilter(f: Filter): boolean {
  return f.view === 'open' && f.search.trim() === '' && f.label === '' && f.milestone === '' && f.sort === 'updated' && f.group === 'none' && f.board === ''
}

/** GitHub's issue search for a query, open issues of the repository. Null when the query cannot be encoded. */
export function searchUrl(repoUrl: string, query: string): string | null {
  try {
    return `${repoUrl}/issues?q=${encodeURIComponent(`is:issue is:open ${query}`.trim())}`
  } catch {
    return null
  }
}

/**
 * The link to every match on GitHub, within what a Link may hold (E14-2): the whole query, else the view and the
 * facets without the free text, else none.
 */
export function matchesUrl(repoUrl: string, f: Filter, saved: readonly SavedView[], now: number): string | null {
  const whole = searchUrl(repoUrl, effectiveQuery(f, saved, now) ?? '')
  if (whole !== null && whole.length <= SEARCH_URL_MAX) return whole
  const lean = searchUrl(repoUrl, effectiveQuery({ ...f, search: '', view: isBuiltInView(f.view) ? f.view : 'open' }, saved, now) ?? '')

  return lean !== null && lean.length <= SEARCH_URL_MAX ? lean : null
}

/** What a row is grouped by: its first label, its milestone or its first assignee; empty for none. */
export function groupKeyOf(row: IssueRow, group: FilterGroup): string {
  if (group === 'label') return row.labels[0]?.name ?? ''
  if (group === 'milestone') return row.milestone ?? ''
  if (group === 'assignee') return row.assignees[0] ?? ''

  return ''
}

/**
 * The rows in groups, drawn without a fetch: the largest group first, then by name, the group without a value last;
 * the rows keep their order within a group. `none` is one group of all rows.
 */
export function groupRows(rows: readonly IssueRow[], group: FilterGroup): Array<{ id: string; rows: IssueRow[] }> {
  if (group === 'none') return [{ id: '', rows: [...rows] }]
  const groups = new Map<string, IssueRow[]>()
  for (const row of rows) {
    const id = groupKeyOf(row, group)
    const list = groups.get(id)
    if (list === undefined) groups.set(id, [row])
    else list.push(row)
  }

  return [...groups].map(([id, list]) => ({ id, rows: list })).sort((a, b) => Number(a.id === '') - Number(b.id === '') || b.rows.length - a.rows.length || a.id.localeCompare(b.id))
}

function byFrequency(names: readonly string[], max: number): string[] {
  const counts = new Map<string, number>()
  for (const name of names) if (name !== '' && name !== ANY) counts.set(name, (counts.get(name) ?? 0) + 1)

  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([name]) => name)
}

/** The labels (at most 20) and milestones (at most 10) the pickers offer, the most frequent first. */
export function facetsOf(lists: readonly (readonly IssueRow[])[]): Facets {
  const rows = lists.flat()

  return {
    labels: byFrequency(
      rows.flatMap(row => row.labels.map(label => label.name)),
      LABEL_FACETS,
    ),
    milestones: byFrequency(
      rows.map(row => row.milestone ?? ''),
      MILESTONE_FACETS,
    ),
  }
}

export function sameFacets(a: Facets, b: Facets): boolean {
  return a.labels.join('\n') === b.labels.join('\n') && a.milestones.join('\n') === b.milestones.join('\n')
}

/** A saved view's name as typed: one line, cleaned, at most 24 characters; null when nothing is left. */
export function cleanViewName(name: string): string | null {
  const plain = clean(name).replace(/\s+/g, ' ').trim()

  return plain === '' ? null : cutText(plain, VIEW_NAME_CHARS)
}

/** FNV-1a of the text as six hex digits. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5
  for (const char of text) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }

  return hash.toString(16).padStart(8, '0').slice(0, 6)
}

/**
 * A saved view's id: a slug of its name and a short hash of the whole name, so names without Latin letters, or names
 * that slug alike, get ids of their own (E14-6). The same name (in any case) is the same view: saving it again replaces it.
 */
export function viewIdOf(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 16)
    .replace(/-+$/g, '')

  return `custom:${slug === '' ? 'view' : slug}-${shortHash(name.trim().toLowerCase())}`
}

/** The saved views as stored, each checked: an id of this mod's form, a name, a query; at most 8, ids unique. */
export function asSavedViews(value: unknown): SavedView[] {
  if (!Array.isArray(value)) return []
  const views: SavedView[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const { id, name, query } = item as Record<string, unknown>
    if (typeof id !== 'string' || !/^custom:[a-z0-9-]{1,40}$/.test(id) || typeof name !== 'string' || typeof query !== 'string') continue
    const shown = cleanViewName(name)
    if (shown === null || views.some(view => view.id === id)) continue
    views.push({ id, name: shown, query: cutText(query, SEARCH_CHARS) })
    if (views.length >= MAX_VIEWS) break
  }

  return views
}

/** How many issues' meta (and recaps) the store keeps per repository: three lists' worth (E14-1). */
export function metaBound(maxIssues: number): number {
  return 3 * Math.max(1, maxIssues)
}

/**
 * E14-1: what the store keeps of a repository's issue meta. The issues listed now are kept and marked shown now; of
 * the rest, while the list is not the whole open set, the most recently shown, up to `bound` entries in all, so a
 * filter applied again finds its issues current instead of reading and recapping them again. A complete list (every
 * open issue) keeps only its own, as V1 did: an issue it lacks is closed.
 */
export function retainMeta(meta: Readonly<Record<string, IssueMeta>>, listed: ReadonlySet<string>, isComplete: boolean, bound: number, now: number): Record<string, IssueMeta> {
  const kept: Record<string, IssueMeta> = {}
  for (const number of listed) {
    const have = meta[number]
    if (have !== undefined) kept[number] = { ...have, seenAt: now }
  }
  if (isComplete) return kept
  const room = Math.max(0, bound - Object.keys(kept).length)
  const others = Object.entries(meta)
    .filter(([number]) => !listed.has(number))
    .sort((a, b) => (b[1].seenAt ?? 0) - (a[1].seenAt ?? 0))
    .slice(0, room)
  for (const [number, have] of others) kept[number] = have

  return kept
}
