export type Side = 'a' | 'b'
export type RecordMode = 'a' | 'b' | 'both'

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
  createdAt: number
  updatedAt: number
  wordCount: number
  recorded: number
  flagged: number
}

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
  createList: (input: Pick<List, 'name' | 'langA' | 'langB' | 'recordMode'>) => json<List>('POST', '/api/lists', input),
  list: (id: number) => json<{ list: List; words: Word[] }>('GET', `/api/lists/${id}`),
  updateList: (id: number, patch: Partial<Pick<List, 'name' | 'langA' | 'langB' | 'recordMode'>>) =>
    json<List>('PATCH', `/api/lists/${id}`, patch),
  deleteList: (id: number) => json<void>('DELETE', `/api/lists/${id}`),
  scan: (id: number, image: Blob) =>
    json<{ page: number; words: ScannedWord[]; dictChecked: boolean }>('POST', `/api/lists/${id}/scan`, image),
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

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.')
