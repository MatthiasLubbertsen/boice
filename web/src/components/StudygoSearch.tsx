import { Loader2Icon, SearchIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { ListRow } from '@/components/StudygoBrowser'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, ApiError, errorMessage, type BrowseList, type SearchList } from '@/lib/api'
import { savedToken, saveToken } from '@/lib/studygoToken'
import { plural } from '@/lib/words'

type Kind = 'user' | 'official'

const metaOf = (l: SearchList) =>
  [
    l.creator && `by ${l.creator}`,
    l.subject,
    l.book && `${l.book}${l.chapter ? ` ${l.chapter}` : ''}${l.paragraph && l.paragraph !== '0' ? `.${l.paragraph}` : ''}`,
  ]
    .filter(Boolean)
    .join(' · ')

/**
 * Searches Studygo lists by name, including the ones students made. Only the
 * search itself needs the person's token; previews and imports of what it finds
 * go through the public endpoints.
 */
export function StudygoSearch({ onImported, onDone }: { onImported: () => void; onDone: () => void }) {
  const [token, setToken] = useState(savedToken)
  const [askToken, setAskToken] = useState(() => !savedToken())
  const [kind, setKind] = useState<Kind>('user')
  const [typed, setTyped] = useState('')
  const [q, setQ] = useState('')
  const [lists, setLists] = useState<BrowseList[]>([])
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const [picked, setPicked] = useState<Map<number, string>>(new Map())
  const [importing, setImporting] = useState(false)
  const request = useRef(0)

  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 400)
    return () => clearTimeout(t)
  }, [typed])

  const toBrowse = (l: SearchList): BrowseList => ({
    id: l.id,
    title: l.title,
    paragraph: '',
    words: l.words,
    imported: l.imported,
    listId: l.listId,
    meta: metaOf(l),
  })

  const search = async (offset: number) => {
    const mine = ++request.current
    setLoading(true)
    try {
      const res = await api.studygoSearch(token, q, kind, offset)
      if (mine !== request.current) return
      setLists((old) => (offset > 0 ? [...old, ...res.lists.map(toBrowse)] : res.lists.map(toBrowse)))
      setMore(res.more)
      setSearched(true)
    } catch (e) {
      if (mine !== request.current) return
      toast.error(errorMessage(e))
      if (e instanceof ApiError && e.status === 422) setAskToken(true) // expired or missing token
    } finally {
      if (mine === request.current) setLoading(false)
    }
  }

  useEffect(() => {
    if (askToken) return
    if (!q) {
      request.current++
      setLists([])
      setSearched(false)
      setLoading(false)
      return
    }
    void search(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, kind, askToken])

  const toggle = (l: BrowseList, on: boolean) =>
    setPicked((m) => {
      const next = new Map(m)
      if (on) next.set(l.id, l.title)
      else next.delete(l.id)
      return next
    })

  const run = async () => {
    setImporting(true)
    try {
      // Found lists are public to read, so no token goes along with the import.
      const { results } = await api.studygoImport('', [...picked.keys()])
      const done = results.filter((r) => r.status === 'imported')
      if (done.length > 0) {
        toast.success(
          `Imported ${plural(done.length, 'list')} with ${plural(
            done.reduce((n, r) => n + r.words, 0),
            'word',
          )}.`,
        )
        onImported()
      }
      const failed = results.filter((r) => r.status === 'error')
      for (const f of failed) toast.error(`${f.title || `List ${f.id}`}: ${f.error}`)
      if (failed.length === 0) onDone()
      else {
        setPicked(new Map())
        void search(0)
      }
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setImporting(false)
    }
  }

  if (askToken) {
    return (
      <div className="grid gap-4">
        <p className="text-sm text-muted-foreground">
          Studygo only lets logged-in users search lists, so this needs your token. Previewing and importing what you find
          doesn’t.
        </p>
        <Input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Studygo token (eyJhbGciOi…)"
          aria-label="Studygo token"
        />
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>Log in on studygo.com and open the developer tools (F12), tab “Network”.</li>
          <li>Reload and click any request to <code>api.studygo.com</code>.</li>
          <li>Copy the value of the <code>x-auth-token</code> request header.</li>
        </ol>
        <p className="text-sm text-muted-foreground">
          Used only for your searches, never stored on the server. It stays in this browser. Tokens expire after a few days.
        </p>
        <Button
          disabled={!token.trim()}
          onClick={() => {
            saveToken(token.trim())
            setToken(token.trim())
            setAskToken(false)
          }}
        >
          Continue
        </Button>
      </div>
    )
  }

  return (
    <>
      <div className="grid gap-2">
        <Tabs value={kind} onValueChange={(v) => setKind(v as Kind)}>
          <TabsList className="w-full">
            <TabsTrigger value="user">Students’ lists</TabsTrigger>
            <TabsTrigger value="official">Official lists</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="e.g. frans hoofdstuk 1"
            aria-label="Search lists"
            className="pl-8"
            autoFocus
          />
        </div>
      </div>
      <ul className="-mx-2 grid min-h-0 flex-1 content-start gap-1 overflow-y-auto px-2">
        {lists.map((l) => (
          <ListRow key={l.id} list={l} checked={picked.has(l.id)} onToggle={(on) => toggle(l, on)} />
        ))}
        {loading && (
          <li className="flex justify-center p-4">
            <Loader2Icon className="size-4 animate-spin text-primary" />
          </li>
        )}
        {!loading && !searched && <li className="p-6 text-center text-sm text-muted-foreground">Type a name to search.</li>}
        {!loading && searched && lists.length === 0 && (
          <li className="p-6 text-center text-sm text-muted-foreground">No lists found.</li>
        )}
        {!loading && more && (
          <li className="flex justify-center py-2">
            <Button size="sm" variant="ghost" onClick={() => void search(lists.length)}>
              Show more
            </Button>
          </li>
        )}
      </ul>
      <div className="flex items-center justify-between gap-3 border-t pt-3">
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          {picked.size === 0 ? 'Tick the lists you want.' : `${plural(picked.size, 'list')} selected`}
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              saveToken('')
              setToken('')
              setAskToken(true)
            }}
          >
            Forget token
          </Button>
        </span>
        <Button disabled={picked.size === 0 || importing} onClick={run}>
          {importing && <Loader2Icon className="animate-spin" />} Import {plural(picked.size, 'list')}
        </Button>
      </div>
    </>
  )
}
