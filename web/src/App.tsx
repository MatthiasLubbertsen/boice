import { LogOutIcon, TagsIcon, UserIcon } from 'lucide-react'
import { createContext, lazy, Suspense, useContext, useEffect, useState } from 'react'
import { Link, Route, Switch } from 'wouter'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { api, ApiError, type Me } from '@/lib/api'
import ListDetail from '@/pages/ListDetail'
import Lists from '@/pages/Lists'
import Subjects from '@/pages/Subjects'

// The recorder pulls in the MP3 encoder, so load it only when needed.
const Record = lazy(() => import('@/pages/Record'))
const Practice = lazy(() => import('@/pages/Practice'))

const MeContext = createContext<Me | null>(null)
export const useMe = () => useContext(MeContext)!

type AuthState = { status: 'loading' } | { status: 'ready'; me: Me } | { status: 'signed-out'; login: boolean } | { status: 'error'; message: string }

export function Logo() {
  return (
    <span className="flex items-center gap-2 font-semibold tracking-tight">
      <span className="grid size-6 place-items-center rounded-md bg-primary text-sm font-bold text-primary-foreground">B</span>
      Boice
    </span>
  )
}

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' })

  useEffect(() => {
    const load = () =>
      api.me().then(
        (me) => setAuth({ status: 'ready', me }),
        (e: ApiError) =>
          setAuth(e.status === 401 ? { status: 'signed-out', login: e.login } : { status: 'error', message: e.message }),
      )
    void load()
    const signedOut = () => setAuth((a) => (a.status === 'ready' ? { status: 'signed-out', login: a.me.canLogout } : a))
    window.addEventListener('boice:signed-out', signedOut)
    return () => window.removeEventListener('boice:signed-out', signedOut)
  }, [])

  if (auth.status === 'loading') return null

  if (auth.status !== 'ready') {
    const next = encodeURIComponent(location.pathname + location.search)
    return (
      <main className="grid min-h-dvh place-items-center p-6">
        <div className="flex w-full max-w-xs flex-col items-center gap-5 text-center">
          <div className="scale-150">
            <Logo />
          </div>
          {auth.status === 'error' ? (
            <>
              <p className="text-sm text-muted-foreground">{auth.message}</p>
              <Button onClick={() => location.reload()}>Try again</Button>
            </>
          ) : auth.login ? (
            <>
              <p className="text-sm text-muted-foreground">Record your vocab lists and listen to them anywhere.</p>
              <Button size="lg" className="w-full" asChild>
                <a href={`/auth/login?next=${next}`}>Sign in</a>
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              You're not signed in. Open Boice through your login proxy, then reload this page.
            </p>
          )}
        </div>
      </main>
    )
  }

  return (
    <MeContext.Provider value={auth.me}>
      <TooltipProvider delayDuration={300}>
        <Suspense>
        <Switch>
          <Route path="/l/:id/record">{(p) => <Record listId={Number(p.id)} />}</Route>
          <Route path="/l/:id/practice">{(p) => <Practice listId={Number(p.id)} />}</Route>
          <Route path="/l/:id">
            {(p) => (
              <Shell>
                <ListDetail key={p.id} listId={Number(p.id)} />
              </Shell>
            )}
          </Route>
          <Route path="/subjects">
            <Shell>
              <Subjects />
            </Shell>
          </Route>
          <Route>
            <Shell>
              <Lists />
            </Shell>
          </Route>
        </Switch>
        </Suspense>
        <Toaster position="top-center" />
      </TooltipProvider>
    </MeContext.Provider>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  const me = useMe()
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col px-4 pb-16 sm:px-6">
      <header className="flex h-14 items-center justify-between">
        <Link href="/" aria-label="Boice home">
          <Logo />
        </Link>
        <div className="flex items-center gap-1">
        <Button variant="ghost" asChild>
          <Link href="/subjects">
            <TagsIcon /> Subjects
          </Link>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Account">
              <UserIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuLabel className="truncate">{me.user.name}</DropdownMenuLabel>
            {me.canLogout && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <a href="/auth/logout">
                    <LogOutIcon /> Sign out
                  </a>
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        </div>
      </header>
      {children}
    </div>
  )
}
