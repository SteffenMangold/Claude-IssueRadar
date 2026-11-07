// E9's triage: what the recap's own model call answers besides the recap (the
// issue's kind, its size, whether it states acceptance criteria, and what is
// missing), read defensively from an answer that should be one JSON object and
// may be prose, a fenced object or a cut one. Pure: no `$`.
import type { IssueLabel, Triage, TriageCriteria, TriageKind, TriageSize } from '../types'

/** The longest gap kept, in characters; a longer one is cut at a word. */
export const GAP_CHARS = 60
/** How many gaps a triage keeps. */
export const GAPS_KEPT = 3

const KINDS: readonly TriageKind[] = ['bug', 'feature', 'question', 'other']
const SIZES: readonly TriageSize[] = ['S', 'M', 'L']
const CRITERIA: readonly TriageCriteria[] = ['stated', 'partial', 'missing']

/** The labels that already say an issue's kind: the kind chip then stays out (a label says it better). */
const LABEL_SAYS: Record<Exclude<TriageKind, 'other'>, RegExp> = {
  bug: /\bbug\b|defect/i,
  feature: /feature|enhancement/i,
  question: /question|support/i,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fold: (text: string) => string): T | null {
  if (typeof value !== 'string') return null
  const said = fold(value.trim())

  return allowed.find(item => item === said) ?? null
}

/** One gap as the pane keeps it: whitespace folded, cut at a word to GAP_CHARS with an ellipsis; empty when nothing is left. */
export function cutGap(text: string): string {
  const plain = text.replace(/\s+/g, ' ').trim()
  if (plain.length <= GAP_CHARS) return plain
  const cut = plain.slice(0, GAP_CHARS - 1)
  const space = cut.lastIndexOf(' ')

  return `${(space > GAP_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/**
 * The triage an answer's object holds, or null when it holds none that the pane can trust: kind and criteria must be
 * one of their words (in any case), a size outside S, M and L reads as unknown, and the gaps are strings only, folded,
 * cut and at most three.
 */
export function asTriage(value: unknown): Triage | null {
  if (!isRecord(value)) return null
  const kind = oneOf(value['kind'], KINDS, text => text.toLowerCase())
  const criteria = oneOf(value['criteria'], CRITERIA, text => text.toLowerCase())
  if (kind === null || criteria === null) return null
  const size = oneOf(value['size'], SIZES, text => text.toUpperCase())
  const given = Array.isArray(value['gaps']) ? (value['gaps'] as unknown[]) : []
  const gaps = given
    .filter((gap): gap is string => typeof gap === 'string')
    .map(cutGap)
    .filter(gap => gap !== '')
    .slice(0, GAPS_KEPT)

  return { kind, size, criteria, gaps }
}

/** The recap a cut object still names: the string after `"recap":`, unescaped; null when there is none to read. */
function salvageRecap(text: string): string | null {
  const found = /"recap"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1]
  if (found === undefined) return null
  try {
    const value = JSON.parse(`"${found}"`) as unknown

    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}

/**
 * The recap and the triage of one answer. The model is asked for one JSON object, and `$.model.complete` has no JSON
 * mode, so the answer is read defensively: a code fence around it is dropped; an object is read from its first `{` to
 * its last `}`; an object cut short gives its recap and no triage; an answer that is no object at all (prose, as V1
 * asked) is the recap itself, with no triage. A broken object without a recap gives an empty recap (the caller's
 * failure).
 */
export function parseRecapAnswer(text: string): { recap: string; triage: Triage | null } {
  const bare = text
    .trim()
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
  const isObject = bare.startsWith('{') || /"recap"\s*:/.test(bare)
  if (!isObject) return { recap: bare, triage: null }
  const open = bare.indexOf('{')
  const close = bare.lastIndexOf('}')
  if (open >= 0 && close > open) {
    try {
      const parsed = JSON.parse(bare.slice(open, close + 1)) as unknown
      if (isRecord(parsed)) {
        const recap = typeof parsed['recap'] === 'string' ? parsed['recap'] : ''

        return { recap, triage: recap.trim() === '' ? null : asTriage(parsed) }
      }
    } catch {
      // Read below, as an object cut short.
    }
  }

  return { recap: salvageRecap(bare) ?? '', triage: null }
}

/** Whether the kind chip stays out: the kind is `other` (never drawn), or a GitHub label already says it. */
export function labelSays(kind: TriageKind, labels: readonly Pick<IssueLabel, 'name'>[]): boolean {
  if (kind === 'other') return true
  const says = LABEL_SAYS[kind]

  return labels.some(label => says.test(label.name))
}
