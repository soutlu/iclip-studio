import { describe, expect, it } from 'vitest'
import {
  librarySearchSchema,
  referenceAudioScopeFromSearch,
  searchFromReferenceAudioScope,
} from './-library-search'

describe('音频库的地址参数', () => {
  it('子类不写是音色，「全部」写成 all；属性每项一个值，读回来一样', () => {
    const voice = { kind: 'voice' as const, q: '', traits: { locale: 'en' as const } }
    const search = searchFromReferenceAudioScope(voice)
    expect(search).toMatchObject({ audioKind: undefined, locale: 'en', tab: 'audios' })
    expect(referenceAudioScopeFromSearch(librarySearchSchema.parse(search))).toEqual(voice)

    const all = searchFromReferenceAudioScope({ kind: 'all', q: '吉他', traits: {} })
    expect(all).toMatchObject({ audioKind: 'all', q: '吉他' })
  })

  it('只留当前子类用得上的属性，认不出的值和重复给了几个的整项丢掉', () => {
    const search = librarySearchSchema.parse({
      audioKind: 'bgm',
      gender: 'male',
      genre: ['piano', 'electronic'],
      mood: 'warm',
      tempo: 'very-fast',
    })
    expect(referenceAudioScopeFromSearch(search)).toEqual({
      kind: 'bgm',
      q: '',
      traits: { mood: 'warm' },
    })
  })
})
