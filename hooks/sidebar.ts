// E13: issue sessions in the desktop's sidebar. Opt-in for the installation
// (asked once in the pane, store `sidebar:choice`); the filing, the title and
// the unread mark are done only by the issue session itself, for 'self', and
// only where the app's answers confirm it is safe (A-F5..A-F9). What the app's
// sidebar and view tools answer, read defensively: an answer the mod cannot
// read means doing nothing. Pure: no `$`.
import type { SidebarChoice } from '../types'
import { parseObject } from './session'

/** The group issue sessions are filed under: the pane's own title in both languages, so a switch of language never makes a second one. */
export const SIDEBAR_GROUP = 'Issues'
/** How often an issue session tries to file itself at most (a try the layout or the app does not allow is not counted). */
export const FILE_TRIES = 5
/** How often an issue session compares its title with its issue's at most. */
export const TITLE_GAP_MS = 10 * 60_000

export type SidebarGroup = { id: string; name: string; order: number }

/** One section of the sidebar as list_sections names it: its id, kind, how it groups and whether it is drawn. */
export type SidebarSection = { id: string; kind: string; groupBy: string; isShown: boolean }

/** The stored choice (`{ file: boolean }`) as the pane draws it: on, off, or not asked yet. */
export function asSidebarChoice(stored: unknown): SidebarChoice {
  if (typeof stored !== 'object' || stored === null) return 'unasked'
  const file = (stored as Record<string, unknown>)['file']

  return file === true ? 'on' : file === false ? 'off' : 'unasked'
}

/** The JSON array of an answer: its structured content, or the array in its text; null when neither holds one. */
function arrayOf(structured: unknown, text: string, key: string): unknown[] | null {
  if (Array.isArray(structured)) return structured
  if (typeof structured === 'object' && structured !== null && Array.isArray((structured as Record<string, unknown>)[key])) return (structured as Record<string, unknown>)[key] as unknown[]
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown

    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** list_groups' answer (`[{ id, name, session_count, order }]`); null when it holds no array (unknown, never empty). */
export function parseGroups(structured: unknown, text: string): SidebarGroup[] | null {
  const list = arrayOf(structured, text, 'groups')
  if (list === null) return null

  return list.flatMap((item, index) => {
    if (typeof item !== 'object' || item === null) return []
    const given = item as Record<string, unknown>
    const id = typeof given['id'] === 'string' ? given['id'] : ''
    if (id === '') return []
    const order = typeof given['order'] === 'number' ? given['order'] : index

    return [{ id, name: typeof given['name'] === 'string' ? given['name'] : '', order }]
  })
}

/** The id create_group answered: a structured `id`, `group_id` or `groupId`, the JSON in its text, else a labelled id in its prose. */
export function parseGroupId(structured: unknown, text: string): string | null {
  const data = parseObject(structured, text)
  for (const key of ['id', 'group_id', 'groupId']) {
    const value = data[key]
    if (typeof value === 'string' && value !== '') return value
  }
  const nested = data['group']
  if (typeof nested === 'object' && nested !== null && typeof (nested as Record<string, unknown>)['id'] === 'string') return (nested as Record<string, string>)['id'] ?? null
  if (Object.keys(data).length > 0) return null
  const labelled = /\b(?:group[_ ]?)?id\s*[:=]\s*["'`]?([A-Za-z0-9_-]{3,})/i.exec(text) ?? /\bgroup\s+["'`]?([A-Za-z0-9]+_[A-Za-z0-9_-]{2,})/i.exec(text)

  return labelled?.[1] ?? null
}

/** list_sections' answer (`[{ id, kind, group_by, shown, … }]`); null when it holds no array (no window open: unknown). */
export function parseSections(structured: unknown, text: string): SidebarSection[] | null {
  const list = arrayOf(structured, text, 'sections')
  if (list === null) return null

  return list.flatMap(item => {
    if (typeof item !== 'object' || item === null) return []
    const given = item as Record<string, unknown>
    const id = typeof given['id'] === 'string' ? given['id'] : ''
    if (id === '') return []
    const groupBy = typeof given['group_by'] === 'string' ? given['group_by'] : typeof given['groupBy'] === 'string' ? given['groupBy'] : ''

    return [{ id, kind: typeof given['kind'] === 'string' ? given['kind'] : '', groupBy, isShown: given['shown'] !== false }]
  })
}

/**
 * Whether filing this session into `groupId` (null: a group not created yet) leaves the owner's sidebar view as it is
 * (A-F7): move_sessions switches a list not grouped by custom groups to one that is, which the mod must never cause.
 * Only a list grouped `custom` is known to show custom groups; a group whose section the owner switched off is never
 * filed into. Anything else (another grouping, the sections layout, which the answers do not tell apart yet: S22)
 * means not now, and the next turn looks again.
 */
export function viewShowsGroup(sections: readonly SidebarSection[], groupId: string | null): boolean {
  const target = groupId === null ? undefined : sections.find(section => section.id === groupId)
  if (target !== undefined && !target.isShown) return false

  return sections.find(section => section.id === 'sessions')?.groupBy === 'custom'
}

/** The group to file into: the stored one while the app still lists it, else the lowest-order one named Issues; undefined for none. */
export function groupFor(groups: readonly SidebarGroup[], storedId: string | null): SidebarGroup | undefined {
  const stored = storedId === null ? undefined : groups.find(group => group.id === storedId)
  if (stored !== undefined) return stored

  return [...groups].filter(group => group.name.trim().toLowerCase() === SIDEBAR_GROUP.toLowerCase()).sort((a, b) => a.order - b.order)[0]
}

/**
 * Whether ccd_view's get_layout says this session is not open anywhere (A-F9): true only for an answer whose `views`
 * is an empty array; false when it lists views; null when it cannot be read (no unread mark then).
 */
export function isOffScreen(structured: unknown, text: string): boolean | null {
  const views = parseObject(structured, text)['views']
  if (!Array.isArray(views)) return null

  return views.length === 0
}

/** The group the stored record names (`sidebar:group`), or null. */
export function storedGroupId(stored: unknown): string | null {
  return storedGroup(stored)?.id ?? null
}

/** The stored record (`sidebar:group`): the group's id and when an issue session stored it (0 when it does not say); null for none. */
export function storedGroup(stored: unknown): { id: string; at: number } | null {
  if (typeof stored !== 'object' || stored === null) return null
  const { id, at } = stored as Record<string, unknown>

  return typeof id === 'string' && id !== '' ? { id, at: typeof at === 'number' && Number.isFinite(at) ? at : 0 } : null
}
