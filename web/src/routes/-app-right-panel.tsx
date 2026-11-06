import { useMatches } from '@tanstack/react-router'

export function AppRightPanel() {
  const matches = useMatches()
  const Panel = [...matches].reverse().find((match) => match.staticData.rightPanel !== undefined)
    ?.staticData.rightPanel

  return Panel === undefined ? null : <Panel />
}
