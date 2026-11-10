const KEY = 'boice.studygo.token'

/** The Studygo token kept in this browser (never on the server). */
export function savedToken(): string {
  try {
    return localStorage.getItem(KEY) ?? ''
  } catch {
    return ''
  }
}

export function saveToken(token: string) {
  try {
    if (token) localStorage.setItem(KEY, token)
    else localStorage.removeItem(KEY)
  } catch {
    /* private mode: just ask again next time */
  }
}
