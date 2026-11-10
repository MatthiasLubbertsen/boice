import { ArrowRightIcon, FlagIcon, PlusIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Link, useLocation } from 'wouter'

import { ListFormDialog } from '@/components/ListForm'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { api, errorMessage, langName, type List } from '@/lib/api'

export default function Lists() {
  const [lists, setLists] = useState<List[] | null>(null)
  const [creating, setCreating] = useState(false)
  const [, navigate] = useLocation()

  useEffect(() => {
    api.lists().then(setLists, (e) => toast.error(errorMessage(e)))
  }, [])

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

      <ul className="grid gap-3 sm:grid-cols-2">
        {lists?.map((l) => (
          <li key={l.id}>
            <Link
              href={`/l/${l.id}`}
              className="group flex h-full flex-col gap-4 rounded-xl border bg-card p-4 transition-colors outline-none hover:border-primary/50 focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate font-medium">{l.name}</h2>
                  <p className="text-sm text-muted-foreground">
                    {langName(l.langA)} → {langName(l.langB)}
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
        initial={{ name: '', langA: 'de', langB: 'nl', recordMode: 'a' }}
        onSubmit={async (fields) => {
          const list = await api.createList(fields)
          navigate(`/l/${list.id}`)
        }}
      />
    </main>
  )
}
