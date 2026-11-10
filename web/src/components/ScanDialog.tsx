import { CameraIcon, ImagesIcon, Loader2Icon, XIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'

import { IssueNote } from '@/components/IssueNote'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { api, errorMessage, langName, type Issue, type List, type Word } from '@/lib/api'

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

export function ScanDialog({
  list,
  existing,
  open,
  onOpenChange,
  onAdded,
}: {
  list: List
  existing: Word[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdded: (words: Word[]) => void
}) {
  const [rows, setRows] = useState<Row[]>([])
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [saving, setSaving] = useState(false)
  const [dictWarning, setDictWarning] = useState(false)
  const cameraInput = useRef<HTMLInputElement>(null)
  const galleryInput = useRef<HTMLInputElement>(null)

  const patch = (key: number, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)))

  const scan = async (files: FileList | null) => {
    if (!files?.length) return
    const photos = [...files]
    const known = new Set(existing.map((w) => w.term.toLowerCase()))
    setProgress({ done: 0, total: photos.length })
    for (const [i, file] of photos.entries()) {
      try {
        const result = await api.scan(list.id, await prepareImage(file))
        if (!result.dictChecked) setDictWarning(true)
        if (result.words.length === 0) toast.warning(`No word pairs found in ${photos.length > 1 ? file.name : 'that photo'}.`)
        setRows((rs) => {
          const seen = new Set([...known, ...rs.map((r) => r.term.toLowerCase())])
          return [
            ...rs,
            ...result.words.map((w) => {
              const duplicate = seen.has(w.term.toLowerCase())
              return {
                key: nextKey++,
                term: w.term,
                translation: w.translation,
                page: result.page ? String(result.page) : '',
                issues: w.issues,
                duplicate,
                include: !duplicate,
              }
            }),
          ]
        })
      } catch (e) {
        toast.error(errorMessage(e))
      }
      setProgress({ done: i + 1, total: photos.length })
    }
    setProgress(null)
  }

  const chosen = rows.filter((r) => r.include && (r.term.trim() || r.translation.trim()))
  const openIssues = chosen.filter((r) => r.issues.length > 0).length

  const save = async () => {
    setSaving(true)
    try {
      const { words } = await api.addWords(
        list.id,
        chosen.map((r) => ({ term: r.term, translation: r.translation, page: parseInt(r.page) || 0, issues: r.issues })),
      )
      onAdded(words)
      toast.success(`Added ${words.length} ${words.length === 1 ? 'word' : 'words'}.`)
      setRows([])
      onOpenChange(false)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  const busy = progress !== null

  return (
    <Dialog open={open} onOpenChange={(o) => (busy || saving ? undefined : onOpenChange(o))}>
      <DialogContent className="flex max-h-[92dvh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Scan a vocab table</DialogTitle>
          <DialogDescription>
            Photograph the table with {langName(list.langA)} and {langName(list.langB)} side by side. Every word is
            checked against a dictionary, so reading mistakes stand out.
          </DialogDescription>
        </DialogHeader>

        <input
          ref={cameraInput}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => {
            void scan(e.target.files)
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
            void scan(e.target.files)
            e.target.value = ''
          }}
        />

        {rows.length === 0 && !busy && (
          <div className="grid gap-3 rounded-xl border border-dashed p-6 sm:grid-cols-2">
            <Button size="lg" className="h-12" onClick={() => cameraInput.current?.click()}>
              <CameraIcon /> Take a photo
            </Button>
            <Button size="lg" variant="outline" className="h-12" onClick={() => galleryInput.current?.click()}>
              <ImagesIcon /> Choose photos
            </Button>
            <p className="text-center text-sm text-muted-foreground sm:col-span-2">
              Hold the page flat, fill the frame with the table, and avoid shadows.
            </p>
          </div>
        )}

        {busy && (
          <div className="flex items-center justify-center gap-3 rounded-xl border p-6 text-sm text-muted-foreground" role="status">
            <Loader2Icon className="size-4 animate-spin text-primary" />
            Reading photo {Math.min(progress.done + 1, progress.total)} of {progress.total}…
          </div>
        )}

        {rows.length > 0 && (
          <>
            {dictWarning && (
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
                        aria-label={langName(list.langA)}
                        aria-invalid={r.issues.some((i) => i.side !== 'b')}
                        onChange={(e) =>
                          patch(r.key, { term: e.target.value, issues: r.issues.filter((i) => i.side === 'b') })
                        }
                      />
                      <Input
                        value={r.translation}
                        aria-label={langName(list.langB)}
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
              <Button variant="ghost" disabled={busy} onClick={() => galleryInput.current?.click()}>
                <ImagesIcon /> Add another photo
              </Button>
              <div className="flex flex-col-reverse items-center gap-3 sm:flex-row">
                {openIssues > 0 && (
                  <span className="text-sm text-warn">
                    {openIssues} {openIssues === 1 ? 'row' : 'rows'} to check
                  </span>
                )}
                <Button disabled={saving || busy || chosen.length === 0} onClick={save} className="w-full sm:w-auto">
                  Add {chosen.length} {chosen.length === 1 ? 'word' : 'words'}
                </Button>
              </div>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
