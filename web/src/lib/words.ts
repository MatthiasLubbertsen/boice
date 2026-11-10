import type { RecordMode, Side, Word } from './api'

export type Status = 'all' | 'unrecorded' | 'recorded' | 'flagged' | 'issues'
export type Order = 'list' | 'shuffle' | 'az'

export interface View {
  search: string
  status: Status
  pageFrom: string
  pageTo: string
  order: Order
  seed: number
  /** Swap direction: the translation becomes the prompt. */
  reversed: boolean
}

export const defaultView: View = {
  search: '',
  status: 'all',
  pageFrom: '',
  pageTo: '',
  order: 'list',
  seed: 1,
  reversed: false,
}

export const sidesFor = (mode: RecordMode, reversed = false): Side[] =>
  mode === 'both' ? (reversed ? ['b', 'a'] : ['a', 'b']) : [mode]

export const hasAudio = (w: Word, side: Side) => (side === 'a' ? w.audioA : w.audioB) > 0

export const isRecorded = (w: Word, mode: RecordMode) => sidesFor(mode).every((s) => hasAudio(w, s))

export const textOf = (w: Word, side: Side) => (side === 'a' ? w.term : w.translation)

// Small deterministic hash so a shuffle stays put until you reshuffle.
function mix(id: number, seed: number) {
  let x = (id * 2654435761) ^ (seed * 40503)
  x ^= x >>> 15
  x = Math.imul(x, 2246822519)
  x ^= x >>> 13
  return x >>> 0
}

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

export function applyView(words: Word[], view: View, mode: RecordMode): Word[] {
  const q = fold(view.search.trim())
  const from = parseInt(view.pageFrom) || 0
  const to = parseInt(view.pageTo) || Infinity
  const out = words.filter((w) => {
    if (q && !fold(w.term).includes(q) && !fold(w.translation).includes(q)) return false
    if ((view.pageFrom || view.pageTo) && (w.page < from || w.page > to)) return false
    switch (view.status) {
      case 'unrecorded':
        return !isRecorded(w, mode)
      case 'recorded':
        return isRecorded(w, mode)
      case 'flagged':
        return w.flagged
      case 'issues':
        return w.issues.length > 0
    }
    return true
  })
  if (view.order === 'shuffle') out.sort((x, y) => mix(x.id, view.seed) - mix(y.id, view.seed))
  if (view.order === 'az') {
    const key = (w: Word) => fold(view.reversed ? w.translation : w.term)
    out.sort((x, y) => key(x).localeCompare(key(y)))
  }
  return out
}

/** What the list page hands to the record and practice pages. */
export interface Session {
  ids: number[]
  reversed: boolean
}

const sessionKey = (listId: number) => `boice:session:${listId}`

export function saveSession(listId: number, s: Session) {
  sessionStorage.setItem(sessionKey(listId), JSON.stringify(s))
}

export function loadSession(listId: number): Session | null {
  try {
    const s = JSON.parse(sessionStorage.getItem(sessionKey(listId)) ?? 'null')
    return s && Array.isArray(s.ids) ? s : null
  } catch {
    return null
  }
}

/**
 * Parses pasted text: one pair per line, split by tab, "=", ";", " - " or ",".
 * Separators are tried in that order and only the first match splits the line,
 * so punctuation inside the translation (e.g. "term=a, b; c") is left alone.
 */
export function parsePairs(text: string): { term: string; translation: string }[] {
  const out: { term: string; translation: string }[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const sep = ['\t', '=', ';', ' – ', ' - ', ','].find((s) => line.includes(s))
    if (!sep) continue
    const i = line.indexOf(sep)
    const strip = (s: string) => s.trim().replace(/^"(.*)"$/, '$1').trim()
    const term = strip(line.slice(0, i))
    const translation = strip(line.slice(i + sep.length))
    if (term && translation) out.push({ term, translation })
  }
  return out
}

export function formatDuration(ms: number) {
  const s = Math.round(ms / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
}

/** "1 word", "2 words". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
