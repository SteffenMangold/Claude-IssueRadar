// One toast per refresh: what a refresh wants to say is offered here while it
// runs, and the refresh shows the most important offer once, at its end.
// Feedback on a press (a session started, a write's outcome) is not offered:
// it is shown at once by the press itself.

/** How much an offer matters; a higher rank wins the refresh's one toast. */
export const TOAST_RANKS = { arrival: 1, proposal: 2, failure: 3 } as const

export type ToastRank = keyof typeof TOAST_RANKS

export type ToastOffer = { rank: ToastRank; text: string; timeoutMs?: number }

/** The best offer since the last take; module state, so a hot reload drops it with the refresh it belonged to. */
let best: ToastOffer | null = null

/** Offers a toast for the end of the running refresh: it replaces the standing offer only when it ranks higher, so the first of equals wins. */
export function offerToast(rank: ToastRank, text: string, timeoutMs?: number): void {
  if (text.trim() === '') return
  if (best !== null && TOAST_RANKS[best.rank] >= TOAST_RANKS[rank]) return
  best = timeoutMs === undefined ? { rank, text } : { rank, text, timeoutMs }
}

/** Hands over the best offer and clears the collector; null when nothing was offered. */
export function takeToast(): ToastOffer | null {
  const taken = best
  best = null

  return taken
}
