// E20, E21, E8: the start form under a row and what it decides. The choices a
// start takes (mode, place, model, effort, open beside, a note), the owner's
// per-repository guidance, the local git facts the form reads, and whether this
// conversation may be carried into the issue session (E21). Pure: no `$`.
import type { RenderSurface } from 'claude-code'

import type { ForkState, StartChoice, StartEffort, StartModel } from '../types'

/** The longest guidance and note a brief carries (about 250 tokens each). */
export const GUIDANCE_CHARS = 1_000
export const NOTE_CHARS = 1_000

/** Work on it's start: understand first, own worktree, the pane session's model and effort, no note. `beside` follows the setting. */
export const DEFAULT_CHOICE: StartChoice = { mode: 'understand', place: 'worktree', model: 'inherit', effort: 'inherit', beside: false, note: '' }

/** The efforts the desktop names, lowest first (start_session's `effort`). */
export const EFFORTS: readonly Exclude<StartEffort, 'inherit'>[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** How long a main-loop turn counts as running for E21 at most: a lost turn.complete never blocks the fork for good. */
export const TURN_STALE_MS = 30 * 60_000

/**
 * The cheaper models the form offers beside the session's own (start_session takes `same family or cheaper than
 * yours; anything higher is ignored`): none below haiku, haiku below sonnet, both below anything else or an unknown model.
 */
export function modelChoices(current: string): Array<Exclude<StartModel, 'inherit'>> {
  if (/haiku/i.test(current)) return []
  if (/sonnet/i.test(current)) return ['haiku']

  return ['sonnet', 'haiku']
}

/** The efforts at or below the session's own (start_session takes `at or below yours`); all five when it is unknown. */
export function effortChoices(current: string): Array<Exclude<StartEffort, 'inherit'>> {
  const at = EFFORTS.indexOf(current.trim().toLowerCase() as Exclude<StartEffort, 'inherit'>)

  return at < 0 ? [...EFFORTS] : EFFORTS.slice(0, at + 1)
}

/** One of the form's models, or `inherit` for anything else. */
export function asModel(value: string): StartModel {
  return value === 'sonnet' || value === 'haiku' ? value : 'inherit'
}

/** One of the form's efforts, or `inherit` for anything else. */
export function asEffort(value: string): StartEffort {
  return (EFFORTS as readonly string[]).includes(value) ? (value as StartEffort) : 'inherit'
}

/**
 * The text an owner typed, as a brief may carry it: CR LF and CR to LF, every other control character but tab and
 * newline dropped, trailing spaces of each line and three or more blank lines folded, trimmed, cut to `max`.
 */
function cleanText(text: string, max: number): { text: string; isCut: boolean } {
  const folded = text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return folded.length > max ? { text: folded.slice(0, max).trimEnd(), isCut: true } : { text: folded, isCut: false }
}

/** The repository's guidance as stored (E20): cleaned, at most GUIDANCE_CHARS, and whether it was cut. */
export function cleanGuidance(text: string): { text: string; isCut: boolean } {
  return cleanText(text, GUIDANCE_CHARS)
}

/** A start's note: cleaned, at most NOTE_CHARS. */
export function cleanNote(text: string): string {
  return cleanText(text, NOTE_CHARS).text
}

/**
 * Whether a text looks like it holds a secret, which the mod refuses to keep or send with a brief: a GitHub token
 * (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` and 20+ characters; `github_pat_…`), an API key (`sk-…`), a private key block.
 * A heuristic: the owner is told it cannot prove a paragraph is free of secrets.
 */
export function looksSecret(text: string): boolean {
  return /\bgh[pousr]_[A-Za-z0-9_]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bsk-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)
}

/** What `git rev-parse --abbrev-ref HEAD --path-format=absolute --git-dir --git-common-dir` says: the branch and whether the folder is a linked worktree. */
export function parseGitFacts(stdout: string): { branch: string; isWorktree: boolean } {
  const [head = '', gitDir = '', commonDir = ''] = stdout
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.trim())
  if (head === '' || gitDir === '' || commonDir === '') return { branch: '', isWorktree: false }
  const norm = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

  // A detached HEAD reads `HEAD`: no branch to name (B-E20-7).
  return { branch: head === 'HEAD' ? '' : head, isWorktree: norm(gitDir) !== norm(commonDir) }
}

export type ForkInput = {
  surface: RenderSurface
  isIssueSession: boolean
  /** Whether the pane's session runs in a linked worktree of its own (plan section 3). */
  isWorktree: boolean
  /** The owner's prompts so far ($.session.turns). */
  turns: number
  /** The main loop's running turn, if any. */
  running: { since: number } | null
  now: number
}

/**
 * E21: whether the form offers to carry this conversation. Only on the desktop, outside issue sessions, from a
 * session in its own worktree (a fork from a shared checkout cannot be detached and would wake this session after
 * every turn, plan section 3), once the owner wrote at least one prompt; `busy` while a main-loop turn runs (the
 * carried conversation would be cut mid-turn), at most TURN_STALE_MS.
 */
export function forkState(input: ForkInput): ForkState {
  if (input.surface !== 'desktop' || input.isIssueSession || !input.isWorktree || input.turns < 1) return 'none'

  return input.running !== null && input.now - input.running.since < TURN_STALE_MS ? 'busy' : 'ok'
}

/** Whether a start's choice asks for a model or an effort of its own. */
export function asksOptions(choice: Pick<StartChoice, 'model' | 'effort' | 'place'>): boolean {
  return choice.place !== 'fork' && (choice.model !== 'inherit' || choice.effort !== 'inherit')
}

/**
 * B-E20-4: whether the session the app started runs on what the form asked: false when its model does not name the
 * asked alias or its effort differs; true when it does or the app does not say (nothing to tell the owner then).
 */
export function optionsHeld(choice: Pick<StartChoice, 'model' | 'effort'>, got: { model: string | null | undefined; effort: string | null | undefined }): boolean {
  if (choice.model !== 'inherit' && typeof got.model === 'string' && got.model !== '' && !got.model.toLowerCase().includes(choice.model)) return false
  if (choice.effort !== 'inherit' && typeof got.effort === 'string' && got.effort !== '' && got.effort.toLowerCase() !== choice.effort) return false

  return true
}
