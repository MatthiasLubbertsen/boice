import { ArrowRightIcon, FlagIcon, Loader2Icon, PlusIcon, SparklesIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Link, useLocation } from 'wouter'

import { ListFormDialog } from '@/components/ListForm'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { api, errorMessage, listKindLabel, type List, type Subject } from '@/lib/api'

export default function Lists() {
  const [lists, setLists] = useState<List[] | null>(null)
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [filter, setFilter] = useState<'all' | 'none' | number>('all')
  const [creating, setCreating] = useState(false)
  const [, navigate] = useLocation()

  useEffect(() => {
    api.lists().then(setLists, (e) => toast.error(errorMessage(e)))
    api.subjects().then(setSubjects, () => {})
  }, [])

  const shown = lists?.filter((l) => filter === 'all' || (filter === 'none' ? l.subjectId === null : l.subjectId === filter))
  const subjectName = (id: number | null) => subjects.find((s) => s.id === id)?.name

  return (
    <main className="flex flex-col gap-6 pt-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Your lists</h1>
        <Button onClick={() => setCreating(true)}>
          <PlusIcon /> New list
        </Button>
      </div>

      {lists?.length === 0 && (
        <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center">
          <p className="max-w-sm text-balance text-muted-foreground">
            Make a list, photograph the vocab table in your book, then say each word out loud. Boice turns your
            recordings into one MP3 you can listen to.
          </p>
          <Button onClick={() => setCreating(true)}>
            <PlusIcon /> Create your first list
          </Button>
        </div>
      )}

      {subjects.length > 0 && (lists?.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by subject">
          {([['all', 'All'], ...subjects.map((s) => [s.id, s.name] as const), ['none', 'No subject']] as const).map(([key, label]) => (
            <Button
              key={key}
              size="sm"
              variant="outline"
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
              className="aria-pressed:border-primary/60 aria-pressed:text-primary"
            >
              {label}
            </Button>
          ))}
        </div>
      )}

      <ul className="grid gap-3 sm:grid-cols-2">
        {shown?.map((l) => (
          <li key={l.id}>
            <Link
              href={`/l/${l.id}`}
              className="group flex h-full flex-col gap-4 rounded-xl border bg-card p-4 transition-colors outline-none hover:border-primary/50 focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate font-medium">{l.name}</h2>
                  <p className="text-sm text-muted-foreground">
                    {subjectName(l.subjectId) && `${subjectName(l.subjectId)} · `}
                    {listKindLabel(l)}
                  </p>
                </div>
                <ArrowRightIcon className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
              </div>
              <div className="mt-auto grid gap-2">
                <Progress value={l.wordCount ? (l.recorded / l.wordCount) * 100 : 0} className="h-1.5" />
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span className="tabular-nums">
                    {l.wordCount === 0 ? 'No words yet' : `${l.recorded} of ${l.wordCount} recorded`}
                  </span>
                  {l.scansBusy > 0 ? (
                    <span className="flex items-center gap-1">
                      <Loader2Icon className="size-3.5 animate-spin text-primary" /> reading photo
                    </span>
                  ) : l.scansReady > 0 ? (
                    <span className="flex items-center gap-1 text-primary">
                      <SparklesIcon className="size-3.5" /> {l.scansReady} to review
                    </span>
                  ) : null}
                  {l.flagged > 0 && (
                    <span className="flex items-center gap-1 tabular-nums">
                      <FlagIcon className="size-3.5 text-primary" /> {l.flagged}
                    </span>
                  )}
                </div>
              </div>
            </Link>
          </li>
        ))}
      </ul>

      <ListFormDialog
        open={creating}
        onOpenChange={setCreating}
        title="New list"
        submitLabel="Create list"
        initial={{ name: '', langA: 'de', langB: 'nl', recordMode: 'a', kind: 'lang', subjectId: typeof filter === 'number' ? filter : null }}
        onSubmit={async (fields) => {
          const list = await api.createList(fields)
          navigate(`/l/${list.id}`)
        }}
      />
    </main>
  )
}
