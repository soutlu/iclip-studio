import { useState } from 'react'

export const useStableValue = <T>(value: T): T => {
  const key = JSON.stringify(value)
  const [stable, setStable] = useState({ key, value })
  if (stable.key === key) return stable.value
  setStable({ key, value })
  return value
}
