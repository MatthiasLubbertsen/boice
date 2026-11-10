export type Side = 'a' | 'b'
export type RecordMode = 'a' | 'b' | 'both'
/** "lang" = word pairs in two languages, "def" = a term and its definition. */
export type ListKind = 'lang' | 'def'

export interface Issue {
  side: Side | ''
  token: string
  suggestion?: string
}

export interface List {
  id: number
  name: string
  langA: string
  langB: string
  recordMode: RecordMode
  kind: ListKind
  subjectId: number | null
  createdAt: number
  updatedAt: number
  wordCount: number
  recorded: number
  flagged: number
  /** Photos that were read in the background and wait for review. */
  scansReady: number
  scansBusy: number
}

export interface Subject {
  id: number
  name: string
  listCount: number
}

export interface Scan {
  id: number
  listId: number
  status: 'running' | 'done' | 'error'
  page: number
  words: ScannedWord[]
  dictChecked: boolean
  error: string
  createdAt: number
}

export type ListFields = Pick<List, 'name' | 'langA' | 'langB' | 'recordMode' | 'kind' | 'subjectId'>

export interface Word {
  id: number
  listId: number
  pos: number
  term: string
  translation: string
  page: number
  note: string
  flagged: boolean
  issues: Issue[]
  audioA: number
  audioB: number
  updatedAt: number
}

export interface ScannedWord {
  term: string
  translation: string
  issues: Issue[]
}

export interface Me {
  user: { id: string; name: string }
  canLogout: boolean
  scan: boolean
}

export class ApiError extends Error {
  status: number
  login: boolean
  constructor(status: number, message: string, login = false) {
    super(message)
    this.status = status
    this.login = login
  }
}

async function request(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { 'X-Boice': '1' }
  let payload: BodyInit | undefined
  if (body instanceof Blob) {
    payload = body
    headers['Content-Type'] = body.type || 'application/octet-stream'
  } else if (body !== undefined) {
    payload = JSON.stringify(body)
    headers['Content-Type'] = 'application/json'
  }
  let res: Response
  try {
    res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' })
  } catch {
    throw new ApiError(0, "Can't reach the server. Check your connection.")
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`
    let login = false
    try {
      const data = await res.json()
      if (data.error) message = data.error
      login = !!data.login
    } catch {
      /* not JSON */
    }
    if (res.status === 401) window.dispatchEvent(new CustomEvent('boice:signed-out'))
    throw new ApiError(res.status, message, login)
  }
  return res
}

async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await request(method, path, body)
  return res.status === 204 ? (undefined as T) : res.json()
}

export interface ExportOptions {
  wordIds: number[]
  sides?: Side[]
  gapMs?: number
  pairGapMs?: number
  repeat?: number
  reversed?: boolean
  direction?: 'ab' | 'ba' | 'both'
  includeAudio?: boolean
}

export const api = {
  me: () => json<Me>('GET', '/api/me'),
  lists: () => json<List[]>('GET', '/api/lists'),
  createList: (input: ListFields) => json<List>('POST', '/api/lists', input),
  list: (id: number) => json<{ list: List; words: Word[] }>('GET', `/api/lists/${id}`),
  updateList: (id: number, patch: Partial<ListFields>) =>
    json<List>('PATCH', `/api/lists/${id}`, patch),
  deleteList: (id: number) => json<void>('DELETE', `/api/lists/${id}`),
  /** Starts reading a photo in the background and returns at once. */
  startScan: (id: number, image: Blob) => json<Scan>('POST', `/api/lists/${id}/scans`, image),
  scans: (id: number) => json<Scan[]>('GET', `/api/lists/${id}/scans`),
  deleteScan: (id: number) => json<void>('DELETE', `/api/scans/${id}`),
  subjects: () => json<Subject[]>('GET', '/api/subjects'),
  createSubject: (name: string) => json<Subject>('POST', '/api/subjects', { name }),
  renameSubject: (id: number, name: string) => json<Subject>('PATCH', `/api/subjects/${id}`, { name }),
  deleteSubject: (id: number) => json<void>('DELETE', `/api/subjects/${id}`),
  check: (id: number) => json<{ words: Word[] }>('POST', `/api/lists/${id}/check`),
  addWords: (id: number, words: Partial<Word>[]) => json<{ words: Word[] }>('POST', `/api/lists/${id}/words`, { words }),
  deleteWords: (id: number, ids: number[]) => json<void>('POST', `/api/lists/${id}/words/delete`, { ids }),
  updateWord: (id: number, patch: Partial<Pick<Word, 'term' | 'translation' | 'page' | 'note' | 'flagged' | 'issues'>>) =>
    json<Word>('PATCH', `/api/words/${id}`, patch),
  putAudio: (id: number, side: Side, mp3: Blob) => json<Word>('PUT', `/api/words/${id}/audio/${side}`, mp3),
  deleteAudio: (id: number, side: Side) => json<Word>('DELETE', `/api/words/${id}/audio/${side}`),
  audioUrl: (w: Word, side: Side) => `/api/words/${w.id}/audio/${side}?v=${w.updatedAt}`,

  /** Runs an export and hands the file to the browser as a download. */
  async exportFile(id: number, format: 'mp3' | 'csv' | 'anki', options: ExportOptions) {
    const res = await request('POST', `/api/lists/${id}/export/${format}`, options)
    const blob = await res.blob()
    const name = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(res.headers.get('Content-Disposition') ?? '')?.[1]
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = name ? decodeURIComponent(name) : `boice.${format === 'anki' ? 'apkg' : format}`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
  },
}

export const LANGUAGES: Record<string, string> = {
  de: 'German',
  nl: 'Dutch',
  en: 'English',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
  la: 'Latin',
  el: 'Greek',
  sv: 'Swedish',
  da: 'Danish',
  no: 'Norwegian',
  pl: 'Polish',
  tr: 'Turkish',
  fy: 'Frisian',
}

export const langName = (code: string) => LANGUAGES[code] ?? code

/** What a side is called: the language, or Term / Definition for definition lists. */
export const sideName = (list: Pick<List, 'kind' | 'langA' | 'langB'>, side: Side) =>
  list.kind === 'def' ? (side === 'a' ? 'Term' : 'Definition') : langName(side === 'a' ? list.langA : list.langB)

/** Short badge text for a side: "de", "nl" or "term", "def". */
export const sideCode = (list: Pick<List, 'kind' | 'langA' | 'langB'>, side: Side) =>
  list.kind === 'def' ? (side === 'a' ? 'term' : 'def') : side === 'a' ? list.langA : list.langB

/** "German → Dutch" or "Terms & definitions". */
export const listKindLabel = (list: Pick<List, 'kind' | 'langA' | 'langB'>) =>
  list.kind === 'def' ? 'Terms & definitions' : `${langName(list.langA)} → ${langName(list.langB)}`

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.')
