/** 「替换当前帧」与随后 6 秒的撤销。 */

import { useEffect, useRef, useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'

const UNDO_MS = 6000

type FrameReplaceOptions = {
  /** 分镜里这一帧此刻的图；帧已经不在分镜里时为空。 */
  currentUrl: string | undefined
  /** 把这一帧从 `previousUrl` 换成 `url`；这一帧已不是 `previousUrl` 时应当拒绝。 */
  onApply: (previousUrl: string, url: string) => Promise<void>
}

/**
 * 替换与撤销都经 `onApply` 写回：撤销就是反方向再换一次，`onApply(applied, previous)`。
 *
 * 换之前要说清「从哪张换走」，拿的是用户确认过的当前帧（见 `acknowledge`），不是渲染时的那张。
 * 进行中再点不会重复写；卸载时撤销入口随之消失。
 */
export function useFrameReplace({ currentUrl, onApply }: FrameReplaceOptions) {
  // 用户确认过的当前帧，替换时拿它当凭据。
  //
  // 不能跟着渲染走：这一帧被 agent 换掉时，版本条上那一小格会悄悄改一张图，用户盯着结果
  // 根本不会发现，跟着走等于没有守卫，会直接盖掉别人刚写的。也不能锁死在打开那一刻，否则
  // 替换完窗口留着就再也对不上。所以只在用户确实看过这一格时更新：翻版本条、自己替换或撤销成功、
  // 以及被拒绝一次之后。
  const acknowledgedRef = useRef<string | undefined>(undefined)
  acknowledgedRef.current ??= currentUrl
  const busyRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [pending, setPending] = useState<'replace' | 'undo' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [undoable, setUndoable] = useState<{ applied: string; previous: string } | null>(null)

  useEffect(() => () => clearTimeout(timerRef.current), [])

  /** 写回一次；成功后认下新图，失败时认下此刻的当前帧（多半是这一帧被别人换过了），用户再点就是冲着它去的。 */
  const write = async (
    kind: 'replace' | 'undo',
    previous: string,
    url: string,
    fallback: string,
  ): Promise<boolean> => {
    busyRef.current = true
    setPending(kind)
    setError(null)
    try {
      await onApply(previous, url)
      acknowledgedRef.current = url
      return true
    } catch (cause) {
      acknowledgedRef.current = currentUrl
      setError(errorMessageOf(cause, fallback))
      return false
    } finally {
      busyRef.current = false
      setPending(null)
    }
  }

  /** 把这一帧换成 `url`；返回是否换成了。 */
  const replace = async (url: string): Promise<boolean> => {
    const previous = acknowledgedRef.current ?? currentUrl
    if (busyRef.current || previous === undefined) return false
    if (!(await write('replace', previous, url, '没替换成功，请重试'))) return false
    clearTimeout(timerRef.current)
    setUndoable({ applied: url, previous })
    timerRef.current = setTimeout(() => setUndoable(null), UNDO_MS)
    return true
  }

  const undo = async () => {
    if (busyRef.current || undoable === null) return
    // 撤销失败时入口留着，计时照走：多半是网络抖了，还来得及再点。
    if (!(await write('undo', undoable.applied, undoable.previous, '没撤销成功，请重试'))) return
    clearTimeout(timerRef.current)
    setUndoable(null)
  }

  /** 用户翻版本条时正好看见了当前帧那一格；上一处的替换错误随之作废。 */
  const acknowledge = () => {
    acknowledgedRef.current = currentUrl
    setError(null)
  }

  return { acknowledge, error, pending, replace, undo, undoable: undoable !== null }
}
