import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useRef } from 'react'
import {
  HitCasesRoute,
  LibraryRoute,
  LibraryTabsList,
  ReferencesRoute,
  WholeFilmsRoute,
  type HitCaseScope,
  type HitCaseTarget,
  type LibraryScope,
  type ReferenceScope,
  type WholeFilmScope,
} from '@/features/library'
import { ensureSessionUser, hasPermission, PERMISSION, useUser } from '@/shared/auth'
import { TabsContent, TabsRoot } from '@/shared/ui/tabs'
import {
  hitCaseScopeFromSearch,
  librarySearchSchema,
  referenceScopeFromSearch,
  scopeFromSearch,
  searchFromHitCaseScope,
  searchFromReferenceScope,
  searchFromScope,
  searchFromTab,
  searchFromWholeFilmScope,
  tabFromSearch,
  wholeFilmScopeFromSearch,
} from '../-library-search'

export const Route = createFileRoute('/_shell/library')({
  beforeLoad: async () => {
    if (!hasPermission(await ensureSessionUser(), PERMISSION.generationRead)) {
      throw redirect({ to: '/' })
    }
  },
  component: LibraryPage,
  validateSearch: librarySearchSchema,
})

const TAB_CONTENT_CLASS = 'flex min-h-0 flex-1 flex-col'

function LibraryPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const router = useRouter()
  const { data: user } = useUser()
  const pushedRef = useRef(false)
  const setScope = (next: LibraryScope) =>
    void navigate({ replace: true, search: searchFromScope(next) })
  const setReferenceScope = (next: ReferenceScope) =>
    void navigate({ replace: true, search: searchFromReferenceScope(next) })
  const setWholeFilmScope = (next: WholeFilmScope) =>
    void navigate({ replace: true, search: searchFromWholeFilmScope(next) })
  const setHitCaseScope = (next: HitCaseScope) =>
    void navigate({ replace: true, search: searchFromHitCaseScope(next) })
  const setTab = (value: string) => {
    pushedRef.current = false
    void navigate({ replace: true, search: searchFromTab(value) })
  }
  const setDetail =
    (key: 'video' | 'reference' | 'film') => (id: string | null, replace: boolean) => {
      if (id === null && pushedRef.current) {
        pushedRef.current = false
        router.history.back()
        return
      }
      if (id !== null && !replace) pushedRef.current = true
      void navigate({
        replace: id === null || replace,
        // 切卡或关掉时一并清掉地址里指定的版本，不让它在下一次打开时又选上。
        search: (prev) => ({ ...prev, [key]: id ?? undefined, version: undefined }),
      })
    }
  // 爆款素材按版本打开：地址里同时写卡与那一版，关掉的规则同上。
  const setHitCase = (target: HitCaseTarget | null, replace: boolean) => {
    if (target === null && pushedRef.current) {
      pushedRef.current = false
      router.history.back()
      return
    }
    if (target !== null && !replace) pushedRef.current = true
    void navigate({
      replace: target === null || replace,
      search: (prev) => ({ ...prev, version: target?.jobId, video: target?.cardId }),
    })
  }
  const shareLinkOf = (id: string, version: string | null = null) =>
    new URL(
      router.buildLocation({
        search: version === null ? { video: id } : { version, video: id },
        to: '/library',
      }).href,
      window.location.origin,
    ).href
  const myUserName = user?.username ?? null

  return (
    <TabsRoot className={TAB_CONTENT_CLASS} onValueChange={setTab} value={tabFromSearch(search)}>
      <TabsContent className={TAB_CONTENT_CLASS} tabIndex={-1} value="videos">
        <LibraryRoute
          myUserName={myUserName}
          onScopeChange={setScope}
          onVideoChange={setDetail('video')}
          scope={scopeFromSearch(search)}
          shareLinkOf={shareLinkOf}
          tabs={<LibraryTabsList />}
          versionId={search.version ?? null}
          videoId={search.video ?? null}
        />
      </TabsContent>
      <TabsContent className={TAB_CONTENT_CLASS} tabIndex={-1} value="references">
        <ReferencesRoute
          myUserName={myUserName}
          onReferenceChange={setDetail('reference')}
          onScopeChange={setReferenceScope}
          referenceId={search.reference ?? null}
          scope={referenceScopeFromSearch(search)}
          tabs={<LibraryTabsList />}
        />
      </TabsContent>
      <TabsContent className={TAB_CONTENT_CLASS} tabIndex={-1} value="hit-cases">
        <HitCasesRoute
          cardId={search.video ?? null}
          onHitCaseChange={setHitCase}
          onScopeChange={setHitCaseScope}
          scope={hitCaseScopeFromSearch(search)}
          shareLinkOf={shareLinkOf}
          tabs={<LibraryTabsList />}
          versionId={search.version ?? null}
        />
      </TabsContent>
      <TabsContent className={TAB_CONTENT_CLASS} tabIndex={-1} value="whole-films">
        <WholeFilmsRoute
          filmId={search.film ?? null}
          myUserName={myUserName}
          onFilmChange={setDetail('film')}
          onScopeChange={setWholeFilmScope}
          scope={wholeFilmScopeFromSearch(search)}
          tabs={<LibraryTabsList />}
        />
      </TabsContent>
    </TabsRoot>
  )
}
