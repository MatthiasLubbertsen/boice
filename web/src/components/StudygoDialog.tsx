import { DownloadCloudIcon, Loader2Icon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { StudygoBrowser } from '@/components/StudygoBrowser'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Label } from '@/components/ui/label'
import { api, errorMessage, type BrowseList, type StudygoList, type StudygoResult } from '@/lib/api'
import { plural } from '@/lib/words'

const TOKEN_KEY = 'boice.studygo.token'

function savedToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

function saveToken(token: string) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* private mode: just ask again next time */
  }
}

/** Runs an import and reports the outcome. Returns true when nothing failed. */
async function runImport(token: string, ids: number[], onImported: () => void): Promise<boolean> {
  const { results } = await api.studygoImport(token, ids)
  const done = results.filter((r: StudygoResult) => r.status === 'imported')
  const failed = results.filter((r: StudygoResult) => r.status === 'error')
  if (done.length > 0) {
    toast.success(
      `Imported ${plural(done.length, 'list')} with ${plural(
        done.reduce((n, r) => n + r.words, 0),
        'word',
      )}.`,
    )
    onImported()
  }
  for (const f of failed) toast.error(`${f.title || `List ${f.id}`}: ${f.error}`)
  return failed.length === 0
}

/** Pick lists by subject, book, chapter and paragraph. No Studygo account needed. */
function BrowseTab({ onImported, onDone }: { onImported: () => void; onDone: () => void }) {
  const [picked, setPicked] = useState<Map<number, string>>(new Map())
  const [busy, setBusy] = useState(false)

  const toggle = (l: BrowseList, on: boolean) =>
    setPicked((m) => {
      const next = new Map(m)
      if (on) next.set(l.id, l.title)
      else next.delete(l.id)
      return next
    })

  const run = async () => {
    setBusy(true)
    try {
      if (await runImport('', [...picked.keys()], onImported)) onDone()
      else setPicked(new Map())
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <StudygoBrowser picked={picked} onToggle={toggle} />
      <DialogFooter className="items-center sm:justify-between">
        <span className="text-sm text-muted-foreground">
          {picked.size === 0 ? 'Tick the lists you want.' : `${plural(picked.size, 'list')} selected`}
        </span>
        <Button disabled={picked.size === 0 || busy} onClick={run}>
          {busy && <Loader2Icon className="animate-spin" />} Import {plural(picked.size, 'list')}
        </Button>
      </DialogFooter>
    </>
  )
}

/** Imports word lists from the person's Studygo account using a token from their own browser. */
function AccountTab({ onImported, onDone }: { onImported: () => void; onDone: () => void }) {
  const [token, setToken] = useState(savedToken)
  const [lists, setLists] = useState<StudygoList[] | null>(null)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState<'load' | 'import' | null>(null)

  const load = async () => {
    setBusy('load')
    try {
      const { lists } = await api.studygoLists(token.trim())
      saveToken(token.trim())
      setLists(lists)
      setPicked(new Set())
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const run = async () => {
    setBusy('import')
    try {
      if (await runImport(token.trim(), [...picked], onImported)) onDone()
      else void load()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const fresh = lists?.filter((l) => !l.imported) ?? []
  const toggle = (id: number, on: boolean) =>
    setPicked((s) => {
      const next = new Set(s)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  return (
    <>
        {lists === null ? (
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="studygo-token">Studygo token</Label>
              <Input
                id="studygo-token"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="eyJhbGciOi…"
              />
            </div>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <li>Log in on studygo.com and open the developer tools (F12), tab “Network”.</li>
              <li>Reload the page and click any request to <code>api.studygo.com</code>.</li>
              <li>Under “Request headers”, copy the value of <code>x-auth-token</code>.</li>
            </ol>
            <p className="text-sm text-muted-foreground">
              Boice uses the token only for this import and doesn’t store it on the server. It stays in this browser so
              you don’t have to paste it twice. Tokens expire after a few days.
            </p>
            <DialogFooter className="items-center sm:justify-between">
              {savedToken() ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    saveToken('')
                    setToken('')
                  }}
                >
                  Forget token
                </Button>
              ) : (
                <span />
              )}
              <Button disabled={!token.trim() || busy !== null} onClick={load}>
                {busy === 'load' ? <Loader2Icon className="animate-spin" /> : <DownloadCloudIcon />} Load my lists
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <>
            {lists.length === 0 ? (
              <p className="text-sm text-muted-foreground">No word lists found on that account.</p>
            ) : (
              <>
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>{plural(picked.size, 'list')} selected</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={fresh.length === 0}
                    onClick={() => setPicked(picked.size === fresh.length ? new Set() : new Set(fresh.map((l) => l.id)))}
                  >
                    {picked.size === fresh.length && fresh.length > 0 ? 'Clear' : 'Select all new'}
                  </Button>
                </div>
                <ul className="-mx-2 grid min-h-0 gap-1 overflow-y-auto px-2">
                  {lists.map((l) => (
                    <li key={l.id}>
                      <label className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted data-[off=true]:cursor-default data-[off=true]:opacity-50" data-off={l.imported}>
                        <Checkbox
                          checked={l.imported || picked.has(l.id)}
                          disabled={l.imported}
                          onCheckedChange={(v) => toggle(l.id, v === true)}
                        />
                        <span className="min-w-0 flex-1 truncate">{l.title}</span>
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                          {l.imported ? 'imported' : plural(l.words, 'word')}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <DialogFooter className="items-center sm:justify-between">
              <Button variant="ghost" disabled={busy !== null} onClick={() => setLists(null)}>
                Back
              </Button>
              <Button disabled={picked.size === 0 || busy !== null} onClick={run}>
                {busy === 'import' && <Loader2Icon className="animate-spin" />} Import {plural(picked.size, 'list')}
              </Button>
            </DialogFooter>
          </>
        )}
    </>
  )
}

export function StudygoDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[88dvh] max-h-[40rem] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add from Studygo</DialogTitle>
          <DialogDescription>
            Two languages become a word list; the same language on both sides becomes terms and definitions.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="browse" className="flex min-h-0 flex-1 flex-col gap-3">
          <TabsList className="w-full">
            <TabsTrigger value="browse">Find in a book</TabsTrigger>
            <TabsTrigger value="account">My account</TabsTrigger>
          </TabsList>
          <TabsContent value="browse" className="flex min-h-0 flex-1 flex-col gap-3">
            <BrowseTab onImported={onImported} onDone={() => onOpenChange(false)} />
          </TabsContent>
          <TabsContent value="account" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
            <AccountTab onImported={onImported} onDone={() => onOpenChange(false)} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
