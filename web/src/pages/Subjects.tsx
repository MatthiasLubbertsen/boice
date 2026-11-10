import { ArrowLeftIcon, CheckIcon, LinkIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Link } from 'wouter'

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
import { Input } from '@/components/ui/input'
import { api, errorMessage, listKindLabel, type List, type Subject } from '@/lib/api'

export default function Subjects() {
  const [subjects, setSubjects] = useState<Subject[] | null>(null)
  const [lists, setLists] = useState<List[]>([])
  const [name, setName] = useState('')
  const [renaming, setRenaming] = useState<Subject | null>(null)
  const [deleting, setDeleting] = useState<Subject | null>(null)
  const [linking, setLinking] = useState<Subject | null>(null)

  const load = () =>
    Promise.all([api.subjects(), api.lists()]).then(
      ([s, l]) => {
        setSubjects(s)
        setLists(l)
      },
      (e) => toast.error(errorMessage(e)),
    )

  useEffect(() => {
    void load()
  }, [])

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    try {
      await api.createSubject(name.trim())
      setName('')
      await load()
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  const unlinked = lists.filter((l) => l.subjectId === null)

  return (
    <main className="flex flex-col gap-6 pt-2">
      <div className="grid gap-3">
        <Link href="/" className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeftIcon className="size-3.5" /> Lists
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Subjects</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Group your lists by school subject: German, History, French… A list can belong to one subject.
        </p>
      </div>

      <form onSubmit={add} className="flex gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New subject, e.g. Geschiedenis"
          aria-label="New subject"
          maxLength={80}
        />
        <Button type="submit" disabled={!name.trim()}>
          <PlusIcon /> Add
        </Button>
      </form>

      {subjects?.length === 0 && (
        <p className="rounded-xl border border-dashed px-6 py-10 text-center text-muted-foreground">
          No subjects yet. Add one above, then link your lists to it.
        </p>
      )}

      <ul className="grid gap-3">
        {subjects?.map((s) => {
          const own = lists.filter((l) => l.subjectId === s.id)
          return (
            <li key={s.id} className="grid gap-3 rounded-xl border bg-card p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="min-w-0 flex-1 truncate font-medium">{s.name}</h2>
                <Button size="sm" variant="outline" onClick={() => setLinking(s)}>
                  <LinkIcon /> Link lists
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label={`Rename ${s.name}`} onClick={() => setRenaming(s)}>
                  <PencilIcon />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label={`Delete ${s.name}`} onClick={() => setDeleting(s)}>
                  <Trash2Icon />
                </Button>
              </div>
              {own.length === 0 ? (
                <p className="text-sm text-muted-foreground">No lists linked yet.</p>
              ) : (
                <ul className="grid gap-1">
                  {own.map((l) => (
                    <li key={l.id}>
                      <Link
                        href={`/l/${l.id}`}
                        className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-muted"
                      >
                        <span className="truncate">{l.name}</span>
                        <span className="shrink-0 text-muted-foreground tabular-nums">
                          {listKindLabel(l)} · {l.recorded}/{l.wordCount}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )
        })}
      </ul>

      {unlinked.length > 0 && subjects && subjects.length > 0 && (
        <p className="text-sm text-muted-foreground">
          {unlinked.length} {unlinked.length === 1 ? 'list has' : 'lists have'} no subject yet.
        </p>
      )}

      <RenameDialog
        subject={renaming}
        onClose={() => setRenaming(null)}
        onSave={async (n) => {
          await api.renameSubject(renaming!.id, n)
          await load()
        }}
      />

      <LinkDialog
        subject={linking}
        lists={lists}
        onClose={() => setLinking(null)}
        onChanged={load}
      />

      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The lists in it stay, they just won’t belong to a subject anymore.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep subject</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => api.deleteSubject(deleting!.id).then(load, (e) => toast.error(errorMessage(e)))}
            >
              Delete subject
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  )
}

function RenameDialog({
  subject,
  onClose,
  onSave,
}: {
  subject: Subject | null
  onClose: () => void
  onSave: (name: string) => Promise<void>
}) {
  const [name, setName] = useState('')
  useEffect(() => setName(subject?.name ?? ''), [subject])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    try {
      await onSave(name.trim())
      onClose()
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  return (
    <Dialog open={subject !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={submit} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>Rename subject</DialogTitle>
          </DialogHeader>
          <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Subject name" maxLength={80} autoFocus />
          <DialogFooter>
            <Button type="submit" disabled={!name.trim()}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Tick the lists that belong to a subject. Each tick saves at once. */
function LinkDialog({
  subject,
  lists,
  onClose,
  onChanged,
}: {
  subject: Subject | null
  lists: List[]
  onClose: () => void
  onChanged: () => Promise<unknown>
}) {
  const [busy, setBusy] = useState<number | null>(null)

  const toggle = async (l: List, on: boolean) => {
    setBusy(l.id)
    try {
      await api.updateList(l.id, { subjectId: on ? subject!.id : null })
      await onChanged()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open={subject !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Lists in {subject?.name}</DialogTitle>
          <DialogDescription>Tick the lists that belong here. A list already in another subject moves over.</DialogDescription>
        </DialogHeader>
        {lists.length === 0 ? (
          <p className="text-sm text-muted-foreground">You have no lists yet.</p>
        ) : (
          <ul className="-mx-2 grid min-h-0 gap-1 overflow-y-auto px-2">
            {lists.map((l) => (
              <li key={l.id}>
                <label className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted">
                  <Checkbox
                    checked={l.subjectId === subject?.id}
                    disabled={busy === l.id}
                    onCheckedChange={(v) => void toggle(l, v === true)}
                  />
                  <span className="min-w-0 flex-1 truncate">{l.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{listKindLabel(l)}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button onClick={onClose}>
            <CheckIcon /> Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
