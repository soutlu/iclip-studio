type VideoModelProfile = {
  matches: RegExp
  shortName: string
  unsupportedAspectRatios: readonly string[]
}

/** 认得的视频模型：按 id 匹配短名与不支持的画幅；表的顺序就是出片栏里的显示顺序。 */
const PROFILES: readonly VideoModelProfile[] = [
  { matches: /wan3/, shortName: 'wan3', unsupportedAspectRatios: ['21:9'] },
  { matches: /seedance-2-5-flash/, shortName: 'sd2.5flash', unsupportedAspectRatios: [] },
  { matches: /seedance-2-5(?!-flash)/, shortName: 'sd2.5', unsupportedAspectRatios: [] },
]

const rankOf = (model: string): number => {
  const rank = PROFILES.findIndex((profile) => profile.matches.test(model))
  return rank === -1 ? PROFILES.length : rank
}

/** 出片栏里显示的短名；不认识的模型显示完整 id。 */
export const videoModelShortName = (model: string): string =>
  PROFILES[rankOf(model)]?.shortName ?? model

/** 按表的顺序排列模型；不认识的排在最后，彼此保持原来的先后。 */
export const orderVideoModels = (models: readonly string[]): string[] =>
  models.toSorted((a, b) => rankOf(a) - rankOf(b))

export const supportsAspectRatio = (model: string | undefined, aspectRatio: string): boolean =>
  model === undefined ||
  !(PROFILES[rankOf(model)]?.unsupportedAspectRatios.includes(aspectRatio) ?? false)
