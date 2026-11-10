import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  FlagIcon,
  Loader2Icon,
  MicIcon,
  PlayIcon,
  RotateCcwIcon,
  Settings2Icon,
  XIcon,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Link } from 'wouter'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { api, errorMessage, sideName, type List, type Side, type Word } from '@/lib/api'
import { Mic } from '@/lib/audio'
import { player } from '@/lib/player'
import { hasAudio, loadSession, sidesFor, textOf } from '@/lib/words'

interface Step {
  wordId: number
  side: Side
}

interface Settings {
  auto: boolean
  silenceMs: number
  sensitivity: number
  onlyMissing: boolean
}

const SETTINGS_KEY = 'boice:recording'

function loadSettings(): Settings {
  const defaults: Settings = { auto: true, silenceMs: 900, sensitivity: 0.5, onlyMissing: true }
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') }
  } catch {
    return defaults
  }
}

type Result = 'saving' | 'saved' | 'failed'

export default function Record({ listId }: { listId: number }) {
  const [list, setList] = useState<List | null>(null)
  const [words, setWords] = useState<Map<number, Word>>(new Map())
  const [order, setOrder] = useState<number[]>([])
  const [reversed, setReversed] = useState(false)
  const [settings, setSettings] = useState(loadSettings)
  const [phase, setPhase] = useState<'setup' | 'starting' | 'running' | 'done'>('setup')
  const [steps, setSteps] = useState<Step[]>([])
  const [index, setIndex] = useState(0)
  const [rearm, setRearm] = useState(0)
  const [status, setStatus] = useState<'listening' | 'speaking' | 'paused'>('listening')
  const [results, setResults] = useState<Map<number, Result>>(new Map())
  const [lastTake, setLastTake] = useState<{ step: number; url: string } | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const micRef = useRef<Mic | null>(null)
  const meterRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.list(listId).then(
      ({ list, words }) => {
        const session = loadSession(listId)
        const byId = new Map(words.map((w) => [w.id, w]))
        setList(list)
        setWords(byId)
        setReversed(session?.reversed ?? false)
        setOrder(session ? session.ids.filter((id) => byId.has(id)) : words.map((w) => w.id))
      },
      (e) => toast.error(errorMessage(e)),
    )
  }, [listId])

  useEffect(() => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)), [settings])
  useEffect(() => () => micRef.current?.close(), [])

  // Keep the screen awake while recording.
  useEffect(() => {
    if (phase !== 'running' || !('wakeLock' in navigator)) return
    let lock: WakeLockSentinel | undefined
    navigator.wakeLock.request('screen').then((l) => (lock = l), () => {})
    return () => void lock?.release()
  }, [phase])

  const planned = useMemo(() => {
    if (!list) return { all: [] as Step[], missing: [] as Step[] }
    const sides = sidesFor(list.recordMode, reversed)
    const all = order.flatMap((wordId) => sides.map((side) => ({ wordId, side })))
    return { all, missing: all.filter((s) => !hasAudio(words.get(s.wordId)!, s.side)) }
    // Only recompute when the session changes, not after every saved take.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, order, reversed, phase === 'setup'])

  const start = async (which: Step[]) => {
    setPhase('starting')
    try {
      micRef.current ??= await Mic.open()
      micRef.current.onLevel = () => {
        const el = meterRef.current
        if (!el) return
        el.style.transform = `scaleX(${micRef.current!.level})`
        el.dataset.voiced = String(micRef.current!.voiced)
      }
      setSteps(which)
      setIndex(0)
      setResults(new Map())
      setLastTake(null)
      setPhase('running')
    } catch (e) {
      toast.error(errorMessage(e))
      setPhase('setup')
    }
  }

  const step = steps[index]
  const word = step ? words.get(step.wordId) : undefined

  const save = useCallback(
    (at: number, samples: Float32Array) => {
      const mic = micRef.current
      const s = steps[at]
      if (!mic || !s) return
      const blob = mic.encode(samples)
      setResults((r) => new Map(r).set(at, 'saving'))
      setLastTake((old) => {
        if (old) URL.revokeObjectURL(old.url)
        return { step: at, url: URL.createObjectURL(blob) }
      })
      api.putAudio(s.wordId, s.side, blob).then(
        (w) => {
          setWords((m) => new Map(m).set(w.id, w))
          setResults((r) => new Map(r).set(at, 'saved'))
        },
        (e) => {
          setResults((r) => new Map(r).set(at, 'failed'))
          toast.error(`That take wasn’t saved. ${errorMessage(e)}`)
        },
      )
    },
    [steps],
  )

  const goTo = useCallback(
    (i: number) => {
      if (i >= steps.length) {
        micRef.current?.disarm()
        setPhase('done')
      } else {
        setIndex(Math.max(0, i))
        setRearm((n) => n + 1)
      }
    },
    [steps.length],
  )

  // Arm the microphone for the current step.
  useEffect(() => {
    const mic = micRef.current
    if (phase !== 'running' || !mic || showSettings) return
    setStatus('listening')
    mic.arm({
      auto: settings.auto,
      silenceMs: settings.silenceMs,
      sensitivity: settings.sensitivity,
      onSpeechStart: () => setStatus('speaking'),
      onTake: (samples) => {
        save(index, samples)
        goTo(index + 1)
      },
    })
    return () => mic.disarm()
  }, [phase, index, rearm, settings, showSettings, save, goTo])

  const next = useCallback(() => {
    const samples = micRef.current?.finish()
    if (samples) save(index, samples)
    goTo(index + 1)
  }, [index, save, goTo])

  const redo = useCallback(() => {
    // Mid-word: start this word over. Otherwise: go back to the one just said.
    if (micRef.current?.speaking || index === 0) setRearm((n) => n + 1)
    else goTo(index - 1)
  }, [index, goTo])

  const listen = useCallback(async () => {
    if (!lastTake) return
    micRef.current?.disarm() // don't record our own playback
    setStatus('paused')
    await player.play(lastTake.url)
    setRearm((n) => n + 1)
  }, [lastTake])

  const flag = useCallback(() => {
    if (!word) return
    api.updateWord(word.id, { flagged: !word.flagged }).then(
      (w) => setWords((m) => new Map(m).set(w.id, w)),
      (e) => toast.error(errorMessage(e)),
    )
  }, [word])

  useEffect(() => {
    if (phase !== 'running' || showSettings) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const action = {
        ' ': next,
        Enter: next,
        ArrowRight: next,
        ArrowLeft: () => goTo(index - 1),
        Backspace: redo,
        r: redo,
        p: listen,
        f: flag,
      }[e.key.length === 1 ? e.key.toLowerCase() : e.key]
      if (!action) return
      e.preventDefault()
      ;(document.activeElement as HTMLElement | null)?.blur()
      void action()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, showSettings, index, next, redo, listen, flag, goTo])

  if (!list) return null
  const back = `/l/${listId}`
  const savedCount = [...results.values()].filter((r) => r === 'saved').length
  const failedCount = [...results.values()].filter((r) => r === 'failed').length

  const header = (
    <header className="flex h-14 items-center justify-between gap-3">
      <Button variant="ghost" size="icon" asChild>
        <Link href={back} aria-label="Close">
          <XIcon />
        </Link>
      </Button>
      <span className="truncate text-sm text-muted-foreground">{list.name}</span>
      <Button variant="ghost" size="icon" aria-label="Recording settings" onClick={() => setShowSettings(true)}>
        <Settings2Icon />
      </Button>
    </header>
  )

  const settingsDialog = (
    <Dialog open={showSettings} onOpenChange={setShowSettings}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Recording settings</DialogTitle>
          <DialogDescription>Saved on this device.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-6">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="rec-auto" className="grid gap-1">
              Move on by itself
              <span className="font-normal text-muted-foreground">Goes to the next word when you stop talking.</span>
            </Label>
            <Switch id="rec-auto" checked={settings.auto} onCheckedChange={(auto) => setSettings((s) => ({ ...s, auto }))} />
          </div>
          {settings.auto && (
            <div className="grid gap-3">
              <div className="flex justify-between">
                <Label>Wait after you stop talking</Label>
                <span className="text-sm text-muted-foreground tabular-nums">{(settings.silenceMs / 1000).toFixed(1)} s</span>
              </div>
              <Slider
                value={[settings.silenceMs]}
                min={500}
                max={2500}
                step={100}
                onValueChange={([silenceMs]) => setSettings((s) => ({ ...s, silenceMs }))}
              />
            </div>
          )}
          <div className="grid gap-3">
            <Label>Microphone sensitivity</Label>
            <Slider
              value={[settings.sensitivity]}
              min={0}
              max={1}
              step={0.05}
              onValueChange={([sensitivity]) => setSettings((s) => ({ ...s, sensitivity }))}
            />
            <p className="text-sm text-muted-foreground">
              Raise it if your voice isn’t picked up. Lower it if background noise sets it off.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )

  if (phase === 'setup' || phase === 'starting') {
    const which = settings.onlyMissing ? planned.missing : planned.all
    const recordedAlready = planned.all.length - planned.missing.length
    return (
      <div className="mx-auto flex min-h-dvh max-w-xl flex-col px-4 sm:px-6">
        {header}
        <main className="flex flex-1 flex-col items-center justify-center gap-8 pb-20 text-center">
          <div className="grid size-16 place-items-center rounded-full bg-primary/15 text-primary">
            <MicIcon className="size-7" />
          </div>
          <div className="grid gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {which.length === 0
                ? 'Everything here is recorded'
                : `${which.length} ${which.length === 1 ? 'recording' : 'recordings'} to make`}
            </h1>
            <p className="mx-auto max-w-sm text-balance text-muted-foreground">
              {which.length === 0
                ? 'Turn on “Record again” below to redo these words.'
                : settings.auto
                  ? 'Say each word when it appears. Boice moves on when you stop talking.'
                  : 'Say each word when it appears, then press Space or tap Next.'}
            </p>
          </div>
          {recordedAlready > 0 && (
            <label className="flex items-center gap-3 text-sm">
              <Switch
                checked={!settings.onlyMissing}
                onCheckedChange={(v) => setSettings((s) => ({ ...s, onlyMissing: !v }))}
              />
              Record again the {recordedAlready} already done
            </label>
          )}
          <Button size="lg" className="h-12 px-8 text-base" disabled={which.length === 0 || phase === 'starting'} onClick={() => start(which)}>
            {phase === 'starting' ? <Loader2Icon className="animate-spin" /> : <MicIcon />} Start recording
          </Button>
        </main>
        {settingsDialog}
      </div>
    )
  }

  if (phase === 'done') {
    return (
      <div className="mx-auto flex min-h-dvh max-w-xl flex-col px-4 sm:px-6">
        {header}
        <main className="flex flex-1 flex-col items-center justify-center gap-8 pb-20 text-center">
          <div className="grid size-16 place-items-center rounded-full bg-primary text-primary-foreground">
            <CheckIcon className="size-8" />
          </div>
          <div className="grid gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {savedCount} {savedCount === 1 ? 'recording' : 'recordings'} saved
            </h1>
            {failedCount > 0 && (
              <p className="text-destructive">
                {failedCount} {failedCount === 1 ? 'take wasn’t' : 'takes weren’t'} saved. Record those again.
              </p>
            )}
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <Button size="lg" variant="outline" onClick={() => setPhase('setup')}>
              <RotateCcwIcon /> Record more
            </Button>
            <Button size="lg" asChild>
              <Link href={back}>Back to the list</Link>
            </Button>
          </div>
        </main>
        {settingsDialog}
      </div>
    )
  }

  if (!step || !word) return null
  const otherSide: Side = step.side === 'a' ? 'b' : 'a'
  const lang = step.side === 'a' ? list.langA : list.langB
  const lastWord = lastTake ? words.get(steps[lastTake.step]?.wordId) : undefined
  const lastResult = lastTake ? results.get(lastTake.step) : undefined

  return (
    <div className="mx-auto flex min-h-dvh max-w-2xl flex-col px-4 sm:px-6">
      {header}
      <div className="flex items-center gap-3">
        <Progress value={(index / steps.length) * 100} className="h-1.5" />
        <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
          {index + 1} / {steps.length}
        </span>
      </div>

      <main className="flex flex-1 flex-col items-center justify-center gap-10 py-8">
        <button
          type="button"
          onClick={next}
          className="grid w-full cursor-pointer gap-4 rounded-2xl px-2 py-6 text-center outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          aria-label="Next word"
        >
          <span className="text-xs font-medium tracking-widest text-primary uppercase">{list.kind === 'def' ? `Say the ${sideName(list, step.side).toLowerCase()}` : `Say it in ${sideName(list, step.side)}`}</span>
          <span lang={lang} className="text-4xl leading-tight font-semibold tracking-tight text-balance break-words sm:text-6xl">
            {textOf(word, step.side)}
          </span>
          <span className="text-lg text-muted-foreground text-balance sm:text-xl">
            {textOf(word, otherSide)}
            {word.page > 0 && <span className="ml-3 text-sm">p. {word.page}</span>}
          </span>
        </button>

        <div className="grid w-full max-w-xs gap-3" role="status" aria-live="polite">
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              ref={meterRef}
              className="h-full origin-left rounded-full bg-muted-foreground/60 transition-transform duration-75 data-[voiced=true]:bg-primary"
              style={{ transform: 'scaleX(0)' }}
            />
          </div>
          <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            {status === 'speaking' ? (
              <>
                <span className="size-2 animate-pulse rounded-full bg-destructive" /> Recording
              </>
            ) : status === 'paused' ? (
              'Playing your take'
            ) : (
              <>
                <MicIcon className="size-3.5" /> Listening
              </>
            )}
          </p>
        </div>

        <div className="flex h-8 items-center gap-2 text-sm text-muted-foreground">
          {lastTake && lastWord && (
            <>
              {lastResult === 'failed' ? (
                <span className="text-destructive">Not saved</span>
              ) : lastResult === 'saving' ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <CheckIcon className="size-3.5 text-ok" />
              )}
              <span className="max-w-40 truncate">{textOf(lastWord, steps[lastTake.step].side)}</span>
              <Button size="sm" variant="ghost" onClick={listen}>
                <PlayIcon /> Listen
              </Button>
              <Button size="sm" variant="ghost" onClick={() => goTo(lastTake.step)}>
                <RotateCcwIcon /> Redo
              </Button>
            </>
          )}
        </div>
      </main>

      <footer className="grid gap-4 pb-6">
        <div className="grid grid-cols-[1fr_2fr_1fr] gap-2">
          <Button size="lg" variant="outline" className="h-12" disabled={index === 0} onClick={() => goTo(index - 1)}>
            <ArrowLeftIcon /> Back
          </Button>
          <Button size="lg" className="h-12 text-base" onClick={next}>
            {index + 1 === steps.length ? 'Finish' : 'Next'} <ArrowRightIcon />
          </Button>
          <Button size="lg" variant="outline" className="h-12" aria-pressed={word.flagged} onClick={flag}>
            <FlagIcon className={word.flagged ? 'fill-primary text-primary' : ''} /> Flag
          </Button>
        </div>
        <p className="text-center text-xs text-muted-foreground max-sm:hidden">
          <Key>Space</Key> next · <Key>←</Key> back · <Key>R</Key> redo · <Key>P</Key> listen · <Key>F</Key> flag
        </p>
      </footer>
      {settingsDialog}
    </div>
  )
}

function Key({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border bg-muted px-1.5 py-0.5 font-sans text-[0.7rem] text-foreground">{children}</kbd>
}
