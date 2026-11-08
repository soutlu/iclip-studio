const UNSUPPORTED: readonly { matches: RegExp; aspectRatios: readonly string[] }[] = [
  // 万相 3.0 不支持 21:9 画幅。
  { matches: /wan3/, aspectRatios: ['21:9'] },
]

export const supportsAspectRatio = (model: string | undefined, aspectRatio: string): boolean =>
  model === undefined ||
  !UNSUPPORTED.some(
    (entry) => entry.matches.test(model) && entry.aspectRatios.includes(aspectRatio),
  )
