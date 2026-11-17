import type { HfAudioFxPresetFamily } from '@hyperframes/core/audio-fx-presets'

/**
 * 预设、效果和效果参数在界面上的中文名，按 core 的编号查（core 自己只有英文）。原型里有的用原型的字，
 * 原型里没有的照它的写法补上。`mix-fx-names.test.ts` 查 core 里的每个预设、效果、参数、选项都有中文名。
 */

/** 预设的四类。 */
export const PRESET_FAMILY_NAMES: Record<HfAudioFxPresetFamily, string> = {
  voice: '人声美化',
  repair: '瑕疵修复',
  character: '风格音色',
  space: '空间混响',
}

/** 预设：名字一行，说明一行。 */
export const PRESET_NAMES: Record<string, { label: string; description: string }> = {
  'voice-clean': { label: '纯净人声', description: '滤除环境嗡鸣与闷浊，提亮说话吐字清晰度' },
  'voice-broadcast': { label: '电台播客', description: '声音更紧实靠前，呈现厚实稳重的口播质感' },
  'voice-warm': { label: '贴耳温暖', description: '保留近讲呼吸感与柔和低频，轻度修饰不过度压缩' },
  'rumble-cut': { label: '消除底噪', description: '切掉空调、风声与手持触碰产生的低频轰鸣' },
  'room-gate': { label: '停顿静音门', description: '自动收干净说话停顿间隙的底噪与呼吸声' },
  'boom-tame': { label: '抑制闷音', description: '削弱离麦过近导致的胸腔浑浊共鸣' },
  'harsh-tame': { label: '柔和齿音', description: '磨圆生硬刺耳的中高频毛刺感' },
  telephone: { label: '电话音色', description: '模拟电话听筒中频聚焦的窄带通话声' },
  'radio-am': { label: '老收音机', description: '复古调幅广播颗粒质感，适合转场点缀' },
  megaphone: { label: '扩音喇叭', description: '模拟街头喊话筒带短促反射的声场' },
  'lofi-tape': { label: '温暖磁带', description: '温暖微饱和与复古磁带松弛感，铺底不抢戏' },
  'pa-system': { label: '大厅广播', description: '车站大厅里的广播通知，带一点空旷回响' },
  intercom: { label: '门禁对讲', description: '隔着门口对讲面板传出的窄带声，带开关杂音' },
  'doofus-worble': { label: '晕船颤音', description: '左右摇晃的颤动声，听不到一点原本的音高' },
  chipmunk: { label: '花栗鼠', description: '音调升高，又小又快的尖细嗓音' },
  giant: { label: '巨人', description: '音调降低，庞大低沉的慢嗓音' },
  monster: { label: '怪兽', description: '低沉粗粝、像贴在身后低吼' },
  'room-tight': { label: '紧凑小厅', description: '短促干净的近场空间感，不拖泥带水' },
  'room-natural': { label: '自然空间', description: '注入轻柔室内空气感，摆脱干瘪贴脸感' },
  hall: { label: '开阔大厅', description: '悠长绵延的空间尾音，适合情绪铺垫' },
  'slap-echo': { label: '短促回声', description: '干脆利落的单次短延迟反射' },
  'dub-throw': { label: '拖尾回声', description: '一串跟在节拍后面慢慢消失的回声' },
}

type EffectName = {
  label: string
  description: string
  /** 参数的中文名，按参数的 `key`。 */
  params: Record<string, string>
  /** 枚举参数各选项的中文名：参数的 `key` → 选项的值 → 中文名。 */
  options?: Record<string, Record<string, string>>
}

const SLOPE = { '1': '6 dB/倍频程', '2': '12 dB/倍频程' }

