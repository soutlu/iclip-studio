import { HeroAnimation } from '@/shared/ui/hero'
import { HomeComposer } from './home-composer'
import type { HomeComposerProps } from './home-composer'
import { SameStyleHero, type SameStyleVideo } from './same-style-hero'

type HomeSameStyle = {
  video: SameStyleVideo | null
  onExit: () => void
}

type HomeRouteProps = Omit<HomeComposerProps, 'sameStyle' | 'onReferenceRemoved'> & {
  sameStyle?: HomeSameStyle | undefined
}

export function HomeRoute({ sameStyle, ...props }: HomeRouteProps) {
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-(--layout-home-read-max) flex-1 flex-col justify-center px-6 pb-[8vh] max-sm:justify-start max-sm:pt-28 max-sm:pb-6">
        {sameStyle === undefined ? (
          <div className="flex flex-col items-center pb-4">
            <HeroAnimation className="w-[min(640px,92vw)] animate-in duration-(--dur-l) fade-in max-sm:w-70" />
            <h1 className="sr-only">iClip</h1>
          </div>
        ) : (
          <div className="flex flex-col items-center pb-10 max-sm:pb-8">
            <SameStyleHero onExit={sameStyle.onExit} video={sameStyle.video} />
            <h1 className="sr-only">做同款</h1>
          </div>
        )}
        <HomeComposer
          {...props}
          onReferenceRemoved={sameStyle?.onExit}
          sameStyle={sameStyle !== undefined}
        />
      </div>
    </main>
  )
}
