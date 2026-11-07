// Batch 7, the one confirmed write path (F0) and what E19, E16 and E15 write
// through it: the exact gh command each write runs, how it is shown, what a card
// warns about, and how gh's answer is read. Nothing here runs anything: a write
// runs only from the pane's confirm press (register.tsx confirmWrite), through
// ghRaw. Pure: no `$`.
import type { CloseReason, IssueRow, RepoInfo, RepoStateKind } from '../types'
import { classify, isRecord, nodesOf, parseJson } from './github'
import type { ShownPr } from './prs'
import { clean } from './text'

/** A confirm sooner than this after Review is ignored: a double click on Review never confirms. */
export const CONFIRM_ARM_MS = 600
/** A card nobody confirmed for this long expires; its command is reviewed again. */
export const CONFIRM_TTL_MS = 10 * 60_000
/** How long the outcome line stays under its row. */
export const OUTCOME_MS = 120_000
/** How long a write may run; a link fetches as well, so it gets longer. */
export const WRITE_TIMEOUT_MS = 60_000
export const DEVELOP_TIMEOUT_MS = 90_000
/**
 * The longest comment and new-issue body: the card shows what it sends in full, and a pane tree draws its first 100,000
 * characters only, a Button that would not be drawn whole is left out (X-3): 20,000 keeps Confirm drawn in a full pane.
 */
export const COMMENT_MAX = 20_000
export const BODY_MAX = 20_000
/** gh posts a closing comment as part of the close; a longer text goes as a comment first. */
export const CLOSE_COMMENT_MAX = 2_000
/** GitHub's longest issue title. */
export const TITLE_MAX = 256
/** How long a write's effect is laid over the lists, which come from a search index that lags behind writes (X-6). */
export const OVERLAY_MS = 3 * 60_000
/** E19-2: GitHub closes an issue itself when its pull request merges into the default branch; it gets this long first. */
export const CLOSEOUT_QUIET_MS = 5 * 60_000
/** The labels a repository's list reads at most. */
export const LABELS_MAX = 100

/** A word a shell reads as it stands: letters, digits and `_ + = : . / -` (never `@`, `#`, `$` or `,`). */
const BARE = /^[A-Za-z0-9_+=:./-]+$/

/** One argument as the card shows it: bare when it may be, else single-quoted with an inner quote doubled (PowerShell's rule). */
export function shellWord(arg: string): string {
  return arg !== '' && BARE.test(arg) ? arg : `'${arg.replace(/'/g, "''")}'`
}

/** The command line the card shows: every argument as `shellWord` writes it, cleaned, since a Code refuses control characters. */
export function displayCommand(argv: readonly string[]): string {
  return clean(argv.map(shellWord).join(' '))
}

