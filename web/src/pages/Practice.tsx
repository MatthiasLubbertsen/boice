import { CheckIcon, FlagIcon, RotateCcwIcon, Volume2Icon, XIcon } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Link } from 'wouter'

import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { api, errorMessage, langName, type List, type Side, type Word } from '@/lib/api'
import { player } from '@/lib/player'
import { hasAudio, loadSession, textOf } from '@/lib/words'

/** Flashcards: see (and hear) the prompt, recall the answer, reveal, grade yourself. */
export default function Practice({ listId }: { listId: number }) {
  const [list, setList] = useState<List | null>(null)
  const [words, setWords] = useState<Map<number, Word>>(new Map())
  const [deck, setDeck] = useState<number[]>([])
  const [queue, setQueue] = useState<number[]>([])
  const [revealed, setRevealed] = useState(false)
  const [missed, setMissed] = useState<Set<number>>(new Set())
  const [reversed, setReversed] = useState(false)

  useEffect(() => {
    api.list(listId).then(
      ({ list, words }) => {
        const session = loadSession(listId)
        const byId = new Map(words.map((w) => [w.id, w]))
        const ids = session ? session.ids.filter((id) => byId.has(id)) : words.map((w) => w.id)
        setList(list)
        setWords(byId)
        setReversed(session?.reversed ?? false)
        setDeck(ids)
        setQueue(ids)
      },
      (e) => toast.error(errorMessage(e)),
    )
    return () => player.stop()
  }, [listId])

  const promptSide: Side = reversed ? 'b' : 'a'
  const answerSide: Side = reversed ? 'a' : 'b'
  const word = words.get(queue[0])

  const say = useCallback(
    (w: Word | undefined, side: Side) => {
      if (w && hasAudio(w, side)) void player.play(api.audioUrl(w, side))
    },
    [],
  )

  // Play the prompt when a new card comes up.
  useEffect(() => {
    if (word && !revealed) say(word, promptSide)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [word?.id, queue.length])

  const reveal = useCallback(() => {
    setRevealed(true)
    say(word, answerSide)
  }, [word, answerSide, say])

  const grade = useCallback(
    (knewIt: boolean) => {
      if (!word) return
      player.stop()
      setRevealed(false)
      if (!knewIt) setMissed((m) => new Set(m).add(word.id))
      // A missed card comes back at the end of the round.
      setQueue((q) => (knewIt ? q.slice(1) : [...q.slice(1), q[0]]))
    },
    [word],
  )

  const flag = useCallback(() => {
    if (!word) return
    api.updateWord(word.id, { flagged: !word.flagged }).then(
      (w) => setWords((m) => new Map(m).set(w.id, w)),
      (e) => toast.error(errorMessage(e)),
    )
  }, [word])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || !word) return
      const key = e.key.toLowerCase()
      const action = !revealed
        ? { ' ': reveal, enter: reveal, f: flag }[key]
        : { ' ': () => grade(true), enter: () => grade(true), arrowright: () => grade(true), arrowleft: () => grade(false), f: flag }[key]
      if (!action) return
      e.preventDefault()
      ;(document.activeElement as HTMLElement | null)?.blur()
      action()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [word, revealed, reveal, grade, flag])

  if (!list) return null
  const back = `/l/${listId}`

  const restart = (ids: number[]) => {
    setQueue(ids)
    setMissed(new Set())
    setRevealed(false)
  }

  const flagMissed = async () => {
    try {
      const updated = await Promise.all([...missed].map((id) => api.updateWord(id, { flagged: true })))
      setWords((m) => {
        const next = new Map(m)
        updated.forEach((w) => next.set(w.id, w))
        return next
      })
      toast.success(`Flagged ${updated.length} ${updated.length === 1 ? 'word' : 'words'}.`)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-2xl flex-col px-4 sm:px-6">
      <header className="flex h-14 items-center justify-between gap-3">
        <Button variant="ghost" size="icon" asChild>
          <Link href={back} aria-label="Close">
            <XIcon />
          </Link>
        </Button>
        <span className="truncate text-sm text-muted-foreground">{list.name}</span>
        <span className="w-8" />
      </header>

      {!word ? (
        <main className="flex flex-1 flex-col items-center justify-center gap-8 pb-20 text-center">
          <div className="grid size-16 place-items-center rounded-full bg-primary text-primary-foreground">
            <CheckIcon className="size-8" />
          </div>
          <div className="grid gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {deck.length === 0 ? 'No words to practise' : `${deck.length} ${deck.length === 1 ? 'word' : 'words'} done`}
            </h1>
            {deck.length > 0 && (
              <p className="text-muted-foreground">
                {missed.size === 0
                  ? 'You knew every one first time.'
                  : `${missed.size} needed another try.`}
              </p>
            )}
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            {missed.size > 0 && (
              <>
                <Button size="lg" variant="outline" onClick={() => restart([...missed])}>
                  <RotateCcwIcon /> Practise those {missed.size} again
                </Button>
                <Button size="lg" variant="outline" onClick={flagMissed}>
                  <FlagIcon /> Flag them
                </Button>
              </>
            )}
            {deck.length > 0 && missed.size === 0 && (
              <Button size="lg" variant="outline" onClick={() => restart(deck)}>
                <RotateCcwIcon /> Go again
              </Button>
            )}
            <Button size="lg" asChild>
              <Link href={back}>Back to the list</Link>
            </Button>
          </div>
        </main>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <Progress value={((deck.length - queue.length) / Math.max(deck.length, 1)) * 100} className="h-1.5" />
            <span className="shrink-0 text-sm text-muted-foreground tabular-nums">{queue.length} left</span>
          </div>
          <main className="flex flex-1 flex-col items-center justify-center gap-8 py-8 text-center">
            <div className="grid gap-4">
              <span className="text-xs font-medium tracking-widest text-muted-foreground uppercase">
                {langName(promptSide === 'a' ? list.langA : list.langB)}
              </span>
              <span className="text-4xl leading-tight font-semibold tracking-tight text-balance break-words sm:text-6xl">
                {textOf(word, promptSide)}
              </span>
              {hasAudio(word, promptSide) && (
                <Button variant="ghost" size="sm" className="mx-auto" onClick={() => say(word, promptSide)}>
                  <Volume2Icon /> Hear it
                </Button>
              )}
            </div>
            <div className="grid min-h-28 w-full place-items-center border-t pt-8">
              {revealed ? (
                <div className="grid gap-3">
                  <span className="text-xs font-medium tracking-widest text-primary uppercase">
                    {langName(answerSide === 'a' ? list.langA : list.langB)}
                  </span>
                  <span className="text-3xl font-medium text-balance break-words text-primary sm:text-4xl">
                    {textOf(word, answerSide)}
                  </span>
                  {word.note && <span className="text-sm text-muted-foreground">{word.note}</span>}
                </div>
              ) : (
                <Button size="lg" className="h-12 px-8 text-base" onClick={reveal}>
                  Show answer
                </Button>
              )}
            </div>
          </main>
          <footer className="grid gap-4 pb-6">
            <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
              <Button size="lg" variant="outline" className="h-12" disabled={!revealed} onClick={() => grade(false)}>
                <RotateCcwIcon /> Again
              </Button>
              <Button size="lg" className="h-12 text-base" disabled={!revealed} onClick={() => grade(true)}>
                <CheckIcon /> Got it
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="h-12 w-12"
                aria-label={word.flagged ? 'Remove flag' : 'Flag as difficult'}
                aria-pressed={word.flagged}
                onClick={flag}
              >
                <FlagIcon className={word.flagged ? 'fill-primary text-primary' : ''} />
              </Button>
            </div>
          </footer>
        </>
      )}
    </div>
  )
}
