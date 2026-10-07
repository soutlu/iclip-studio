import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { CollectionFormDialog, CollectionPicker, useCollections } from '@/features/collections'
import {
  refreshConversationLists,
  useConversationAgents,
  useStartConversation,
} from '@/features/conversations'
import { HomeRoute } from '@/features/home'
import { useLibraryVideo } from '@/features/library'
import { errorMessageOf } from '@/shared/api/client'
import { hasPermission, PERMISSION, useUser } from '@/shared/auth'
import { Icon } from '@/shared/icons'
import { useShellChrome } from '@/shared/shell'
import type { ComposerSubmission } from '@/shared/ui/composer'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { MenuItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { toast } from '@/shared/ui/toast'
import { useLoginPrompt } from './-login-prompt'

/** 路由组合首页输入、真实合集与对话创建；两端 feature 不互相依赖。 */
export function HomePage() {
  const { data: user } = useUser()
  const requireLogin = useLoginPrompt()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [chosenAgentId, setChosenAgentId] = useState<string | null>(null)
  const [chosenCollection, setChosenCollection] = useState<{
    ownerUserId: string | null
    id: string | null
  } | null>(null)
  const [newCollectionName, setNewCollectionName] = useState<string | null>(null)
  const canRun = hasPermission(user, PERMISSION.agentRun)
  const canReadCollections = hasPermission(user, PERMISSION.collectionsRead)
  const canWriteCollections = hasPermission(user, PERMISSION.collectionsWrite)
  const agents = useConversationAgents(canRun)
  const collectionsQuery = useCollections(canReadCollections)
  const collections = collectionsQuery.data ?? []
  const chosenCollectionId =
    chosenCollection && chosenCollection.ownerUserId === user?.id ? chosenCollection.id : null
  const chooseCollection = (id: string | null) =>
    setChosenCollection({ ownerUserId: user?.id ?? null, id })
  // 侧栏合集行「在合集里新建任务」把合集带在查询串里：等登录身份就绪后预选一次，再从地址栏移除。
  // 输入框聚焦由侧栏经应用壳请求，这里不重复。不在自己合集里的 id 由下面的合集校验退回无关联。
  const requestedCollection = useSearch({
    select: (search) => search.collection,
    strict: false,
  })
  const [appliedRequest, setAppliedRequest] = useState<string | undefined>(undefined)
  if (user !== undefined && requestedCollection !== appliedRequest) {
    setAppliedRequest(requestedCollection)
    if (requestedCollection !== undefined) chooseCollection(requestedCollection)
  }
  // 资料库「做同款」把卡 id 带在查询串里，同合集一样：身份就绪后进入做同款一次，再从地址栏移除。
  // 换了身份就不再算数；助手改回由源视频预选。
  const requestedSame = useSearch({
    select: (search) => search.same,
    strict: false,
  })
  const [appliedSame, setAppliedSame] = useState<string | undefined>(undefined)
  const [sameStyle, setSameStyle] = useState<{ ownerUserId: string | null; id: string } | null>(
    null,
  )
  if (user !== undefined && requestedSame !== appliedSame) {
    setAppliedSame(requestedSame)
    if (requestedSame !== undefined) {
      setSameStyle({ ownerUserId: user?.id ?? null, id: requestedSame })
      setChosenAgentId(null)
    }
  }
  useEffect(() => {
    if (user === undefined || (requestedCollection === undefined && requestedSame === undefined))
      return
    void navigate({
      replace: true,
      search: (prev) => ({ ...prev, collection: undefined, same: undefined }),
      to: '/',
    })
  }, [navigate, requestedCollection, requestedSame, user])
  const sameAs =
    sameStyle !== null && sameStyle.ownerUserId === (user?.id ?? null) ? sameStyle.id : null
  // 能不能做同款只有资料库详情知道；读不了、读失败或做不了都退出做同款并说明原因。
  const canReadLibrary = hasPermission(user, PERMISSION.generationRead)
  const source = useLibraryVideo(sameAs !== null && canReadLibrary ? sameAs : null)
  const sourceCard = sameAs === null ? undefined : source.data
  const sameStyleFailure =
    sameAs === null
      ? null
      : !canReadLibrary
        ? '你没有查看资料库的权限，做不了同款'
        : // 上次读失败留在缓存里时，等这次重读落定再判断。
          source.isError && !source.isFetching
          ? errorMessageOf(source.error, '读取这条视频失败，做不了同款')
          : sourceCard?.canMakeSame === false
            ? '这条视频没有可用的制作文件，做不了同款'
            : null
  // 渲染期退出，提示交给 effect 弹；每次失败一个新对象，同样的原因再来一次也照样提示。
  const [sameStyleNotice, setSameStyleNotice] = useState<{ message: string } | null>(null)
  if (sameStyleFailure !== null) {
    setSameStyle(null)
    setSameStyleNotice({ message: sameStyleFailure })
  }
  useEffect(() => {
    if (sameStyleNotice !== null) toast.error(sameStyleNotice.message)
  }, [sameStyleNotice])
  // 已删除的合集回到无关联；读取失败时保留缓存里的当前选择。
  const collectionId = collections.some((item) => item.id === chosenCollectionId)
    ? chosenCollectionId
    : null
  // 做同款默认用源视频的助手，它不在可选列表里时用默认助手；用户选过的优先。
  const sourceAgentId = sourceCard?.video.agentId ?? null
  const presetAgentId = agents.data?.items.some((item) => item.id === sourceAgentId)
    ? sourceAgentId
    : null
  const agentId = chosenAgentId ?? presetAgentId ?? agents.data?.default ?? null
  const chosenAgent = agents.data?.items.find((item) => item.id === agentId) ?? null
  const validAgent = chosenAgent !== null
  const start = useStartConversation(user?.id ?? null, (conversationId) => {
    void navigate({ params: { conversationId }, to: '/c/$conversationId' })
  })
  const send = async ({ parts }: ComposerSubmission): Promise<boolean> => {
    if (!user) {
      requireLogin()
      return false
    }
    if (!canRun) {
      toast.error('你没有发起创作的权限')
      return false
    }
    if (!validAgent || agentId === null || agents.isError) {
      toast.error(
        agents.isError
          ? errorMessageOf(agents.error, '读取创作助手列表失败')
          : '请先选择可用的创作助手',
      )
      return false
    }
    try {
      await start.mutateAsync({
        agentId,
        collectionId,
        parts,
        ...(sameAs === null ? {} : { sameAs }),
      })
      setSameStyle(null)
      return true
    } catch (error) {
      toast.error(errorMessageOf(error, '发送失败，请重试'))
      return false
    }
  }
  const agentLabel = !user
    ? '登录后选择创作助手'
    : !canRun
      ? '无创作权限'
      : agents.isPending
        ? '正在加载创作助手…'
        : agents.isError
          ? '创作助手加载失败'
          : chosenAgent
            ? chosenAgent.name
            : agentId
              ? '所选创作助手已不可用'
              : '暂无可用的创作助手'
  // 只有一个可用助手且已选中它时，下拉只会列出它自己，改为只显示名字。
  const onlyAgent =
    canRun && agents.isSuccess && agents.data.items.length === 1 ? agents.data.items[0] : undefined
  const composerFocus = useShellChrome().composerFocus

  return (
    <>
      <HomeRoute
        agentPicker={
          onlyAgent !== undefined && chosenAgent?.id === onlyAgent.id ? (
            <span className="inline-flex h-(--control-height-md) max-w-48 items-center px-2 text-body font-medium text-on-surface">
              <span className="truncate">{onlyAgent.name}</span>
            </span>
          ) : (
            <MenuRoot>
              <MenuTrigger
                className="inline-flex h-(--control-height-md) max-w-48 ui-state items-center gap-1 rounded-full px-2 text-body font-medium text-on-surface ui-focus disabled:text-disabled-text"
                disabled={!canRun || agents.isPending || start.isPending}
              >
                <span className="truncate">{agentLabel}</span>
                <Icon
                  className="shrink-0 text-on-surface-variant"
                  decorative
                  name="expand"
                  size="sm"
                />
              </MenuTrigger>
              <MenuSurface align="end">
                {agents.isError ? (
                  <>
                    <InlineAlert
                      className="max-w-64 px-3 py-2"
                      message={errorMessageOf(agents.error, '读取创作助手列表失败')}
                    />
                    <MenuItem onSelect={() => void agents.refetch()}>重新加载</MenuItem>
                  </>
                ) : agents.data?.items.length ? (
                  agents.data.items.map((item) => (
                    <MenuItem key={item.id} onSelect={() => setChosenAgentId(item.id)}>
                      {item.name}
                    </MenuItem>
                  ))
                ) : (
                  <p className="px-3 py-2 text-body-sm text-on-surface-variant" role="status">
                    暂无可用的创作助手
                  </p>
                )}
              </MenuSurface>
            </MenuRoot>
          )
        }
        attachmentsEnabled={hasPermission(user, PERMISSION.uploadsWrite)}
        collectionPicker={
          <CollectionPicker
            disabled={!canReadCollections || start.isPending}
            error={
              collectionsQuery.isError
                ? errorMessageOf(collectionsQuery.error, '读取合集失败')
                : null
            }
            loading={canReadCollections && collectionsQuery.isPending}
            onChange={chooseCollection}
            onCreate={
              canWriteCollections && collectionsQuery.data ? setNewCollectionName : undefined
            }
            onRetry={() => void collectionsQuery.refetch()}
            options={collections}
            value={collectionId}
          />
        }
        focusRequested={composerFocus?.pending}
        onFocusHandled={composerFocus?.consume}
        onSend={send}
        preserveForLogin={!user}
        sameStyle={
          sameAs === null
            ? undefined
            : {
                onExit: () => setSameStyle(null),
                video:
                  sourceCard?.canMakeSame === true
                    ? {
                        aspectRatio: sourceCard.video.take.aspectRatio,
                        outputUrl: sourceCard.video.face.outputUrl,
                        title: sourceCard.video.title,
                      }
                    : null,
              }
        }
        sending={start.isPending}
      />
      <CollectionFormDialog
        initialName={newCollectionName ?? ''}
        onOpenChange={(open) => {
          if (!open) setNewCollectionName(null)
        }}
        onSaved={(collection) => {
          chooseCollection(collection.id)
          // 侧栏的合集列表来自对话拓扑，新建后让它重拉。
          void refreshConversationLists(queryClient, 'sidebar')
        }}
        open={newCollectionName !== null}
      />
    </>
  )
}
