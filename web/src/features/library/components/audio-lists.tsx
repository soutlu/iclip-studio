import { errorMessageOf } from '@/shared/api/client'
import type { AudioKind, AudioTraitFilter } from '@/shared/api/reference-audios'
import { AUDIO_KIND_LABELS } from '@/shared/ui/audition'
import { Button } from '@/shared/ui/button'
import { ListEmpty, ListError, ListPending, NextPageFooter } from '@/shared/ui/list-state'
import {
  useLatestReferenceAudios,
  useReferenceAudios,
  type ReferenceAudioTab,
} from '../reference-audios.api'
import { AudioTable, type AudioRowActions } from './audio-table'

const TOTAL_UNITS: Readonly<Record<ReferenceAudioTab, string>> = {
  voice: '个音色',
  bgm: '首配乐',
  sfx: '条音效',
  all: '条音频',
}

/** 工具行右边的条数：「共 9 个音色」，有筛选或关键词时「找到 N 个音色」。 */
const totalText = (kind: ReferenceAudioTab, total: number, filtered: boolean) =>
  `${filtered ? '找到' : '共'} ${String(total)} ${TOTAL_UNITS[kind]}`

const filteredOf = (q: string, traits: AudioTraitFilter) =>
  q.trim() !== '' ||
  Object.values(traits).some((values) => values !== undefined && values.length > 0)

type KindAudiosProps = {
  kind: AudioKind
  q: string
  traits: AudioTraitFilter
  actions: AudioRowActions
  canAdd: boolean
  getScrollElement: () => HTMLElement | null
}

/** 一个子类的列表：按关键词和属性筛，往下滚接着读。 */
export function KindAudios({
  kind,
  q,
  traits,
  actions,
  canAdd,
  getScrollElement,
}: KindAudiosProps) {
  const audios = useReferenceAudios(kind, q, traits)
  const items = audios.data?.pages.flatMap((page) => page.items) ?? []
  const total = audios.data?.pages[0]?.total ?? undefined
  const label = AUDIO_KIND_LABELS[kind]
  if (audios.isPending) return <ListPending label={`正在读取${label}`} />
  if (audios.isError && !audios.isFetchNextPageError)
    return (
      <ListError
        message={errorMessageOf(audios.error, '读取音频库失败')}
        onRetry={() => void audios.refetch()}
      />
    )
  if (items.length === 0)
    return (
      <ListEmpty icon="waveform">
        {filteredOf(q, traits)
          ? `暂无匹配的${label}，请更换关键词或清除筛选`
          : canAdd
            ? `暂无${label}，请点击「添加音频」`
            : `暂无${label}`}
      </ListEmpty>
    )
  return (
    <>
      <AudioTable actions={actions} items={items} kind={kind} label={label} />
      {audios.hasNextPage ? (
        audios.isFetchNextPageError && !audios.isFetchingNextPage ? (
          <ListError
            message={errorMessageOf(audios.error, '读取音频库失败')}
            onRetry={() => void audios.fetchNextPage()}
          />
        ) : (
          <NextPageFooter
            getScrollElement={getScrollElement}
            query={audios}
            shown={items.length}
            total={total}
          />
        )
      ) : null}
    </>
  )
}

/** 工具行右边的条数：和列表读同一份数据。 */
export function KindTotal({
  kind,
  q,
  traits,
}: {
  kind: AudioKind
  q: string
  traits: AudioTraitFilter
}) {
  const total = useReferenceAudios(kind, q, traits).data?.pages[0]?.total
  return total === undefined || total === null
    ? null
    : totalText(kind, total, filteredOf(q, traits))
}

/** 「全部」的条数：三段各自的条数加起来（有关键词时是匹配的条数）。 */
export function AllTotal({ q }: { q: string }) {
  const totals = useLatestReferenceAudios(q).map(({ query }) => query.data?.total ?? null)
  if (totals.some((total) => total === null)) return null
  const total = totals.reduce<number>((sum, each) => sum + (each ?? 0), 0)
  return totalText('all', total, q.trim() !== '')
}

type AllAudiosProps = {
  q: string
  actions: AudioRowActions
  canAdd: boolean
  onOpenKind: (kind: ReferenceAudioTab) => void
}

/** 「全部」：音色、配乐、音效三段，每段列最新几条，「查看全部」切到那个子类；没有的段不显示。 */
export function AllAudios({ q, actions, canAdd, onOpenKind }: AllAudiosProps) {
  const sections = useLatestReferenceAudios(q)
  if (sections.some(({ query }) => query.isPending)) return <ListPending label="正在读取音频" />
  const failed = sections.find(({ query }) => query.isError)
  if (failed !== undefined)
    return (
      <ListError
        message={errorMessageOf(failed.query.error, '读取音频库失败')}
        onRetry={() => void failed.query.refetch()}
      />
    )
  const shown = sections.filter(({ query }) => (query.data?.items.length ?? 0) > 0)
  if (shown.length === 0)
    return (
      <ListEmpty icon="waveform">
        {q.trim() !== ''
          ? '暂无匹配的音频，请更换关键词'
          : canAdd
            ? '暂无音频，请点击「添加音频」'
            : '暂无音频'}
      </ListEmpty>
    )
  return (
    <div className="flex flex-col gap-8">
      {shown.map(({ kind, query }) => (
        <section aria-label={AUDIO_KIND_LABELS[kind]} key={kind}>
          <header className="mb-1 flex items-center justify-between px-3">
            <h2 className="text-body font-medium text-on-surface">
              {AUDIO_KIND_LABELS[kind]}
              <span className="ml-2 font-normal text-on-surface-faint tabular-nums">
                {query.data?.total}
              </span>
            </h2>
            <Button
              aria-label={`查看全部${AUDIO_KIND_LABELS[kind]}`}
              onClick={() => onOpenKind(kind)}
              size="md"
              trailingIcon="disclosure"
              variant="ghost"
            >
              查看全部
            </Button>
          </header>
          <AudioTable
            actions={actions}
            items={query.data?.items ?? []}
            kind={kind}
            label={AUDIO_KIND_LABELS[kind]}
          />
        </section>
      ))}
    </div>
  )
}
