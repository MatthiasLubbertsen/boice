import {
  ArrowLeftIcon,
  ArrowLeftRightIcon,
  CameraIcon,
  ClipboardPasteIcon,
  DownloadIcon,
  GraduationCapIcon,
  MicIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  ShuffleIcon,
  SpellCheckIcon,
  Trash2Icon,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Link, useLocation } from 'wouter'

import { useMe } from '@/App'
import { ExportDialog } from '@/components/ExportDialog'
import { ListFormDialog } from '@/components/ListForm'
import { ReviewDialog, ScanDialog, ScanTray, useScans } from '@/components/ScanDialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { WordRow, type RowActions } from '@/components/WordRow'
import { api, errorMessage, listKindLabel, sideCode, sideName, type List, type Scan, type Word } from '@/lib/api'
import { applyView, defaultView, isRecorded, parsePairs, plural, saveSession, type Order, type Status, type View } from '@/lib/words'

const STATUS_LABELS: Record<Status, string> = {
  all: 'All words',
  unrecorded: 'Not recorded',
  recorded: 'Recorded',
  flagged: 'Flagged',
  issues: 'To check',
}

export default function ListDetail({ listId }: { listId: number }) {
  const me = useMe()
  const [, navigate] = useLocation()
  const [list, setList] = useState<List | null>(null)
  const [words, setWords] = useState<Word[]>([])
  const [missing, setMissing] = useState(false)
  const [view, setView] = useState<View>(defaultView)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [dialog, setDialog] = useState<'scan' | 'paste' | 'export' | 'settings' | 'delete' | null>(null)
  const [checking, setChecking] = useState(false)
  const { scans, refresh: refreshScans } = useScans(listId)
  const [reviewing, setReviewing] = useState<Scan | null>(null)

  useEffect(() => {
    api.list(listId).then(
      (d) => {
        setList(d.list)
        setWords(d.words)
      },
      (e) => (e.status === 404 ? setMissing(true) : toast.error(errorMessage(e))),
    )
  }, [listId])

  const replaceWord = useCallback((w: Word) => setWords((ws) => ws.map((x) => (x.id === w.id ? w : x))), [])

  const startSession = useCallback(
    (page: 'record' | 'practice', ids: number[], reversed: boolean) => {
      saveSession(listId, { ids, reversed })
      navigate(`/l/${listId}/${page}`)
    },
    [listId, navigate],
  )

  const reversedRef = useRef(view.reversed)
  reversedRef.current = view.reversed

  const actions = useMemo<RowActions>(
    () => ({
      select: (id, on) =>
        setSelected((s) => {
          const next = new Set(s)
          if (on) next.add(id)
          else next.delete(id)
          return next
        }),
      patch: (id, patch) => {
        // Show the change at once; the server's answer then settles it.
        setWords((ws) => ws.map((w) => (w.id === id ? { ...w, ...patch } : w)))
        api.updateWord(id, patch).then(replaceWord, (e) => {
          toast.error(errorMessage(e))
          api.list(listId).then((d) => setWords(d.words), () => {})
        })
      },
      remove: (id) => {
        setWords((ws) => ws.filter((w) => w.id !== id))
        api.deleteWords(listId, [id]).catch((e) => toast.error(errorMessage(e)))
      },
      record: (id) => startSession('record', [id], reversedRef.current),
      clearAudio: (id) => {
        api
          .deleteAudio(id, 'a')
          .then(() => api.deleteAudio(id, 'b'))
          .then(replaceWord, (e) => toast.error(errorMessage(e)))
      },
    }),
    [listId, replaceWord, startSession],
  )

  const visible = useMemo(
    () => (list ? applyView(words, view, list.recordMode) : []),
    [words, view, list],
  )
  const chosen = useMemo(() => visible.filter((w) => selected.has(w.id)), [visible, selected])
  const target = chosen.length > 0 ? chosen : visible

  if (missing) {
    return (
      <main className="grid flex-1 place-items-center text-center">
        <div className="grid gap-4">
          <p className="text-muted-foreground">This list doesn’t exist any more.</p>
          <Button asChild variant="outline">
            <Link href="/">Back to your lists</Link>
          </Button>
        </div>
      </main>
    )
  }
  if (!list) return null

  const recorded = words.filter((w) => isRecorded(w, list.recordMode)).length
  const issueCount = words.filter((w) => w.issues.length > 0).length
  const filtered = view.search || view.status !== 'all' || view.pageFrom || view.pageTo
  const allSelected = visible.length > 0 && chosen.length === visible.length
  const set = (patch: Partial<View>) => setView((v) => ({ ...v, ...patch }))
  const countLabel = target.length === words.length ? '' : ` ${target.length}`

  const runCheck = async () => {
    setChecking(true)
    try {
      const { words: checked } = await api.check(list.id)
      setWords(checked)
      const n = checked.filter((w) => w.issues.length > 0).length
      if (n > 0) {
        toast.warning(`${n} ${n === 1 ? 'word needs' : 'words need'} a look.`)
        set({ status: 'issues' })
      } else toast.success('Every word is in the dictionary.')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setChecking(false)
    }
  }

  const deleteSelected = async () => {
    const ids = chosen.map((w) => w.id)
    setWords((ws) => ws.filter((w) => !selected.has(w.id)))
    setSelected(new Set())
    try {
      await api.deleteWords(list.id, ids)
      toast.success(`Deleted ${plural(ids.length, 'word')}.`)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  return (
    <main className="flex flex-col gap-5 pt-2">
      <div className="grid gap-3">
        <Link href="/" className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeftIcon className="size-3.5" /> Lists
        </Link>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{list.name}</h1>
            <p className="text-sm text-muted-foreground">
              {listKindLabel(list)}
              {words.length > 0 && ` · ${recorded} of ${words.length} recorded`}
            </p>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label="List options">
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setDialog('settings')}>
                <SettingsIcon /> List settings
              </DropdownMenuItem>
              <DropdownMenuItem disabled={checking || words.length === 0} onSelect={runCheck}>
                <SpellCheckIcon /> Check spelling
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setDialog('delete')}>
                <Trash2Icon /> Delete list
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {words.length > 0 && <Progress value={(recorded / words.length) * 100} className="h-1.5" />}
      </div>

      <ScanTray
        scans={scans}
        onReview={setReviewing}
        onDismiss={(sc) => api.deleteScan(sc.id).then(refreshScans, (e) => toast.error(errorMessage(e)))}
      />

      {words.length === 0 ? (
        <div className="flex flex-col items-center gap-5 rounded-xl border border-dashed px-6 py-14 text-center">
          <p className="max-w-sm text-balance text-muted-foreground">
            {me.scan
              ? 'Start by photographing the vocab table in your book. You can fix anything it reads wrong.'
              : 'Add your words by typing them below or pasting a list.'}
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {me.scan && (
              <Button size="lg" onClick={() => setDialog('scan')}>
                <CameraIcon /> Scan a photo
              </Button>
            )}
            <Button size="lg" variant="outline" onClick={() => setDialog('paste')}>
              <ClipboardPasteIcon /> Paste a list
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="lg" disabled={target.length === 0} onClick={() => startSession('record', target.map((w) => w.id), view.reversed)}>
              <MicIcon /> Record{countLabel}
            </Button>
            <Button size="lg" variant="outline" disabled={target.length === 0} onClick={() => startSession('practice', target.map((w) => w.id), view.reversed)}>
              <GraduationCapIcon /> Practice
            </Button>
            <Button size="lg" variant="outline" disabled={target.length === 0} onClick={() => setDialog('export')}>
              <DownloadIcon /> Export
            </Button>
            <div className="ml-auto flex gap-2">
              {me.scan && (
                <Button size="lg" variant="ghost" onClick={() => setDialog('scan')}>
                  <CameraIcon /> Scan
                </Button>
              )}
              <Button size="lg" variant="ghost" onClick={() => setDialog('paste')}>
                <ClipboardPasteIcon /> Paste
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-40 flex-1">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                value={view.search}
                onChange={(e) => set({ search: e.target.value })}
                placeholder="Search"
                aria-label="Search words"
                className="pl-8"
              />
            </div>
            <Select value={view.status} onValueChange={(v) => set({ status: v as Status })}>
              <SelectTrigger aria-label="Filter" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(STATUS_LABELS) as Status[]).map((s) => (
                  <SelectItem key={s} value={s}>
                    {STATUS_LABELS[s]}
                    {s === 'issues' && issueCount > 0 && ` (${issueCount})`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
              <span>Pages</span>
              <Input
                value={view.pageFrom}
                onChange={(e) => set({ pageFrom: e.target.value.replace(/\D/g, '') })}
                inputMode="numeric"
                aria-label="From page"
                placeholder="from"
                className="w-14 text-center"
              />
              <span>–</span>
              <Input
                value={view.pageTo}
                onChange={(e) => set({ pageTo: e.target.value.replace(/\D/g, '') })}
                inputMode="numeric"
                aria-label="To page"
                placeholder="to"
                className="w-14 text-center"
              />
            </div>
            <Select value={view.order} onValueChange={(v) => set({ order: v as Order, seed: Date.now() % 100000 })}>
              <SelectTrigger aria-label="Order" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="list">Book order</SelectItem>
                <SelectItem value="shuffle">Shuffled</SelectItem>
                <SelectItem value="az">A → Z</SelectItem>
              </SelectContent>
            </Select>
            {view.order === 'shuffle' && (
              <Button variant="outline" size="icon" aria-label="Shuffle again" onClick={() => set({ seed: view.seed + 1 })}>
                <ShuffleIcon />
              </Button>
            )}
            <Button
              variant="outline"
              aria-pressed={view.reversed}
              aria-label="Swap direction"
              onClick={() => set({ reversed: !view.reversed })}
              className="uppercase tabular-nums aria-pressed:border-primary/60 aria-pressed:text-primary"
            >
              {sideCode(list, view.reversed ? 'b' : 'a')}
              <ArrowLeftRightIcon />
              {sideCode(list, view.reversed ? 'a' : 'b')}
            </Button>
          </div>

          <div className="grid gap-1">
            <div className="flex h-8 items-center gap-3 text-sm text-muted-foreground">
              <Checkbox
                className="mx-1"
                checked={allSelected ? true : chosen.length > 0 ? 'indeterminate' : false}
                onCheckedChange={(v) => setSelected(v === true ? new Set(visible.map((w) => w.id)) : new Set())}
                aria-label="Select all shown words"
              />
              {chosen.length > 0 ? (
                <>
                  <span className="text-foreground">{chosen.length} selected</span>
                  <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                    Clear
                  </Button>
                  <Button size="sm" variant="destructive" onClick={deleteSelected}>
                    <Trash2Icon /> Delete
                  </Button>
                </>
              ) : (
                <span>
                  {filtered ? `${visible.length} of ${plural(words.length, 'word')}` : plural(words.length, 'word')}
                  {view.reversed && ` · practising ${sideName(list, 'b')} → ${sideName(list, 'a')}`}
                </span>
              )}
            </div>
            {visible.length === 0 ? (
              <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-10 text-sm text-muted-foreground">
                No words match these filters.
                <Button variant="outline" size="sm" onClick={() => setView({ ...defaultView, reversed: view.reversed })}>
                  Clear filters
                </Button>
              </div>
            ) : (
              <ul className="rounded-xl border bg-card px-2">
                {visible.map((w) => (
                  <WordRow key={w.id} word={w} list={list} selected={selected.has(w.id)} actions={actions} />
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      <AddWordForm list={list} lastPage={words.at(-1)?.page ?? 0} onAdded={(ws) => setWords((old) => [...old, ...ws])} />

      {me.scan && (
        <>
          <ScanDialog
            list={list}
            open={dialog === 'scan'}
            onOpenChange={(o) => setDialog(o ? 'scan' : null)}
            onStarted={() => void refreshScans()}
          />
          <ReviewDialog
            list={list}
            existing={words}
            scan={reviewing}
            onClose={() => setReviewing(null)}
            onAdded={(ws) => {
              setWords((old) => [...old, ...ws])
              setReviewing(null)
              void refreshScans()
            }}
          />
        </>
      )}
      <PasteDialog
        list={list}
        open={dialog === 'paste'}
        onOpenChange={(o) => setDialog(o ? 'paste' : null)}
        onAdded={(ws) => setWords((old) => [...old, ...ws])}
      />
      {dialog === 'export' && (
        <ExportDialog list={list} words={target} reversed={view.reversed} open onOpenChange={() => setDialog(null)} />
      )}
      <ListFormDialog
        open={dialog === 'settings'}
        onOpenChange={(o) => setDialog(o ? 'settings' : null)}
        title="List settings"
        submitLabel="Save"
        initial={list}
        onSubmit={async (fields) => setList(await api.updateList(list.id, fields))}
      />
      <AlertDialog open={dialog === 'delete'} onOpenChange={(o) => setDialog(o ? 'delete' : null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{list.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes {words.length === 1 ? 'its 1 word' : `its ${words.length} words`} and all {words.length === 1 ? 'its recordings' : 'their recordings'}. It can’t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep list</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => api.deleteList(list.id).then(() => navigate('/'), (e) => toast.error(errorMessage(e)))}
            >
              Delete list
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  )
}

function AddWordForm({ list, lastPage, onAdded }: { list: List; lastPage: number; onAdded: (words: Word[]) => void }) {
  const [term, setTerm] = useState('')
  const [translation, setTranslation] = useState('')
  const [page, setPage] = useState<string | null>(null)
  const termInput = useRef<HTMLInputElement>(null)
  const pageValue = page ?? (lastPage ? String(lastPage) : '')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!term.trim() || !translation.trim()) return
    try {
      const { words } = await api.addWords(list.id, [{ term, translation, page: parseInt(pageValue) || 0 }])
      onAdded(words)
      setTerm('')
      setTranslation('')
      termInput.current?.focus()
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <div className="grid min-w-0 flex-1 basis-64 grid-cols-2 gap-2">
        <Input
          ref={termInput}
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder={list.kind === 'def' ? 'Term' : `${sideName(list, 'a')} word`}
          aria-label={`New ${sideName(list, 'a').toLowerCase()}`}
          lang={list.langA}
          maxLength={300}
        />
        <Input
          value={translation}
          onChange={(e) => setTranslation(e.target.value)}
          placeholder={list.kind === 'def' ? 'Definition' : `${sideName(list, 'b')} translation`}
          aria-label={`New ${list.kind === 'def' ? 'definition' : 'translation'}`}
          lang={list.langB}
          maxLength={300}
        />
      </div>
      <Input
        value={pageValue}
        onChange={(e) => setPage(e.target.value.replace(/\D/g, ''))}
        inputMode="numeric"
        placeholder="p."
        aria-label="Page"
        className="w-14 text-center"
      />
      <Button type="submit" variant="outline" disabled={!term.trim() || !translation.trim()}>
        <PlusIcon /> Add word
      </Button>
    </form>
  )
}

function PasteDialog({
  list,
  open,
  onOpenChange,
  onAdded,
}: {
  list: List
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdded: (words: Word[]) => void
}) {
  const [text, setText] = useState('')
  const [page, setPage] = useState('')
  const [busy, setBusy] = useState(false)
  const pairs = useMemo(() => parsePairs(text), [text])

  const save = async () => {
    setBusy(true)
    try {
      const { words } = await api.addWords(
        list.id,
        pairs.map((p) => ({ ...p, page: parseInt(page) || 0 })),
      )
      onAdded(words)
      toast.success(`Added ${plural(words.length, 'word')}.`)
      setText('')
      onOpenChange(false)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Paste a list</DialogTitle>
          <DialogDescription>
            One pair per line: {sideName(list, 'a')} first, then {sideName(list, 'b')}, separated by a tab, “;” or “=”.
            Copying two columns from a spreadsheet works too.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'grüne Augen = groene ogen\ndas Haar = het haar'}
          aria-label="Word pairs"
          className="h-48 font-mono text-sm"
          autoFocus
        />
        <DialogFooter className="items-center sm:justify-between">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Page
            <Input
              value={page}
              onChange={(e) => setPage(e.target.value.replace(/\D/g, ''))}
              inputMode="numeric"
              className="w-16 text-center"
            />
          </label>
          <Button disabled={busy || pairs.length === 0} onClick={save}>
            Add {plural(pairs.length, 'word')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
