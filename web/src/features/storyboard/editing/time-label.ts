export const timeLabel = (seconds: number): string => {
  const safe = Math.max(0, seconds)
  const minutes = Math.floor(safe / 60)
    .toString()
    .padStart(2, '0')
  return `${minutes}:${(safe % 60).toFixed(2).padStart(5, '0')}`
}

export const roundSeconds = (seconds: number): number => Math.round(seconds * 100) / 100
