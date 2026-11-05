import { MAX_VOLUME } from './editing/draft'

export const FADER_MIN = -100
export const FADER_MAX = 100
const MIN_DB = -60
const MAX_DB = 12

const dbToGain = (db: number) => 10 ** (db / 20)
const gainToDb = (gain: number) => 20 * Math.log10(gain)
const clampGain = (gain: number) => Math.min(MAX_VOLUME, Math.max(0, gain))

export const faderToGain = (position: number): number => {
  const p = Math.min(FADER_MAX, Math.max(FADER_MIN, position))
  if (p === FADER_MIN) return 0
  const db = p < 0 ? (p / -FADER_MIN) * -MIN_DB : (p / FADER_MAX) * MAX_DB
  return Number(clampGain(dbToGain(db)).toFixed(6))
}

export const gainToFader = (gain: number): number => {
  const safe = clampGain(gain)
  if (safe === 0) return FADER_MIN
  const db = gainToDb(safe)
  const p = db < 0 ? (db / -MIN_DB) * -FADER_MIN : (db / MAX_DB) * FADER_MAX
  return Math.min(FADER_MAX, Math.max(FADER_MIN, p))
}

export const gainText = (gain: number): string => {
  if (gain <= 0) return '静音'
  const db = Math.round(gainToDb(clampGain(gain)) * 10) / 10
  if (Math.abs(db) < 0.05) return '0 dB'
  return `${db > 0 ? '+' : '−'}${String(Math.abs(db))} dB`
}

export const stepGain = (gain: number, deltaDb: number): number => {
  if (gain <= 0) return deltaDb > 0 ? Number(dbToGain(MIN_DB).toFixed(6)) : 0
  const db = Math.round((gainToDb(gain) + deltaDb) * 2) / 2
  if (db < MIN_DB) return 0
  return Number(clampGain(dbToGain(Math.min(MAX_DB, db))).toFixed(6))
}
