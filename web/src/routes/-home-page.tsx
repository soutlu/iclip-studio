import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { CollectionFormDialog, CollectionPicker, useCollections } from '@/features/collections'
import {
  refreshConversationLists,
  useConversationAgents,
  useStartConversation,
} from '@/features/conversations'
import { HomeRoute, useHomeDraft } from '@/features/home'
import { useLibraryVideo, useReference } from '@/features/library'
import { errorMessageOf } from '@/shared/api/client'
import { hasPermission, PERMISSION, useUser } from '@/shared/auth'
import { Icon } from '@/shared/icons'
import { useShellChrome } from '@/shared/shell'
import type { ComposerSubmission } from '@/shared/ui/composer'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { MenuItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { toast } from '@/shared/ui/toast'
import { useLoginPrompt } from './-login-prompt'

export function HomePage() {
  const { data: user } = useUser()
  const requireLogin = useLoginPrompt()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const draft = useHomeDraft(user?.id)
  const {
    agentId: chosenAgentId,
    chooseAgent,
    chooseCollection,
    collectionId: chosenCollectionId,
  } = draft
  const [newCollectionName, setNewCollectionName] = useState<string | null>(null)
  const canRun = hasPermission(user, PERMISSION.agentRun)
  const canReadCollections = hasPermission(user, PERMISSION.collectionsRead)
  const canWriteCollections = hasPermission(user, PERMISSION.collectionsWrite)
  const agents = useConversationAgents(canRun)
  const collectionsQuery = useCollections(canReadCollections)
  const collections = collectionsQuery.data ?? []
  const requestedCollection = useSearch({
    select: (search) => search.collection,
    strict: false,
  })
  const [appliedRequest, setAppliedRequest] = useState<string | undefined>(undefined)
  if (user !== undefined && requestedCollection !== appliedRequest) {
    setAppliedRequest(requestedCollection)
    if (requestedCollection !== undefined) chooseCollection(requestedCollection)
  }
  const requestedSame = useSearch({
    select: (search) => search.same,
    strict: false,
  })
  const requestedReference = useSearch({
    select: (search) => search.reference,
    strict: false,
  })
  const [appliedSame, setAppliedSame] = useState<string | undefined>(undefined)
  const [appliedReference, setAppliedReference] = useState<string | undefined>(undefined)
  const [sameStyle, setSameStyle] = useState<{
    ownerUserId: string | null
    id: string
    kind: 'video' | 'reference'
  } | null>(null)
  if (
    user !== undefined &&
    (requestedSame !== appliedSame || requestedReference !== appliedReference)
  ) {
    setAppliedSame(requestedSame)
    setAppliedReference(requestedReference)
    if (requestedReference !== undefined) {
      setSameStyle({ ownerUserId: user?.id ?? null, id: requestedReference, kind: 'reference' })
    } else if (requestedSame !== undefined) {
      setSameStyle({ ownerUserId: user?.id ?? null, id: requestedSame, kind: 'video' })
      chooseAgent(null)
    }
  }
  useEffect(() => {
    if (
      user === undefined ||
      (requestedCollection === undefined &&
        requestedSame === undefined &&
        requestedReference === undefined)
    )
      return
    void navigate({
      replace: true,
      search: (prev) => ({ ...prev, collection: undefined, same: undefined, reference: undefined }),
      to: '/',
    })
  }, [navigate, requestedCollection, requestedSame, requestedReference, user])
  const activeSameStyle =
    sameStyle !== null && sameStyle.ownerUserId === (user?.id ?? null) ? sameStyle : null
  const sameAs = activeSameStyle?.kind === 'video' ? activeSameStyle.id : null
  const referenceId = activeSameStyle?.kind === 'reference' ? activeSameStyle.id : null
  const canReadLibrary = hasPermission(user, PERMISSION.generationRead)
  const source = useLibraryVideo(sameAs !== null && canReadLibrary ? sameAs : null)
  const reference = useReference(canReadLibrary ? referenceId : null)
  const sourceReference = referenceId === null ? undefined : reference.data
  const sourceCard = sameAs === null ? undefined : source.data
  let sameStyleFailure: string | null = null
  if (activeSameStyle !== null) {
    if (!canReadLibrary) {
      sameStyleFailure = '当前账号没有查看资料库权限，无法做同款'
    } else if (referenceId !== null) {
      if (reference.isError && !reference.isFetching)
        sameStyleFailure = errorMessageOf(reference.error, '读取该参考视频失败，无法做同款')
    } else if (source.isError && !source.isFetching) {
      sameStyleFailure = errorMessageOf(source.error, '读取该视频失败，无法做同款')
    } else if (sourceCard?.canMakeSame === false) {
      sameStyleFailure = '该视频没有可用的制作文件，无法做同款'
    }
  }
  const [sameStyleNotice, setSameStyleNotice] = useState<{ message: string } | null>(null)
  if (sameStyleFailure !== null) {
    setSameStyle(null)
    setSameStyleNotice({ message: sameStyleFailure })
  }
  useEffect(() => {
    if (sameStyleNotice !== null) toast.error(sameStyleNotice.message)
  }, [sameStyleNotice])
  const collectionId = collections.some((item) => item.id === chosenCollectionId)
    ? chosenCollectionId
    : null
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
      toast.error('当前账号没有创作权限，无法开始创作')
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
    if (referenceId !== null && sourceReference === undefined) {
      toast.error('正在读取参考视频，请稍后再发送')
      return false
    }
    try {
      await start.mutateAsync({
        agentId,
        collectionId,
        parts,
        ...(sameAs === null ? {} : { sameAs }),
      })
      draft.clear()
      setSameStyle(null)
      return true
    } catch (error) {
      toast.error(errorMessageOf(error, '发送失败，请重试'))
      return false
    }
  }
  const agentLabel = !user
    ? '登录后可选择创作助手'
    : !canRun
      ? '当前账号没有创作权限'
      : agents.isPending
        ? '正在加载创作助手…'
        : agents.isError
          ? '创作助手加载失败'
          : chosenAgent
            ? chosenAgent.name
            : agentId
              ? '所选创作助手已不可用'
              : '暂无可用的创作助手'
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
                    <MenuItem key={item.id} onSelect={() => chooseAgent(item.id)}>
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
        connections={user && canRun && validAgent && agentId !== null ? { agentId } : undefined}
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
        draftParts={draft.initialParts}
        referenceUrl={sourceReference?.videoUrl}
        focusRequested={composerFocus?.pending}
        onFocusHandled={composerFocus?.consume}
        onDraftChange={draft.saveParts}
        onSend={send}
        sameStyle={
          activeSameStyle === null
            ? undefined
            : {
                onExit: () => setSameStyle(null),
                video:
                  sourceReference !== undefined
                    ? { aspectRatio: null, outputUrl: sourceReference.videoUrl, title: null }
                    : sourceCard?.canMakeSame === true
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
          void refreshConversationLists(queryClient, 'sidebar')
        }}
        open={newCollectionName !== null}
      />
    </>
  )
}
