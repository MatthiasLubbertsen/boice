import { AlertCircleIcon, CameraIcon, CheckCircle2Icon, ImagesIcon, Loader2Icon, XIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { IssueNote } from '@/components/IssueNote'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { api, errorMessage, listKindLabel, sideName, type Issue, type List, type Scan, type Word } from '@/lib/api'

interface Row {
  key: number
  term: string
  translation: string
  page: string
  issues: Issue[]
  duplicate: boolean
  include: boolean
}

/** Shrinks a photo before upload: faster on mobile data and cheaper to read. */
async function prepareImage(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    const scale = Math.min(1, 2200 / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88))
    if (blob) return blob
  } catch {
    /* fall through to the original file */
  }
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
    throw new Error(`${file.name} can't be read here. Use a JPEG or PNG photo.`)
  }
  return file
}

let nextKey = 1

/**
 * Takes photos and hands them to the server, which reads them in the
 * background. The dialog closes as soon as the uploads are done, so there is
 * no waiting on the AI.
 */
export function ScanDialog({
  list,
  open,
  onOpenChange,
  onStarted,
}: {
  list: List
  open: boolean
  onOpenChange: (open: boolean) => void
  onStarted: () => void
}) {
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null)
  const cameraInput = useRef<HTMLInputElement>(null)
  const galleryInput = useRef<HTMLInputElement>(null)

  const upload = async (files: FileList | null) => {
    if (!files?.length) return
    const photos = [...files]
    setUploading({ done: 0, total: photos.length })
    let started = 0
    for (const [i, file] of photos.entries()) {
      try {
        await api.startScan(list.id, await prepareImage(file))
        started++
      } catch (e) {
        toast.error(errorMessage(e))
      }
      setUploading({ done: i + 1, total: photos.length })
    }
    setUploading(null)
    if (started > 0) {
      toast.success(
        `${started === 1 ? 'Reading your photo' : `Reading ${started} photos`} in the background. Keep going, the words will be waiting.`,
      )
      onStarted()
      onOpenChange(false)
    }
  }

  const busy = uploading !== null
  const isDef = list.kind === 'def'

  return (
    <Dialog open={open} onOpenChange={(o) => (busy ? undefined : onOpenChange(o))}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isDef ? 'Scan terms and definitions' : 'Scan a vocab table'}</DialogTitle>
          <DialogDescription>
            {isDef
              ? 'Photograph a glossary page: each term with its definition. Rotated photos are fine.'
              : `Photograph the table with ${sideName(list, 'a')} and ${sideName(list, 'b')} side by side. Every word is checked against a dictionary, so reading mistakes stand out.`}{' '}
            The photo is read in the background, so you can carry on while it works.
          </DialogDescription>
        </DialogHeader>

        <input
          ref={cameraInput}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => {
            void upload(e.target.files)
            e.target.value = ''
          }}
        />
        <input
          ref={galleryInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void upload(e.target.files)
            e.target.value = ''
          }}
        />

        {busy ? (
          <div className="flex items-center justify-center gap-3 rounded-xl border p-6 text-sm text-muted-foreground" role="status">
            <Loader2Icon className="size-4 animate-spin text-primary" />
            Uploading photo {Math.min(uploading.done + 1, uploading.total)} of {uploading.total}…
          </div>
        ) : (
          <div className="grid gap-3 rounded-xl border border-dashed p-6 sm:grid-cols-2">
            <Button size="lg" className="h-12" onClick={() => cameraInput.current?.click()}>
              <CameraIcon /> Take a photo
            </Button>
            <Button size="lg" variant="outline" className="h-12" onClick={() => galleryInput.current?.click()}>
              <ImagesIcon /> Choose photos
            </Button>
            <p className="text-center text-sm text-muted-foreground sm:col-span-2">
              Hold the page flat, fill the frame, and avoid shadows. {listKindLabel(list)}.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Keeps the list's background scans up to date; polls while any is running. */
export function useScans(listId: number) {
  const [scans, setScans] = useState<Scan[]>([])
  const refresh = useCallback(
    () => api.scans(listId).then(setScans, () => {}),
    [listId],
  )
  const running = scans.some((s) => s.status === 'running')

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!running) return
    const t = setInterval(() => void refresh(), 2500)
    return () => clearInterval(t)
  }, [running, refresh])

  return { scans, refresh }
}

/** Shows photos that are being read, finished, or failed. */
export function ScanTray({
  scans,
  onReview,
  onDismiss,
}: {
  scans: Scan[]
  onReview: (scan: Scan) => void
  onDismiss: (scan: Scan) => void
}) {
  if (scans.length === 0) return null
  const running = scans.filter((s) => s.status === 'running').length
  return (
    <ul className="grid gap-2" aria-label="Scanned photos">
      {running > 0 && (
        <li className="flex items-center gap-3 rounded-xl border bg-card px-4 py-3 text-sm" role="status">
          <Loader2Icon className="size-4 shrink-0 animate-spin text-primary" />
          Reading {running === 1 ? 'a photo' : `${running} photos`} in the background…
        </li>
      )}
      {scans
        .filter((s) => s.status !== 'running')
        .map((s) => (
          <li key={s.id} className="flex items-center gap-3 rounded-xl border bg-card px-4 py-3 text-sm">
            {s.status === 'done' ? (
              <CheckCircle2Icon className="size-4 shrink-0 text-primary" />
            ) : (
              <AlertCircleIcon className="size-4 shrink-0 text-warn" />
            )}
            <span className="min-w-0 flex-1">
              {s.status === 'done'
                ? s.words.length === 0
                  ? 'No entries found in a photo.'
                  : `${s.words.length} ${s.words.length === 1 ? 'entry' : 'entries'} read${s.page ? ` from page ${s.page}` : ''}.`
                : s.error}
            </span>
            {s.status === 'done' && s.words.length > 0 && (
              <Button size="sm" onClick={() => onReview(s)}>
                Review
              </Button>
            )}
            <Button size="icon-sm" variant="ghost" aria-label="Dismiss" onClick={() => onDismiss(s)}>
              <XIcon />
            </Button>
          </li>
        ))}
    </ul>
  )
}

