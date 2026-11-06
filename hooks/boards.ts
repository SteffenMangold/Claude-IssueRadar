// E18: GitHub Projects (v2) status per row, as pure functions: an issue's items
// as GraphQL answers them, E14's board facet (one value per project and status)
// and the status a row's pill shows. A chip and a filter, never a board: no
// columns, no drag, no status write. The read itself lives in graph.ts.
import type { BoardItem } from '../types'
import { asString, isRecord, loginOf, nodesOf } from './github'

/** The status a pill shows, in characters: with its mark it stays within a pill's 24. */
export const BOARD_STATUS_CHARS = 20

/**
 * An issue's `projectItems` connection: one item per open project (a closed project's item is left out), the
 * project's owner, number and title, and the item's single-select `Status` (null when unset, or when the project
 * names its status field otherwise).
 */
export function parseBoardItems(connection: unknown): BoardItem[] {
  const items: BoardItem[] = []
  for (const node of nodesOf(connection)) {
    if (!isRecord(node)) continue
    const project = node['project']
    if (!isRecord(project) || project['closed'] === true) continue
    const number = Number(project['number'])
    if (!Number.isInteger(number) || number <= 0) continue
    const owner = loginOf(project['owner'])
    const status = isRecord(node['status']) ? asString(node['status']['name']).trim() : ''
    items.push({ owner: owner === '?' ? '' : owner, project: number, title: asString(project['title']), status: status === '' ? null : status })
  }

  return items
}

/** The facet value of one project and status: `<owner>/<number>:<status>`, the status empty when unset. */
export function boardValue(item: Pick<BoardItem, 'owner' | 'project' | 'status'>): string {
  return `${item.owner}/${item.project}:${item.status ?? ''}`
}

/** Whether a row with these items stays drawn under the facet; an empty facet keeps every row. */
export function matchesBoard(items: readonly BoardItem[] | undefined, facet: string): boolean {
  return facet === '' || (items ?? []).some(item => boardValue(item) === facet)
}

/** The facet's options from the listed rows' items: one per project and status, by project title, then status. */
export function boardOptions(lists: readonly (readonly BoardItem[])[]): Array<{ value: string; title: string; status: string | null }> {
  const found = new Map<string, { value: string; title: string; status: string | null }>()
  for (const item of lists.flat()) {
    const value = boardValue(item)
    if (!found.has(value)) found.set(value, { value, title: item.title === '' ? `#${item.project}` : item.title, status: item.status })
  }

  return [...found.values()].sort((a, b) => a.title.localeCompare(b.title) || (a.status ?? '￿').localeCompare(b.status ?? '￿'))
}

/**
 * The item a row's pill speaks for: the one in the project the facet picked, else the first one (the first open
 * project's); null when the row is on no board.
 */
export function boardItemFor(items: readonly BoardItem[] | undefined, facet: string): BoardItem | null {
  const list = items ?? []
  if (facet !== '') {
    const project = facet.slice(0, facet.indexOf(':'))
    const picked = list.find(item => `${item.owner}/${item.project}` === project)
    if (picked !== undefined) return picked
  }

  return list[0] ?? null
}
