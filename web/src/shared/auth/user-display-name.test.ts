import { describe, expect, it } from 'vitest'
import { userDisplayName } from './user-display-name'

describe('userDisplayName', () => {
  it.each([
    [{ displayName: '洪莎', username: 'Sara.Hong' }, '洪莎'],
    [{ displayName: '', username: 'Sara.Hong' }, 'Sara.Hong'],
    [{ displayName: '', username: null }, '用户'],
    [{ displayName: '', username: '' }, '用户'],
    [null, '用户'],
    [undefined, '用户'],
  ])('%j → %s', (user, name) => {
    expect(userDisplayName(user)).toBe(name)
  })
})