/** A label name as gh's comma-separated flags take it: in double quotes (inner ones doubled) when it holds a comma or a quote. */
export function csvQuote(name: string): string {
  return /[",]/.test(name) ? `"${name.replace(/"/g, '""')}"` : name
}

/** What a text sent to GitHub may hold: line breaks as LF, no other control character but tab (X-4): what is shown is what is sent. */
export function sanitizeText(text: string): string {
  return clean(text)
}

export type SecretKind = 'github' | 'anthropic' | 'aws' | 'slack' | 'privateKey' | 'jwt' | 'userPath'

const SECRETS: ReadonlyArray<[SecretKind, RegExp]> = [
  ['github', /\bgh[pousr]_[A-Za-z0-9]{36,}|\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ['anthropic', /\bsk-ant-[A-Za-z0-9_-]{10,}/],
  ['aws', /\bAKIA[0-9A-Z]{16}\b/],
  ['slack', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['privateKey', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['userPath', /\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s]+|\/Users\/[^/\s]+\/|\/home\/[^/\s]+\//],
]

/** What in `text` looks like a secret or a local path naming a user: each kind once, in a fixed order. A heuristic, said as such. */
export function scanSecrets(text: string): SecretKind[] {
  return SECRETS.filter(([, pattern]) => pattern.test(text)).map(([kind]) => kind)
}

/** The flags whose value is the owner's text: `debug:lastWrite` keeps only how long it was (plan rule 7). */
const TEXT_FLAGS: ReadonlySet<string> = new Set(['--title', '--body', '--comment', '-t', '-b', '-c'])

/** `argv` with every text value replaced by `<N chars>`. */
export function redactArgv(argv: readonly string[]): string[] {
  return argv.map((arg, index) => (index > 0 && TEXT_FLAGS.has(argv[index - 1] ?? '') ? `<${arg.length} chars>` : arg))
}

/** What a write came to, as gh's exit and words say. */
export type WriteVerdict = { kind: 'ok' | 'already-closed' | 'no-permission' | 'old-gh' | RepoStateKind; detail?: string }

/**
 * gh's answer to a write: exit 0 is done (an issue that was already closed says so, exit 0 still), exit 4 signed out, a
 * refusal for want of rights (REST's 403 and GraphQL's words, E19-3), a flag or command this gh does not know, a
 * secondary rate limit; anything else as a read is classified.
 */
export function classifyWrite(exitCode: number, stderr: string, host: string, repo: string): WriteVerdict {
  const said = stderr.toLowerCase()
  if (exitCode === 0) return said.includes('already closed') ? { kind: 'already-closed' } : { kind: 'ok' }
  if (exitCode === 4) return { kind: 'signed-out' }
  if (/resource not accessible|must have (?:admin|push|write|triage|maintain)|http 403|not authorized|does not have the correct permissions/.test(said)) return { kind: 'no-permission' }
  if (/unknown flag|unknown shorthand flag|unknown command/.test(said)) return { kind: 'old-gh' }
  if (said.includes('secondary rate limit')) return { kind: 'rate-limited' }
  const state = classify(exitCode, stderr, host, repo)

  return state.detail === undefined ? { kind: state.kind } : { kind: state.kind, detail: state.detail }
}

/** The new issue gh printed (`https://host/owner/name/issues/58`); null when it printed none. */
export function parseIssueUrl(stdout: string): { number: number; url: string } | null {
  const found = /https?:\/\/[^\s]+\/issues\/(\d+)/.exec(stdout)
  if (found === null) return null

  return { number: Number(found[1]), url: found[0] }
}

// The commands -----------------------------------------------------------------

/** E19: a comment, its text on standard input (never on the command line). */
export function commentArgv(spec: string, number: number): string[] {
  return ['gh', 'issue', 'comment', String(number), '-R', spec, '--body-file', '-']
}

/** E19: labels added and removed in one edit. */
export function labelsArgv(spec: string, number: number, add: readonly string[], remove: readonly string[]): string[] {
  return ['gh', 'issue', 'edit', String(number), '-R', spec, ...add.flatMap(name => ['--add-label', csvQuote(name)]), ...remove.flatMap(name => ['--remove-label', csvQuote(name)])]
}

/** E19: assigns the signed-in account, or takes it off. */
export function assignArgv(spec: string, number: number, isRemove: boolean): string[] {
  return ['gh', 'issue', 'edit', String(number), '-R', spec, isRemove ? '--remove-assignee' : '--add-assignee', '@me']
}

/** E19: closes with a reason, or as a duplicate of another issue; a closing comment when there is one. */
export function closeArgv(spec: string, number: number, reason: CloseReason, comment: string, duplicateOf: string | null): string[] {
  const why = reason === 'duplicate' && duplicateOf !== null ? ['--duplicate-of', duplicateOf] : ['--reason', reason === 'duplicate' ? 'completed' : reason]

  return ['gh', 'issue', 'close', String(number), '-R', spec, ...why, ...(comment === '' ? [] : ['--comment', comment])]
}

/** E16: a new issue, its body on standard input. */
export function createArgv(spec: string, title: string, labels: readonly string[], assignMe: boolean): string[] {
  return ['gh', 'issue', 'create', '-R', spec, '--title', title, ...labels.flatMap(name => ['--label', csvQuote(name)]), ...(assignMe ? ['--assignee', '@me'] : []), '--body-file', '-']
}

/** E15: links the session's branch to the issue (GitHub creates it at the default branch's tip); never `--checkout`. */
export function developArgv(issueSpec: string, number: number, branch: string, branchRepo: string | null): string[] {
  return ['gh', 'issue', 'develop', String(number), '-R', issueSpec, '--name', branch, ...(branchRepo === null ? [] : ['--branch-repo', branchRepo])]
}

/** The issue `--duplicate-of` names: `17`, `#17` or an issue's URL; null for anything else. */
export function duplicateOf(text: string): string | null {
  const plain = text.trim()
  const number = /^#?(\d+)$/.exec(plain)?.[1]
  if (number !== undefined) return number

  return /^https?:\/\/[^\s]+\/issues\/\d+$/.test(plain) ? plain : null
}

/** E19's close-out comment, GitHub content and so English: `Fixed in #57.`, or `Fixed in owner/name#57.` for another repository. */
export function closeoutComment(issueRepo: string, pr: Pick<ShownPr, 'number' | 'repo'>): string {
  return pr.repo === '' || pr.repo.toLowerCase() === issueRepo.toLowerCase() ? `Fixed in #${pr.number}.` : `Fixed in ${pr.repo}#${pr.number}.`
}

// Who may do what ---------------------------------------------------------------

/** Labels, assignment and close need TRIAGE or more; an unknown role counts as allowed (GitHub decides). */
export function canTriage(info: Pick<RepoInfo, 'permission'> | null | undefined): boolean {
  const role = (info?.permission ?? '').toUpperCase()

  return role === '' || role === 'ADMIN' || role === 'MAINTAIN' || role === 'WRITE' || role === 'TRIAGE'
}

/** A branch link needs WRITE or more on the repository the branch goes to; unknown counts as allowed. */
export function canPush(info: Pick<RepoInfo, 'permission'> | null | undefined): boolean {
  const role = (info?.permission ?? '').toUpperCase()

  return role === '' || role === 'ADMIN' || role === 'MAINTAIN' || role === 'WRITE'
}

// E19's close-out ----------------------------------------------------------------

/**
 * The merged pull request a still open issue could be closed for (E19 part C), or null: none for an issue someone
 * reopened (E19-2: on purpose), none while a pull request merged into the default branch less than five minutes ago
 * (GitHub closes the issue itself; the list lags behind), the session's own first (the links come ranked).
 */
export function closeoutOf(links: readonly ShownPr[], row: Pick<IssueRow, 'stateReason'>, defaultBranch: string, now: number): ShownPr | null {
  if (row.stateReason === 'REOPENED') return null
  for (const pr of links) {
    if (pr.state !== 'MERGED') continue
    const merged = pr.mergedAt === undefined ? Number.NaN : Date.parse(pr.mergedAt)
    if (pr.base === defaultBranch && Number.isFinite(merged) && now - merged < CLOSEOUT_QUIET_MS) continue

    return pr
  }

  return null
}

// E15's branch -----------------------------------------------------------------

/** The branch of `git worktree list --porcelain` whose name holds `slug`: exactly one, else null. */
export function pickWorktreeBranch(porcelain: string, slug: string): string | null {
  if (slug === '') return null
  const names = porcelain
    .split(/\r?\n/)
    .map(line => /^branch refs\/heads\/(.+)$/.exec(line.trim())?.[1])
    .filter((name): name is string => name !== undefined && name.includes(slug))

  return names.length === 1 ? (names[0] ?? null) : null
}

/** A branch name gh and git take as it stands: no space, no control character, no leading dash, nothing git refuses. */
export function isBranchName(name: string): boolean {
  return name !== '' && !name.startsWith('-') && !/[\s~^:?*[\\\u0000-\u001F\u007F]|\.\.|@\{|\/\/|\.lock$|\/$|^\//.test(name)
}

/**
 * The branches linked to an issue, from `IssueRadarLinkedBranches` (X-2): a deleted branch (`ref: null`) is skipped,
 * each named with its repository. Null when the answer holds no issue.
 */
export function readLinkedBranches(data: Readonly<Record<string, unknown>>): Array<{ name: string; repo: string }> | null {
  const repository = data['repository']
  const issue = isRecord(repository) ? repository['issue'] : undefined
  if (!isRecord(issue)) return null
  const found: Array<{ name: string; repo: string }> = []
  for (const node of nodesOf(issue['linkedBranches'])) {
    const ref = isRecord(node) ? node['ref'] : undefined
    if (!isRecord(ref) || typeof ref['name'] !== 'string') continue
    const owner = ref['repository']
    found.push({ name: ref['name'], repo: isRecord(owner) && typeof owner['nameWithOwner'] === 'string' ? owner['nameWithOwner'] : '' })
  }

  return found
}

/** A remote branch's tip as `gh api …/git/ref/heads/<branch> --jq .object.sha` prints it; null for anything but 40 hex digits. */
export function shaOf(stdout: string): string | null {
  const sha = stdout.trim()

  return /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : null
}

/** gh's JSON list of labels as the editors offer them: names, at most LABELS_MAX. */
export function parseLabels(stdout: string): Array<{ name: string; color: string }> | null {
  const json = parseJson(stdout)
  if (!Array.isArray(json)) return null

  return json
    .filter(isRecord)
    .map(label => ({ name: typeof label['name'] === 'string' ? label['name'] : '', color: typeof label['color'] === 'string' ? label['color'] : '' }))
    .filter(label => label.name !== '')
    .slice(0, LABELS_MAX)
}
