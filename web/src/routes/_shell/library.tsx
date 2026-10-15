import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useRef } from 'react'
import {
  LibraryRoute,
  WholeFilmsRoute,
  BrandTemplatesRoute,
  LibraryTabsList,
  ReferencesRoute,
  type LibraryScope,
  type ReferenceScope,
  type WholeFilmScope,
} from '@/features/library'
import { ensureSessionUser, hasPermission, PERMISSION, useUser } from '@/shared/auth'
import { TabsContent, TabsRoot } from '@/shared/ui/tabs'
import {
  librarySearchSchema,
  referenceScopeFromSearch,
  scopeFromSearch,
  searchFromReferenceScope,
  searchFromScope,
  searchFromWholeFilmScope,
  wholeFilmScopeFromSearch,
} from '../-library-search'

// 资料库要登录且能看出片记录；页签、筛选范围与打开着的详情存在查询参数里，退回、刷新与分享链接都还原同一屏。
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
  const tab = search.tab ?? 'videos'
  // 从列表点开详情时压了一条历史，关掉就退回那条，手机上的返回手势也就是关详情。
  const pushedRef = useRef(false)
  const setScope = (next: LibraryScope) =>
    void navigate({ replace: true, search: searchFromScope(next) })
  const setReferenceScope = (next: ReferenceScope) =>
    void navigate({ replace: true, search: searchFromReferenceScope(next) })
  const setWholeFilmScope = (next: WholeFilmScope) =>
    void navigate({ replace: true, search: searchFromWholeFilmScope(next) })
  // 换页签时两边的筛选不通用，一并清掉；与审计页的页签一样不新增历史记录。
  const setTab = (value: string) => {
    pushedRef.current = false
    void navigate({
      replace: true,
      search:
        value === 'references' || value === 'whole-films' || value === 'brand-templates'
          ? { tab: value }
          : {},
    })
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
    <TabsRoot className={TAB_CONTENT_CLASS} onValueChange={setTab} value={tab}>
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
          scope={{
            q: search.q ?? '',
            position: search.position,
            includeDisabled: search.includeDisabled === true,
          }}
          onScopeChange={(scope) =>
            void navigate({
              replace: true,
              search: {
                tab: 'brand-templates',
                q: scope.q.trim() || undefined,
                position: scope.position,
                includeDisabled: scope.includeDisabled ? true : undefined,
              },
            })
          }
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