/** 效果：名字、一句说明、参数名。 */
export const EFFECT_NAMES: Record<string, EffectName> = {
  gain: { label: '音量', description: '整体调大或调小', params: { gain: '增益' } },
  peaking: {
    label: '单段均衡',
    description: '提升或衰减一段频率，两边不动',
    params: { frequency: '频率', gain: '增益', q: '带宽 Q' },
  },
  lowshelf: {
    label: '低频提升衰减',
    description: '整体提升或衰减某个频率以下的声音',
    params: { frequency: '转折频率', gain: '增益' },
  },
  highshelf: {
    label: '高频提升衰减',
    description: '整体提升或衰减某个频率以上的声音',
    params: { frequency: '转折频率', gain: '增益' },
  },
  highpass: {
    label: '低切滤除嗡鸣',
    description: '切除指定频率以下的脚步、空调与风噪低频',
    params: { frequency: '切除频率', q: '转折锐度', poles: '斜率' },
    options: { poles: SLOPE },
  },
  lowpass: {
    label: '隔门闷音过滤',
    description: '柔化高频，营造隔墙或水下朦胧氛围',
    params: { frequency: '保留频率', q: '转折锐度', poles: '斜率' },
    options: { poles: SLOPE },
  },
  compressor: {
    label: '动态响度压缩',
    description: '压住突兀大声、托起轻声细节，让动态更紧实',
    params: {
      threshold: '阈值',
      ratio: '压缩比',
      attack: '启动',
      release: '释放',
      knee: '拐点',
      makeup: '补偿增益',
      mix: '混合',
    },
  },
  limiter: {
    label: '峰值限制',
    description: '跟着电平压住峰值，快的峰值可能漏过',
    params: { limit: '上限', attack: '启动', release: '释放', level_out: '输出增益' },
  },
  truepeak: {
    label: '防爆音峰值限制',
    description: '自定义真峰值上限，严防多轨叠加破音',
    params: { ceiling: '真峰值上限', lookahead: '预读', release: '释放' },
  },
  gate: {
    label: '噪声门',
    description: '声音低于阈值时自动收掉',
    params: {
      threshold: '阈值',
      range: '收掉深度',
      ratio: '比例',
      attack: '启动',
      release: '释放',
      knee: '拐点',
    },
  },
  saturate: {
    label: '温暖磁感饱和',
    description: '增加模拟设备般的温暖谐波厚度',
    params: { type: '曲线', threshold: '阈值', output: '输出增益', oversample: '过采样' },
    options: {
      type: {
        tanh: '柔和（双曲正切）',
        atan: '圆润（反正切）',
        cubic: '三次',
        exp: '指数',
        alg: '代数',
        quintic: '五次',
        sin: '正弦',
        erf: '误差函数',
        hard: '硬削波',
      },
    },
  },
  bitcrush: {
    label: '数码颗粒',
    description: '降低位深和采样率，做出低保真的数码声',
    params: { bits: '位深', samples: '采样保持', mix: '混合' },
  },
  pitchshift: {
    label: '升降调',
    description: '不改速度，升高或降低音调',
    params: { semitones: '半音', mix: '混合' },
  },
  delay: {
    label: '节奏回声延迟',
    description: '在尾音后生成节奏回响反馈',
    params: { time: '间隔', feedback: '反馈', mix: '混合' },
  },
  chorus: {
    label: '合唱',
    description: '叠几层略微走音的副本，声音更宽更厚',
    params: { delay: '延迟', depth: '深度', speed: '速率', mix: '混合' },
  },
  phaser: {
    label: '相位',
    description: '一道道凹口在频谱里来回扫',
    params: {
      in_gain: '输入',
      out_gain: '输出',
      delay: '延迟',
      decay: '衰减',
      speed: '速率',
      type: '波形',
    },
    options: { type: { '0': '三角波', '1': '正弦波' } },
  },
  reverb: {
    label: '空间混响',
    description: '自由调节干湿声空间纵深占比',
    params: { size: '空间大小', damping: '高频衰减', wet: '湿声', dry: '干声' },
  },
}

/** 三段均衡各段的中文名，按 core 的段名。 */
export const EQ_BAND_NAMES: Record<string, string> = {
  Bass: '低频',
  Middle: '中频',
  Treble: '高频',
}
