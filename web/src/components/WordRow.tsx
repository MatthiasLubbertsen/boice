import { FlagIcon, MicIcon, MoreHorizontalIcon, PlayIcon, Trash2Icon } from 'lucide-react'
import { memo, useEffect, useState } from 'react'

import { IssueNote } from '@/components/IssueNote'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { api, sideCode, sideName, type List, type Side, type Word } from '@/lib/api'
import { player } from '@/lib/player'
import { hasAudio, sidesFor } from '@/lib/words'
import { cn } from '@/lib/utils'

/** A text field that looks like plain text until focused, and saves on blur or Enter. */
export function EditableText({
  value,
  onCommit,
  className,
  ...props
}: { value: string; onCommit: (value: string) => void } & Omit<React.ComponentProps<'input'>, 'value' | 'onChange'>) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <input
      {...props}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft.trim() !== value) onCommit(draft.trim())
        else setDraft(value)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          setDraft(value)
          requestAnimationFrame(() => (e.target as HTMLInputElement).blur())
        }
      }}
      className={cn(
        'h-8 w-full min-w-0 rounded-md border border-transparent bg-transparent px-2 text-sm outline-none transition-colors',
        'hover:border-input focus:border-ring focus:bg-input/30 focus:ring-3 focus:ring-ring/30',
        'aria-invalid:border-warn/60 aria-invalid:text-warn',
        className,
      )}
    />
  )
}

export interface RowActions {
  select: (id: number, on: boolean) => void
  patch: (id: number, patch: Parameters<typeof api.updateWord>[1]) => void
  remove: (id: number) => void
  record: (id: number) => void
  clearAudio: (id: number) => void
}

export const WordRow = memo(function WordRow({
  word,
  list,
  selected,
  actions,
}: {
  word: Word
  list: List
  selected: boolean
  actions: RowActions
}) {
  const sides = sidesFor(list.recordMode)
  const issueOn = (side: Side) => word.issues.some((i) => i.side === side || i.side === '')

  return (
    <li className="grid gap-1 border-b py-1.5 last:border-b-0">
      <div className="flex items-center gap-1.5">
        <Checkbox
          checked={selected}
          onCheckedChange={(v) => actions.select(word.id, v === true)}
          aria-label={`Select ${word.term}`}
          className="mx-1"
        />
        <div className="grid min-w-0 flex-1 sm:grid-cols-2 sm:gap-1">
          <EditableText
            value={word.term}
            aria-label={sideName(list, 'a')}
            aria-invalid={issueOn('a')}
            lang={list.langA}
            className="font-medium"
            onCommit={(term) => actions.patch(word.id, { term })}
          />
          <EditableText
            value={word.translation}
            aria-label={sideName(list, 'b')}
            aria-invalid={issueOn('b')}
            lang={list.langB}
            className="text-muted-foreground focus:text-foreground"
            onCommit={(translation) => actions.patch(word.id, { translation })}
          />
        </div>
        <EditableText
          value={word.page ? String(word.page) : ''}
          aria-label="Page"
          placeholder="p."
          inputMode="numeric"
          className="w-12 shrink-0 px-1 text-center text-muted-foreground tabular-nums max-sm:hidden"
          onCommit={(page) => actions.patch(word.id, { page: parseInt(page) || 0 })}
        />
        <div className="flex shrink-0 gap-1">
          {sides.map((side) =>
            hasAudio(word, side) ? (
              <Button
                key={side}
                size="xs"
                variant="outline"
                className="w-14 text-primary uppercase"
                aria-label={`Play ${sideName(list, side)} recording`}
                onClick={() => void player.play(api.audioUrl(word, side))}
              >
                <PlayIcon className="fill-current" />
                {sideCode(list, side)}
              </Button>
            ) : (
              <Button
                key={side}
                size="xs"
                variant="ghost"
                className="w-14 border-dashed border-input text-muted-foreground uppercase"
                aria-label={`Record ${sideName(list, side)}`}
                onClick={() => actions.record(word.id)}
              >
                <MicIcon />
                {sideCode(list, side)}
              </Button>
            ),
          )}
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={word.flagged ? 'Remove flag' : 'Flag as difficult'}
          aria-pressed={word.flagged}
          onClick={() => actions.patch(word.id, { flagged: !word.flagged })}
        >
          <FlagIcon className={word.flagged ? 'fill-primary text-primary' : 'text-muted-foreground'} />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label="More">
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => actions.record(word.id)}>
              <MicIcon /> Record this word
            </DropdownMenuItem>
            {(word.audioA > 0 || word.audioB > 0) && (
              <DropdownMenuItem onSelect={() => actions.clearAudio(word.id)}>
                <Trash2Icon /> Delete recording
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => actions.remove(word.id)}>
              <Trash2Icon /> Delete word
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {word.issues.length > 0 && (
        <div className="pb-1 pl-9">
          <IssueNote
            issues={word.issues}
            onFix={(side, text) => actions.patch(word.id, side === 'a' ? { term: text } : { translation: text })}
            onDismiss={() => actions.patch(word.id, { issues: [] })}
          />
        </div>
      )}
    </li>
  )
})
