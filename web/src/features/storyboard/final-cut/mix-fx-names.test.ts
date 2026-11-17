import { HF_AUDIO_FX } from '@hyperframes/core/audio-fx'
import { HF_AUDIO_EQ_3 } from '@hyperframes/core/audio-fx-eq'
import {
  HF_AUDIO_FX_PRESET_FAMILIES,
  HF_AUDIO_FX_PRESETS,
} from '@hyperframes/core/audio-fx-presets'
import { describe, expect, it } from 'vitest'
import { ADDABLE_EFFECTS } from './mix-fx'
import { EFFECT_NAMES, EQ_BAND_NAMES, PRESET_FAMILY_NAMES, PRESET_NAMES } from './mix-fx-names'

const hasChinese = (text: string | undefined) => /\p{Script=Han}/u.test(text ?? '')

describe('中文名表', () => {
  it('core 的每一类预设、每个预设都有中文名和说明', () => {
    for (const family of HF_AUDIO_FX_PRESET_FAMILIES)
      expect(hasChinese(PRESET_FAMILY_NAMES[family]), family).toBe(true)
    for (const { id } of HF_AUDIO_FX_PRESETS) {
      expect(hasChinese(PRESET_NAMES[id]?.label), id).toBe(true)
      expect(hasChinese(PRESET_NAMES[id]?.description), id).toBe(true)
    }
    expect(Object.keys(PRESET_NAMES).toSorted()).toEqual(
      HF_AUDIO_FX_PRESETS.map((preset) => preset.id).toSorted(),
    )
  })

  it('能加的七种效果都在 core 里；core 的每个效果、每个参数、每个枚举选项都有中文名', () => {
    const ids = HF_AUDIO_FX.map((def) => def.id)
    for (const type of ADDABLE_EFFECTS) expect(ids).toContain(type)
    for (const def of HF_AUDIO_FX) {
      const names = EFFECT_NAMES[def.id]
      expect(hasChinese(names?.label), def.id).toBe(true)
      expect(hasChinese(names?.description), def.id).toBe(true)
      for (const param of def.params) {
        const where = `${def.id}.${param.key}`
        expect(hasChinese(names?.params[param.key]), where).toBe(true)
        if (param.kind !== 'enum') continue
        for (const option of param.options)
          expect(
            names?.options?.[param.key]?.[option.value],
            `${where}=${option.value}`,
          ).toBeTruthy()
      }
    }
  })

  it('三段均衡的每段都有中文名', () => {
    for (const band of HF_AUDIO_EQ_3)
      expect(hasChinese(EQ_BAND_NAMES[band.name]), band.name).toBe(true)
  })
})
