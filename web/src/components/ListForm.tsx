import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { errorMessage, LANGUAGES, langName, type List, type RecordMode } from '@/lib/api'
import { toast } from 'sonner'

export type ListFields = Pick<List, 'name' | 'langA' | 'langB' | 'recordMode'>

function LangSelect({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {Object.entries(LANGUAGES).map(([code, name]) => (
          <SelectItem key={code} value={code}>
            {name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function RecordModeSelect({
  id,
  value,
  langA,
  langB,
  onChange,
  className,
}: {
  id?: string
  value: RecordMode
  langA: string
  langB: string
  onChange: (v: RecordMode) => void
  className?: string
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as RecordMode)}>
      <SelectTrigger id={id} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="a">{langName(langA)} only</SelectItem>
        <SelectItem value="b">{langName(langB)} only</SelectItem>
        <SelectItem value="both">Both languages</SelectItem>
      </SelectContent>
    </Select>
  )
}

/** Dialog for creating a list or editing its settings. */
export function ListFormDialog({
  open,
  onOpenChange,
  initial,
  title,
  submitLabel,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initial: ListFields
  title: string
  submitLabel: string
  onSubmit: (fields: ListFields) => Promise<void>
}) {
  const [fields, setFields] = useState(initial)
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<ListFields>) => setFields((f) => ({ ...f, ...patch }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!fields.name.trim()) return
    setBusy(true)
    try {
      await onSubmit({ ...fields, name: fields.name.trim() })
      onOpenChange(false)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) setFields(initial)
        onOpenChange(o)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>One list per chapter or test works well.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="list-name">Name</Label>
            <Input
              id="list-name"
              value={fields.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="Kapitel 3 — Aussehen"
              maxLength={120}
              autoFocus
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="list-lang-a">Learning</Label>
              <LangSelect id="list-lang-a" value={fields.langA} onChange={(langA) => set({ langA })} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="list-lang-b">Translation</Label>
              <LangSelect id="list-lang-b" value={fields.langB} onChange={(langB) => set({ langB })} />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="list-mode">What you record</Label>
            <RecordModeSelect
              id="list-mode"
              className="w-full"
              value={fields.recordMode}
              langA={fields.langA}
              langB={fields.langB}
              onChange={(recordMode) => set({ recordMode })}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={busy || !fields.name.trim()}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
