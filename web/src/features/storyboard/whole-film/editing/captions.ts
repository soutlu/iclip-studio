import { toOffset, type CaptionEdit, type WholeFilmDraft } from './draft'
import { done, type EditResult } from './result'

// 字幕放进整片的位置由合成构建算（composition/captions.ts 的 placeCaptions），这里只改草稿。

const sameSentence = (edit: CaptionEdit, subtitleJobId: string, sentenceIndex: number) =>
  edit.subtitleJobId === subtitleJobId && edit.sentenceIndex === sentenceIndex

/** 改一句字幕的字；改动按字幕记录与句序记，重新识别换了记录后不再生效 */
export const setCaptionText = (draft: WholeFilmDraft, args: CaptionEdit): EditResult => {
  const edit = { ...args }
  const exists = draft.captions.edits.some((e) =>
    sameSentence(e, args.subtitleJobId, args.sentenceIndex),
  )
  const edits = exists
    ? draft.captions.edits.map((e) =>
        sameSentence(e, args.subtitleJobId, args.sentenceIndex) ? edit : e,
      )
    : [...draft.captions.edits, edit]
  return done({ ...draft, captions: { ...draft.captions, edits } })
}

/** 撤掉一句的改字，回到识别结果 */
export const clearCaptionText = (
  draft: WholeFilmDraft,
  args: { subtitleJobId: string; sentenceIndex: number },
): EditResult => {
  const edits = draft.captions.edits.filter(
    (e) => !sameSentence(e, args.subtitleJobId, args.sentenceIndex),
  )
  return done(
    edits.length === draft.captions.edits.length
      ? draft
      : { ...draft, captions: { ...draft.captions, edits } },
  )
}

/** 整片关掉或打开字幕；样式与改过的字不动 */
export const setCaptionsHidden = (draft: WholeFilmDraft, args: { hidden: boolean }): EditResult =>
  done(
    // 有这个字段之前存的草稿没写它，按开着算
    args.hidden === (draft.captions.hidden ?? false)
      ? draft
      : { ...draft, captions: { ...draft.captions, hidden: args.hidden } },
  )

/**
 * 在画面上挪字幕：整片字幕共用一个位置。x、y 是画面像素，取整并裁在 ±4096 以内；
 * 位置没变时原样返回
 */
export const setCaptionsPosition = (
  draft: WholeFilmDraft,
  args: { x: number; y: number },
): EditResult => {
  const x = toOffset(args.x)
  const y = toOffset(args.y)
  // 有位置之前存的草稿没写 x、y，按没挪过算
  return done(
    x === (draft.captions.x ?? 0) && y === (draft.captions.y ?? 0)
      ? draft
      : { ...draft, captions: { ...draft.captions, x, y } },
  )
}

/** 换字幕样式（组件库里的字幕组件） */
export const setCaptionStyle = (draft: WholeFilmDraft, args: { component: string }): EditResult =>
  done(
    args.component === draft.captions.component
      ? draft
      : { ...draft, captions: { ...draft.captions, component: args.component } },
  )
