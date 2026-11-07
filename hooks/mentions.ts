// E2: issues in the prompt. The typeahead's rows for a `#` token, the open
// issues a sent prompt mentions, and the record of what the conversation
// already carries, so an issue is not attached again and again. Pure: no `$`.
import type { PromptAutocompleteSuggestion } from 'claude-code'

import type { Attached, AttachedRecord, IssueRow, RepoInfo } from '../types'
import { MARKER } from './brief'
import { repoOfUrl } from './github'
import { cleanLine } from './text'

/** The token at the caret a `#` typeahead answers: an optional opening bracket or quote, an optional repository, `#`, the query. */
export const MENTION_TOKEN = /^([(\[{"'<]?)((?:[\w.-]+\/){0,2}[\w.-]+)?#([^\s#]*)$/u

export type RepoRef = Pick<RepoInfo, 'host' | 'owner' | 'name'>

/** An open issue a section of the pane (or the store, in a session without one) lists. */
export type KnownIssue = { sectionKey: string; info: RepoRef; isCheckout: boolean; row: IssueRow }

export type MentionToken = { lead: string; repo: string | null; query: string }

/** A mention in a prompt: a number, and the repository it names (`name`, `owner/name`, `host/owner/name`) or none. */
export type Mention = { repo: string | null; number: number }

/** `#4`, `(#exp`, `reports#`, `acme/reports#7` as lead, repository and query; null for any other token. */
export function parseMentionToken(token: string): MentionToken | null {
  const found = MENTION_TOKEN.exec(token)
  if (found === null) return null

  return { lead: found[1] ?? '', repo: found[2] ?? null, query: found[3] ?? '' }
}

/** Whether `spec` (`name`, `owner/name` or `host/owner/name`) names this repository, case aside. */
export function matchesRepo(spec: string, info: RepoRef): boolean {
  const parts = spec.toLowerCase().split('/')
  const host = info.host.toLowerCase()
  const owner = info.owner.toLowerCase()
  const name = info.name.toLowerCase()
  if (parts.length === 1) return parts[0] === name
  if (parts.length === 2) return parts[0] === owner && parts[1] === name

  return parts.length === 3 && parts[0] === host && parts[1] === owner && parts[2] === name
}

/** How a mention names an issue: `#42` in the checkout's repository, `owner/name#7` on github.com, `host/owner/name#7` elsewhere. */
export function mentionRef(issue: Pick<KnownIssue, 'info' | 'isCheckout' | 'row'>): string {
  if (issue.isCheckout) return `#${issue.row.number}`
  const repo = `${issue.info.owner}/${issue.info.name}`

  return issue.info.host.toLowerCase() === 'github.com' ? `${repo}#${issue.row.number}` : `${issue.info.host}/${repo}#${issue.row.number}`
}

/** The known issues a repository spec names; a bare name that names several repositories names none. */
function ofRepo(known: readonly KnownIssue[], spec: string): KnownIssue[] {
  const matching = known.filter(issue => matchesRepo(spec, issue.info))
  if (!spec.includes('/') && new Set(matching.map(issue => issue.sectionKey)).size > 1) return []

  return matching
}

/**
 * The typeahead's rows for a token: up to `max` known open issues. A number matches number prefixes, the exact one
 * first; words match titles, case aside; an empty query lists them in the pane's order (the checkout first, the most
 * recently updated first). Taking a row writes the reference and a space, which closes the typeahead; a leading
 * bracket or quote stays.
 */
export function suggestIssues(known: readonly KnownIssue[], token: MentionToken, describe: (issue: KnownIssue) => string, max: number): PromptAutocompleteSuggestion[] {
  const pool = token.repo === null ? known : ofRepo(known, token.repo)
  const query = token.query.toLowerCase()
  let found: KnownIssue[]
  if (query === '') found = [...pool]
  else if (/^\d+$/.test(query)) {
    const prefixed = pool.filter(issue => String(issue.row.number).startsWith(query))
    found = [...prefixed.filter(issue => String(issue.row.number) === query), ...prefixed.filter(issue => String(issue.row.number) !== query)]
  } else found = pool.filter(issue => issue.row.title.toLowerCase().includes(query))

  return found.slice(0, max).map(issue => {
    const ref = mentionRef(issue)
    const label = cleanLine(`${ref} ${issue.row.title}`)

    return { text: `${token.lead}${ref} `, label: label.length > 80 ? `${label.slice(0, 79)}…` : label, description: cleanLine(describe(issue)) }
  })
}

/** A typeahead row's dim line without a recap: the repository for a watched one, up to two labels, the age. */
export function describeIssue(issue: KnownIssue, age: string): string {
  const parts = [...(issue.isCheckout ? [] : [`${issue.info.owner}/${issue.info.name}`]), ...issue.row.labels.slice(0, 2).map(label => label.name), age]

  return parts.filter(part => part !== '').join(' · ')
}

const BLOCKS = /<(issue-text|issue-comments|issue-tree|triage-gaps)>[\s\S]*?(?:<\/\1>|$)/gi
const FENCES = /```[\s\S]*?(?:```|$)/g
const SPANS = /`[^`\n]*`/g
const QUOTED_LINES = /^[ \t]*>.*$/gm
const ISSUE_URL = /https?:\/\/([\w.-]+)\/([\w.-]+)\/([\w.-]+)\/issues\/(\d{1,7})(?![\w/])/g
const ANY_URL = /https?:\/\/\S+/g
const REF = /(?<![\w/#&@])((?:[\w.-]+\/){0,2}[\w.-]+)?#(\d{1,7})(?![\w-])/gu

/** `text` with what matched blanked out, its length kept, so positions stay comparable. */
function blank(text: string, pattern: RegExp): string {
  return text.replace(pattern, found => ' '.repeat(found.length))
}

/**
 * The issues a prompt mentions, in the order it mentions them, each once: `#42`, `name#7`, `owner/name#7`,
 * `host/owner/name#7` and issue URLs. Code fences, code spans, other URLs, quoted lines (`> …`) and the data blocks
 * a brief or a context block carries (`<issue-text>` and its kin) are not read (C-E2-3): they quote others.
 */
export function findMentions(text: string): Mention[] {
  let plain = blank(blank(blank(blank(text, BLOCKS), FENCES), SPANS), QUOTED_LINES)
  const found: Array<Mention & { at: number }> = []
  for (const url of plain.matchAll(ISSUE_URL)) found.push({ repo: `${url[1] ?? ''}/${url[2] ?? ''}/${url[3] ?? ''}`, number: Number(url[4]), at: url.index ?? 0 })
  plain = blank(plain, ANY_URL)
  for (const ref of plain.matchAll(REF)) found.push({ repo: ref[1] ?? null, number: Number(ref[2]), at: ref.index ?? 0 })
  const seen = new Set<string>()

  return found
    .sort((a, b) => a.at - b.at)
    .filter(mention => {
      const key = `${(mention.repo ?? '').toLowerCase()}#${mention.number}`
      if (mention.number <= 0 || seen.has(key)) return false
      seen.add(key)

      return true
    })
    .map(({ repo, number }) => ({ repo, number }))
}

/**
 * The open issues the mentions name, each once, in mention order: a bare `#n` names the checkout's repository; a
 * repository spec must name one known repository (a bare name that names several names none); the number must be a
 * listed open issue. Closed issues, issues beyond the cap, pull requests and other repositories resolve to nothing.
 */
export function resolveMentions(mentions: readonly Mention[], known: readonly KnownIssue[]): KnownIssue[] {
  const chosen: KnownIssue[] = []
  const seen = new Set<string>()
  for (const mention of mentions) {
    const pool = mention.repo === null ? known.filter(issue => issue.isCheckout) : ofRepo(known, mention.repo)
    const issue = pool.find(found => found.row.number === mention.number)
    if (issue === undefined) continue
    const key = `${issue.sectionKey}#${issue.row.number}`
    if (seen.has(key)) continue
    seen.add(key)
    chosen.push(issue)
  }

  return chosen
}

const BRIEF_LINE = new RegExp(`${MARKER} ((?:[\\w.-]+\\/){1,2}[\\w.-]+)#(\\d+)`)

/** The row key of the issue a hand-off brief is about, wherever its marker line stands in the text (C-E2-3); null for none. */
export function briefIssueKey(text: string): string | null {
  const found = BRIEF_LINE.exec(text)
  if (found === null) return null
  const spec = found[1] ?? ''

  return `${spec.split('/').length === 2 ? `github.com/${spec}` : spec}#${found[2] ?? ''}`.toLowerCase()
}

/**
 * Whether the conversation carries the issue as it stands: attached within the last `within` user turns and not
 * changed since. A turn count that went back (a /clear the record missed) or failed (`turnsNow` below 0) says no.
 */
export function isRecentlyAttached(record: Attached | undefined, rowUpdatedAt: string, turnsNow: number, within: number): boolean {
  if (record === undefined || turnsNow < 0 || turnsNow < record.turn || turnsNow - record.turn >= within) return false

  return record.updatedAt === null || record.updatedAt >= rowUpdatedAt
}

/** The record with these issues attached now, at most `keep` entries (the oldest go); another conversation's entries are dropped. */
export function withAttached(record: AttachedRecord, conversation: string, entries: ReadonlyArray<{ rowKey: string; updatedAt: string | null }>, turn: number, via: Attached['via'], keep: number): AttachedRecord {
  const kept: Record<string, Attached> = record.conversation === conversation ? { ...record.entries } : {}
  for (const entry of entries) {
    delete kept[entry.rowKey]
    kept[entry.rowKey] = { turn, updatedAt: entry.updatedAt, via }
  }
  const keys = Object.keys(kept)

  return { conversation, entries: keys.length > keep ? Object.fromEntries(keys.slice(-keep).map(key => [key, kept[key] as Attached])) : kept }
}

/** The section key a git remote names (`https://host/owner/name(.git)`, `git@host:owner/name.git`, `ssh://…`); null for none. */
export function keyOfRemote(remote: string): string | null {
  const found = /^(?:[a-z][a-z+.-]*:\/\/)?(?:[^@/\s]+@)?([\w.-]+)(?::\d+)?[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(remote.trim())
  if (found === null) return null

  return `${found[1] ?? ''}/${found[2] ?? ''}/${found[3] ?? ''}`.toLowerCase()
}

/** The repository an issue's URL names, for a row the store kept (E2's fallback in a session without sections). */
export function infoFromIssueUrl(url: string): RepoRef | null {
  const found = repoOfUrl(url)
  if (found === null) return null
  const [owner, name] = found.repo.split('/')

  return owner === undefined || name === undefined ? null : { host: found.host, owner, name }
}
