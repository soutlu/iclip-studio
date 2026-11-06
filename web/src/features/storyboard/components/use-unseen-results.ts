import { useState } from 'react'

type Tracked = {
  readonly inFlight: ReadonlySet<string>
  readonly opened: ReadonlySet<string>
}

const withAll = (set: ReadonlySet<string>, ids: readonly string[]): ReadonlySet<string> =>
  ids.every((id) => set.has(id)) ? set : new Set([...set, ...ids])

export function useUnseenResults(inFlight: readonly string[], landed: string | undefined) {
  const [tracked, setTracked] = useState<Tracked>(() => ({
    inFlight: new Set(),
    opened: new Set(),
  }))

  const next: Tracked = {
    inFlight: withAll(tracked.inFlight, inFlight),
    opened: withAll(tracked.opened, landed === undefined ? [] : [landed]),
  }
  if (next.inFlight !== tracked.inFlight || next.opened !== tracked.opened) setTracked(next)

  const isUnseen = (id: string) => next.inFlight.has(id) && !next.opened.has(id)

  return { isUnseen, opened: next.opened }
}
