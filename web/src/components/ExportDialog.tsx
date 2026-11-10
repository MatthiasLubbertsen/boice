import { DownloadIcon, Loader2Icon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, errorMessage, langName, type List, type Side, type Word } from '@/lib/api'
import { formatDuration, hasAudio } from '@/lib/words'

type Content = 'a' | 'b' | 'ab' | 'ba'

export function ExportDialog({
  list,
  words,
  reversed,
  open,
  onOpenChange,
}: {
  list: List
  /** The words to export, already filtered and ordered. */
  words: Word[]
  reversed: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const nameA = langName(list.langA)
  const nameB = langName(list.langB)
  const [content, setContent] = useState<Content>(
    list.recordMode === 'both' ? (reversed ? 'ba' : 'ab') : list.recordMode,
  )
  const [gap, setGap] = useState(2)
  const [pairGap, setPairGap] = useState(1)
  const [repeat, setRepeat] = useState(1)
  const [direction, setDirection] = useState<'ab' | 'ba' | 'both'>(reversed ? 'ba' : 'ab')
  const [includeAudio, setIncludeAudio] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const sides = content.split('') as Side[]
  const withAudio = words.filter((w) => sides.some((s) => hasAudio(w, s)))
  const clipMs = withAudio.reduce(
    (ms, w) => ms + sides.reduce((n, s) => n + (s === 'a' ? w.audioA : w.audioB), 0),
    0,
  )
  const totalMs =
    300 + repeat * (clipMs + withAudio.length * (pairGap * 1000 + (sides.length - 1) * gap * 1000))
  const anyAudio = words.some((w) => w.audioA > 0 || w.audioB > 0)

  const run = async (format: 'mp3' | 'csv' | 'anki') => {
    setBusy(format)
    try {
      await api.exportFile(list.id, format, {
        wordIds: words.map((w) => w.id),
        sides,
        gapMs: gap * 1000,
        pairGapMs: pairGap * 1000,
        repeat,
        reversed,
        direction,
        includeAudio,
      })
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const DownloadButton = ({ format, label, disabled }: { format: 'mp3' | 'csv' | 'anki'; label: string; disabled?: boolean }) => (
    <Button className="w-full" size="lg" disabled={busy !== null || disabled} onClick={() => run(format)}>
      {busy === format ? <Loader2Icon className="animate-spin" /> : <DownloadIcon />} {label}
    </Button>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Export</DialogTitle>
          <DialogDescription>
            {words.length} {words.length === 1 ? 'word' : 'words'}, in the order shown in the list.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="mp3" className="gap-5">
          <TabsList className="w-full">
            <TabsTrigger value="mp3">MP3</TabsTrigger>
            <TabsTrigger value="anki">Anki</TabsTrigger>
            <TabsTrigger value="csv">CSV</TabsTrigger>
          </TabsList>

          <TabsContent value="mp3" className="grid gap-5">
            <div className="grid gap-2">
              <Label htmlFor="export-content">What you hear</Label>
              <Select value={content} onValueChange={(v) => setContent(v as Content)}>
                <SelectTrigger id="export-content" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ab">{nameA}, then {nameB}</SelectItem>
                  <SelectItem value="ba">{nameB}, then {nameA}</SelectItem>
                  <SelectItem value="a">{nameA} only</SelectItem>
                  <SelectItem value="b">{nameB} only</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {sides.length > 1 && (
              <div className="grid gap-3">
                <div className="flex justify-between">
                  <Label>Thinking time before the answer</Label>
                  <span className="text-sm text-muted-foreground tabular-nums">{gap.toFixed(1)} s</span>
                </div>
                <Slider value={[gap]} min={0.5} max={6} step={0.5} onValueChange={([v]) => setGap(v)} />
              </div>
            )}
            <div className="grid gap-3">
              <div className="flex justify-between">
                <Label>Pause between words</Label>
                <span className="text-sm text-muted-foreground tabular-nums">{pairGap.toFixed(1)} s</span>
              </div>
              <Slider value={[pairGap]} min={0.5} max={6} step={0.5} onValueChange={([v]) => setPairGap(v)} />
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="export-repeat">Say each word</Label>
              <Select value={String(repeat)} onValueChange={(v) => setRepeat(Number(v))}>
                <SelectTrigger id="export-repeat" className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">Once</SelectItem>
                  <SelectItem value="2">Twice</SelectItem>
                  <SelectItem value="3">3 times</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <p className="text-sm text-muted-foreground">
              {withAudio.length === 0
                ? 'None of these words has a recording in this language yet.'
                : `${withAudio.length} of ${words.length} words have recordings · about ${formatDuration(totalMs)}`}
            </p>
            <DownloadButton format="mp3" label="Download MP3" disabled={withAudio.length === 0} />
          </TabsContent>

          <TabsContent value="anki" className="grid gap-5">
            <div className="grid gap-2">
              <Label htmlFor="export-direction">Cards</Label>
              <Select value={direction} onValueChange={(v) => setDirection(v as typeof direction)}>
                <SelectTrigger id="export-direction" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ab">{nameA} → {nameB}</SelectItem>
                  <SelectItem value="ba">{nameB} → {nameA}</SelectItem>
                  <SelectItem value="both">Both directions</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="export-audio">Include your recordings</Label>
              <Switch id="export-audio" checked={includeAudio && anyAudio} disabled={!anyAudio} onCheckedChange={setIncludeAudio} />
            </div>
            <p className="text-sm text-muted-foreground">
              Open the file in Anki to import the deck. Importing again later updates the same cards.
            </p>
            <DownloadButton format="anki" label="Download Anki deck" />
          </TabsContent>

          <TabsContent value="csv" className="grid gap-5">
            <p className="text-sm text-muted-foreground">
              A spreadsheet with {reversed ? `${nameB}, ${nameA}` : `${nameA}, ${nameB}`}, page and note columns. Opens in
              Excel, Numbers and Google Sheets, and imports into Quizlet.
            </p>
            <DownloadButton format="csv" label="Download CSV" />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
