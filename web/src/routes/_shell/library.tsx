import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useRef } from 'react'
import {
  LibraryRoute,
  WholeFilmsRoute,
  BrandTemplatesRoute,
  LibraryTabsList,
  ReferencesRoute,
  type BrandTemplateScope,
  type LibraryScope,
  type ReferenceScope,
  type WholeFilmScope,
} from '@/features/library'
import { ensureSessionUser, hasPermission, PERMISSION, useUser } from '@/shared/auth'
import { TabsContent, TabsRoot } from '@/shared/ui/tabs'
import {
  brandTemplateScopeFromSearch,
  librarySearchSchema,
  referenceScopeFromSearch,
  scopeFromSearch,
  searchFromBrandTemplateScope,
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
  const setBrandTemplateScope = (next: BrandTemplateScope) =>
    void navigate({ replace: true, search: searchFromBrandTemplateScope(next) })
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
        search: (prev) => ({ ...prev, [key]: id ?? undefined }),
      })
    }
  const shareLinkOf = (id: string) =>
    new URL(
      router.buildLocation({ search: { video: id }, to: '/library' }).href,
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
          videoId={search.video ?? null}
        />
      </TabsContent>
      <TabsContent className={TAB_CONTENT_CLASS} tabIndex={-1} value="whole-films">
        <WholeFilmsRoute
          myUserName={myUserName}
          onScopeChange={setWholeFilmScope}
          scope={wholeFilmScopeFromSearch(search)}
          filmId={search.film ?? null}
          onFilmChange={setDetail('film')}
          tabs={<LibraryTabsList />}
        />
      </TabsContent>
      <TabsContent className={TAB_CONTENT_CLASS} tabIndex={-1} value="brand-templates">
        <BrandTemplatesRoute
          canManage={hasPermission(user, PERMISSION.usersManage)}
          canUpload={hasPermission(user, PERMISSION.uploadsWrite)}
          scope={brandTemplateScopeFromSearch(search)}
          onScopeChange={setBrandTemplateScope}
          tabs={<LibraryTabsList />}
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
    </TabsRoot>
  )
}
