import { TriangleAlertIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { Issue, Side } from '@/lib/api'

/** Explains what the dictionary check found on a row, with one-tap fixes. */
export function IssueNote({
  issues,
  onFix,
  onDismiss,
}: {
  issues: Issue[]
  onFix: (side: Side, text: string) => void
  onDismiss: () => void
}) {
  if (issues.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.8rem] text-warn">
      {issues.map((is, i) => (
        <span key={i} className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <TriangleAlertIcon className="size-3.5 shrink-0" />
          {is.side === '' ? (
            'Hard to read in the photo. Check this row.'
          ) : (
            <>
              <span>
                “{is.token}” isn’t in the dictionary.{is.suggestion && ' Did you mean:'}
              </span>
              {is.suggestion && (
                <Button
                  size="xs"
                  variant="outline"
                  className="text-foreground"
                  onClick={() => onFix(is.side as Side, is.suggestion!)}
                >
                  {is.suggestion}
                </Button>
              )}
            </>
          )}
        </span>
      ))}
      <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={onDismiss}>
        It’s correct
      </Button>
    </div>
  )
}
