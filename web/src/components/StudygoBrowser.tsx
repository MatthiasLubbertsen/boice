import { ArrowLeftIcon, ChevronRightIcon, EyeIcon, Loader2Icon, SearchIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  api,
  errorMessage,
  langName,
  type BrowseBook,
  type BrowseFilter,
  type BrowseList,
  type BrowsePreview,
} from '@/lib/api'
import { plural } from '@/lib/words'

const ALL = 'all'

type Step =
  | { name: 'books' }
  | { name: 'chapters'; book: BrowseBook; chapters: BrowseFilter[] }
  | { name: 'lists'; book: BrowseBook; chapters: BrowseFilter[]; chapter: BrowseFilter; lists: BrowseList[] }

/**
 * Finds publisher lists the way you'd look them up in the book: subject, level
 * and grade, then book, chapter and paragraph. Needs no Studygo login.
 */
export function StudygoBrowser({
  picked,
  onToggle,
}: {
  picked: Map<number, string>
  onToggle: (list: BrowseList, on: boolean) => void
}) {
  const [step, setStep] = useState<Step>({ name: 'books' })
  const [loading, setLoading] = useState(false)

  // filters
  const [subject, setSubject] = useState(ALL)
  const [level, setLevel] = useState(ALL)
  const [grade, setGrade] = useState(ALL)
  const [text, setText] = useState('')
  const [typed, setTyped] = useState('')
  const [books, setBooks] = useState<BrowseBook[]>([])
  const [total, setTotal] = useState(0)
  const [filters, setFilters] = useState<{ subjects: BrowseFilter[]; levels: BrowseFilter[]; grades: string[] }>({
    subjects: [],
    levels: [],
    grades: [],
  })
  const request = useRef(0)

  useEffect(() => {
    const t = setTimeout(() => setText(typed), 350)
    return () => clearTimeout(t)
  }, [typed])

  const search = async (offset: number) => {
    const mine = ++request.current
    setLoading(true)
    try {
      const res = await api.studygoBooks({
        subject: subject === ALL ? undefined : Number(subject),
        track: level === ALL ? undefined : Number(level),
        grade: grade === ALL ? undefined : Number(grade),
        q: text,
        offset,
      })
      if (mine !== request.current) return
      setBooks((old) => (offset > 0 ? [...old, ...res.books] : res.books))
      setTotal(res.total)
      setFilters({ subjects: res.subjects, levels: res.levels, grades: res.grades })
    } catch (e) {
      if (mine === request.current) toast.error(errorMessage(e))
    } finally {
      if (mine === request.current) setLoading(false)
    }
  }

  useEffect(() => {
    void search(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subject, level, grade, text])

  const openBook = async (book: BrowseBook) => {
    setLoading(true)
    try {
      const { chapters } = await api.studygoBook(book.id)
      setStep({ name: 'chapters', book, chapters })
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }

  const openChapter = async (book: BrowseBook, chapters: BrowseFilter[], chapter: BrowseFilter) => {
    setLoading(true)
    try {
      const { lists } = await api.studygoChapter(chapter.id)
      setStep({ name: 'lists', book, chapters, chapter, lists })
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }

  if (step.name === 'chapters' || step.name === 'lists') {
    const book = step.book
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex items-center gap-2 text-sm">
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              setStep(step.name === 'lists' ? { name: 'chapters', book, chapters: step.chapters } : { name: 'books' })
            }
            disabled={loading}
          >
            <ArrowLeftIcon /> Back
          </Button>
          <span className="min-w-0 truncate text-muted-foreground">
            {book.title}
            {step.name === 'lists' && ` › ${step.chapter.name}`}
          </span>
          {loading && <Loader2Icon className="ml-auto size-4 animate-spin text-primary" />}
        </div>

        {step.name === 'chapters' ? (
          <ChaptersView chapters={step.chapters} onOpen={(c) => openChapter(book, step.chapters, c)} />
        ) : step.lists.length === 0 ? (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            This chapter has no word lists.
          </p>
        ) : (
          <ul className="-mx-2 grid min-h-0 gap-1 overflow-y-auto px-2">
            {step.lists.map((l) => (
              <ListRow key={l.id} list={l} checked={picked.has(l.id)} onToggle={(on) => onToggle(l, on)} />
            ))}
          </ul>
        )}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="grid grid-cols-3 gap-2">
        <FilterSelect label="Subject" value={subject} onChange={setSubject} options={filters.subjects.map((s) => [String(s.id), s.name])} />
        <FilterSelect label="Level" value={level} onChange={setLevel} options={filters.levels.map((s) => [String(s.id), s.name])} />
        <FilterSelect label="Grade" value={grade} onChange={setGrade} options={filters.grades.map((g) => [g, `Grade ${g}`])} />
      </div>
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="Search books, e.g. Na Klar"
          aria-label="Search books"
          className="pl-8"
        />
      </div>
      <ul className="-mx-2 grid min-h-0 gap-1 overflow-y-auto px-2">
        {books.map((b) => (
          <li key={b.id}>
            <button
              type="button"
              onClick={() => void openBook(b)}
              className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{b.title}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {[b.subject, b.publisher, b.grade, b.edition && `${b.edition}e editie`].filter(Boolean).join(' · ')}
                </span>
              </span>
              <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
            </button>
          </li>
        ))}
        {!loading && books.length === 0 && (
          <li className="p-6 text-center text-sm text-muted-foreground">No books match.</li>
        )}
        {books.length > 0 && books.length < total && (
          <li className="flex justify-center py-2">
            <Button size="sm" variant="ghost" disabled={loading} onClick={() => void search(books.length)}>
              Show more ({total - books.length} left)
            </Button>
          </li>
        )}
        {loading && books.length === 0 && (
          <li className="flex justify-center p-6">
            <Loader2Icon className="size-4 animate-spin text-primary" />
          </li>
        )}
      </ul>
    </div>
  )
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: [string, string][]
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className="w-full min-w-0">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{label}: all</SelectItem>
        {options.map(([v, name]) => (
          <SelectItem key={v} value={v}>
            {name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function ChaptersView({ chapters, onOpen }: { chapters: BrowseFilter[]; onOpen: (c: BrowseFilter) => void }) {
  if (chapters.length === 0) {
    return <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">This book has no chapters yet.</p>
  }
  return (
    <ul className="-mx-2 grid min-h-0 gap-1 overflow-y-auto px-2">
      {chapters.map((c) => (
        <li key={c.id}>
          <button
            type="button"
            onClick={() => onOpen(c)}
            className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <span className="min-w-0 flex-1 truncate">{c.name}</span>
            <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
          </button>
        </li>
      ))}
    </ul>
  )
}

export function ListRow({ list, checked, onToggle }: { list: BrowseList; checked: boolean; onToggle: (on: boolean) => void }) {
  const [preview, setPreview] = useState<BrowsePreview | null>(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)

  const toggle = async () => {
    if (open) return setOpen(false)
    setOpen(true)
    if (preview) return
    setLoading(true)
    try {
      setPreview(await api.studygoPreview(list.id))
    } catch (e) {
      toast.error(errorMessage(e))
      setOpen(false)
    } finally {
      setLoading(false)
    }
  }

  return (
    <li className="rounded-lg data-[off=true]:opacity-50" data-off={list.imported}>
      <div className="flex items-center gap-3 px-2 py-2">
        <Checkbox
          checked={list.imported || checked}
          disabled={list.imported}
          onCheckedChange={(v) => onToggle(v === true)}
          aria-label={`Select ${list.title}`}
        />
        <div className="min-w-0 flex-1">
          <span className="block truncate">{list.meta !== undefined ? list.title : list.paragraph || list.title}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {list.meta ?? (list.paragraph && list.title !== list.paragraph ? `${list.title} · ` : '')}
            {list.meta ? ' · ' : ''}
            {list.imported ? 'already imported' : plural(list.words, 'word')}
          </span>
        </div>
        <Button size="sm" variant="ghost" onClick={toggle} aria-expanded={open}>
          {loading ? <Loader2Icon className="animate-spin" /> : <EyeIcon />} Preview
        </Button>
      </div>
      {open && preview && (
        <div className="mx-2 mb-2 rounded-lg border bg-muted/40 p-3 text-sm">
          <p className="mb-2 text-xs text-muted-foreground">
            {preview.kind === 'def' ? 'Terms and definitions' : `${langName(preview.langA)} → ${langName(preview.langB)}`} ·{' '}
            {plural(preview.total, 'word')}
          </p>
          <ul className="grid max-h-56 gap-1 overflow-y-auto pr-1" aria-label="Words in this list">
            {preview.words.map((w, i) => (
              <li key={i} className="grid grid-cols-2 gap-3">
                <span className="truncate">{w.term}</span>
                <span className="truncate text-muted-foreground">{w.translation}</span>
              </li>
            ))}
          </ul>
          {preview.total > preview.words.length && (
            <p className="mt-2 text-xs text-muted-foreground">…and {preview.total - preview.words.length} more</p>
          )}
        </div>
      )}
    </li>
  )
}