interface Row {
  key: number
  term: string
  translation: string
  page: string
  issues: Issue[]
  duplicate: boolean
  include: boolean
}

/** Check and fix what a finished scan found, then add it to the list. */
export function ReviewDialog({
  list,
  existing,
  scan,
  onClose,
  onAdded,
}: {
  list: List
  existing: Word[]
  scan: Scan | null
  onClose: () => void
  onAdded: (words: Word[], scan: Scan) => void
}) {
  const [rows, setRows] = useState<Row[]>([])
  const [saving, setSaving] = useState(false)
  const scanId = scan?.id

  useEffect(() => {
    if (!scan) return
    const seen = new Set(existing.map((w) => w.term.toLowerCase()))
    setRows(
      scan.words.map((w) => {
        const duplicate = seen.has(w.term.toLowerCase())
        seen.add(w.term.toLowerCase())
        return {
          key: nextKey++,
          term: w.term,
          translation: w.translation,
          page: scan.page ? String(scan.page) : '',
          issues: w.issues,
          duplicate,
          include: !duplicate,
        }
      }),
    )
    // Only reset when a different scan is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanId])

  const patch = (key: number, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)))
  const chosen = rows.filter((r) => r.include && (r.term.trim() || r.translation.trim()))
  const openIssues = chosen.filter((r) => r.issues.length > 0).length

  const save = async () => {
    if (!scan) return
    setSaving(true)
    try {
      const { words } = await api.addWords(
        list.id,
        chosen.map((r) => ({ term: r.term, translation: r.translation, page: parseInt(r.page) || 0, issues: r.issues })),
      )
      await api.deleteScan(scan.id).catch(() => {})
      onAdded(words, scan)
      toast.success(`Added ${words.length} ${words.length === 1 ? 'word' : 'words'}.`)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={scan !== null} onOpenChange={(o) => (saving || o ? undefined : onClose())}>
      <DialogContent className="flex max-h-[92dvh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Check what was read</DialogTitle>
          <DialogDescription>
            Fix anything that was read wrong, untick what you don’t want, then add it to the list. Closing this keeps
            the photo’s result for later.
          </DialogDescription>
        </DialogHeader>
        {scan && !scan.dictChecked && list.kind === 'lang' && (
          <p className="text-sm text-warn">The dictionary couldn’t be reached, so these words are unchecked.</p>
        )}
        <ul className="-mx-2 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 py-1">
          {rows.map((r) => (
            <li key={r.key} className="grid gap-1.5 rounded-lg px-1 py-1.5 data-[off=true]:opacity-50" data-off={!r.include}>
              <div className="flex items-center gap-2">
                <Checkbox
                  checked={r.include}
                  onCheckedChange={(v) => patch(r.key, { include: v === true })}
                  aria-label={`Include ${r.term}`}
                />
                <div className="grid min-w-0 flex-1 gap-1.5 sm:grid-cols-2">
                  <Input
                    value={r.term}
                    aria-label={sideName(list, 'a')}
                    aria-invalid={r.issues.some((i) => i.side !== 'b')}
                    onChange={(e) => patch(r.key, { term: e.target.value, issues: r.issues.filter((i) => i.side === 'b') })}
                  />
                  <Input
                    value={r.translation}
                    aria-label={sideName(list, 'b')}
                    aria-invalid={r.issues.some((i) => i.side !== 'a')}
                    onChange={(e) =>
                      patch(r.key, { translation: e.target.value, issues: r.issues.filter((i) => i.side === 'a') })
                    }
                  />
                </div>
                <Input
                  value={r.page}
                  onChange={(e) => patch(r.key, { page: e.target.value.replace(/\D/g, '') })}
                  inputMode="numeric"
                  placeholder="p."
                  aria-label="Page"
                  className="w-14 shrink-0 text-center"
                />
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Remove row"
                  onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                >
                  <XIcon />
                </Button>
              </div>
              <div className="pl-6 empty:hidden">
                {r.duplicate && <p className="text-[0.8rem] text-muted-foreground">Already in this list.</p>}
                <IssueNote
                  issues={r.issues}
                  onDismiss={() => patch(r.key, { issues: [] })}
                  onFix={(side, text) =>
                    patch(r.key, {
                      [side === 'a' ? 'term' : 'translation']: text,
                      issues: r.issues.filter((i) => i.side !== side && i.side !== ''),
                    })
                  }
                />
              </div>
            </li>
          ))}
        </ul>
        <DialogFooter className="items-center sm:justify-between">
          <Button
            variant="ghost"
            disabled={saving}
            onClick={() => {
              if (scan) void api.deleteScan(scan.id).catch(() => {})
              if (scan) onAdded([], scan)
            }}
          >
            Discard
          </Button>
          <div className="flex flex-col-reverse items-center gap-3 sm:flex-row">
            {openIssues > 0 && (
              <span className="text-sm text-warn">
                {openIssues} {openIssues === 1 ? 'row' : 'rows'} to check
              </span>
            )}
            <Button disabled={saving || chosen.length === 0} onClick={save} className="w-full sm:w-auto">
              Add {chosen.length} {chosen.length === 1 ? 'word' : 'words'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
