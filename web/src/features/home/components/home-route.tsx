import { HeroAnimation } from '@/shared/ui/hero'
import { HomeComposer } from './home-composer'
import type { HomeComposerProps } from './home-composer'
import { SameStyleHero, type SameStyleVideo } from './same-style-hero'

/** 首页在做同款：源视频（读回来之前为 null）与退出做同款的回调。 */
type HomeSameStyle = {
  video: SameStyleVideo | null
  onExit: () => void
}

type HomeRouteProps = Omit<HomeComposerProps, 'sameStyle'> & {
  /** 给了就是做同款：顶部换成源视频的封面，输入框换提示并带快捷词。 */
  sameStyle?: HomeSameStyle | undefined
}

/**
 * 首页：吉祥物 hero 自带 Cue 字标，标题只保留给读屏；做同款时 hero 换成源视频的封面。侧栏与业务控件由路由装配。
 * 紧凑屏（max-sm，与应用壳的 COMPACT_MAX 同为 600px）hero 缩小、内容贴顶上移，输入卡落在首屏上部。
 */
export function HomeRoute({ sameStyle, ...props }: HomeRouteProps) {
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-(--layout-home-read-max) flex-1 flex-col justify-center px-6 pb-[8vh] max-sm:justify-start max-sm:pt-28 max-sm:pb-6">
        {sameStyle === undefined ? (
          <div className="flex flex-col items-center pb-4">
            <HeroAnimation className="w-[min(640px,92vw)] animate-in duration-(--dur-l) fade-in max-sm:w-70" />
            <h1 className="sr-only">Cue</h1>
          </div>
        ) : (
          <div className="flex flex-col items-center pb-10 max-sm:pb-8">
            <SameStyleHero onExit={sameStyle.onExit} video={sameStyle.video} />
            <h1 className="sr-only">做同款</h1>
          </div>
        )}
        <HomeComposer {...props} sameStyle={sameStyle !== undefined} />
      </div>
    </main>
  )
}
