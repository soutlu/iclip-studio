import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { saveBrandProfile, type BrandProfile } from '@/shared/api/brand-templates'
import { errorMessageOf } from '@/shared/api/client'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/field'
import { toast } from '@/shared/ui/toast'
import { isAccentColor } from '../brand-templates'

// design-allow -- 原生取色器只认 #rrggbb，没填强调色时也得给它一个初值；该值不会被保存
const PICKER_FALLBACK = '#000000'

const CARD_CLASS = 'flex min-w-0 flex-col gap-3 rounded-md border border-outline-variant p-4'

type Props = {
  profile: BrandProfile
  canManage: boolean
  onSaved: () => Promise<void>
}

/** 一个品牌的标语与强调色；治理者在卡片里直接改，不开弹窗。 */
export function BrandProfileCard({ profile, canManage, onSaved }: Props) {
  const [editing, setEditing] = useState(false)
  return (
    <article aria-label={`品牌：${profile.brand}`} className={CARD_CLASS}>
      <div className="flex min-h-(--control-height-md) items-center justify-between gap-2">
        <h3 className="min-w-0 truncate text-body font-medium">{profile.brand}</h3>
        {canManage && !editing ? (
          <Button onClick={() => setEditing(true)} size="md" variant="ghost">
            编辑
          </Button>
        ) : null}
      </div>
      {editing ? (
        <BrandProfileForm
          profile={profile}
          onCancel={() => setEditing(false)}
          onSaved={async () => {
            await onSaved()
            setEditing(false)
          }}
        />
      ) : (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-body-sm">
          <dt className="text-on-surface-variant">标语</dt>
          <dd className="min-w-0 break-words">
            {profile.slogan ?? <span className="text-on-surface-faint">暂无标语</span>}
          </dd>
          <dt className="text-on-surface-variant">强调色</dt>
          <dd className="flex min-w-0 items-center gap-2">
            {profile.accentColor === null ? (
              <span className="text-on-surface-faint">暂无强调色</span>
            ) : (
              <>
                <AccentSwatch color={profile.accentColor} />
                <span className="font-mono uppercase">{profile.accentColor}</span>
              </>
            )}
          </dd>
        </dl>
      )}
    </article>
  )
}

/** 新建品牌的卡片：填品牌名、标语与强调色；品牌名已存在时保存的是那个品牌。 */
export function NewBrandProfileCard({
  existingBrands,
  onCancel,
  onSaved,
}: {
  existingBrands: readonly string[]
  onCancel: () => void
  onSaved: () => Promise<void>
}) {
  return (
    <article aria-label="添加品牌" className={CARD_CLASS}>
      <div className="flex min-h-(--control-height-md) items-center">
        <h3 className="text-body font-medium">添加品牌</h3>
      </div>
      <BrandProfileForm
        profile={null}
        existingBrands={existingBrands}
        onCancel={onCancel}
        onSaved={onSaved}
      />
    </article>
  )
}

function AccentSwatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="size-4 shrink-0 rounded-full border border-outline-variant bg-(--brand-accent)"
      style={{ '--brand-accent': color } as CSSProperties}
    />
  )
}

function BrandProfileForm({
  profile,
  existingBrands = [],
  onCancel,
  onSaved,
}: {
  /** 为 null 时是新建，表单多一个品牌名。 */
  profile: BrandProfile | null
  existingBrands?: readonly string[]
  onCancel: () => void
  onSaved: () => Promise<void>
}) {
  const formId = useId()
  const nameRef = useRef<HTMLInputElement>(null)
  // 「添加品牌」按钮点下后即收起，焦点交给品牌名，键盘可以接着填。
  useEffect(() => nameRef.current?.focus(), [])
  const [name, setName] = useState('')
  const [slogan, setSlogan] = useState(profile?.slogan ?? '')
  const [accent, setAccent] = useState(profile?.accentColor ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const typedName = name.trim()
  const nameTaken = profile === null && existingBrands.includes(typedName)
  const typedAccent = accent.trim()
  const accentInvalid = typedAccent !== '' && !isAccentColor(typedAccent)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    const brand = profile?.brand ?? typedName
    if (brand === '') {
      setError('品牌名为空，无法保存；请填写品牌名')
      return
    }
    if (accentInvalid) {
      setError('强调色格式不正确，无法保存；请填写 #RRGGBB 格式的色值')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await saveBrandProfile(brand, {
        slogan: slogan.trim() || null,
        accentColor: typedAccent === '' ? null : typedAccent,
      })
      toast.success('已保存品牌设置')
      await onSaved()
    } catch (cause) {
      setError(errorMessageOf(cause, '保存品牌设置失败，请重试'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
      {profile === null ? (
        <div className="flex flex-col gap-2 text-body-sm">
          <label htmlFor={`${formId}-name`}>品牌名</label>
          <Input
            id={`${formId}-name`}
            aria-describedby={nameTaken ? `${formId}-name-taken` : undefined}
            ref={nameRef}
            disabled={busy}
            maxLength={100}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
          />
          {nameTaken ? (
            <p id={`${formId}-name-taken`} role="status" className="text-on-surface-variant">
              该品牌已存在，保存后将覆盖其标语与强调色
            </p>
          ) : null}
        </div>
      ) : null}
      <label className="flex flex-col gap-2 text-body-sm" htmlFor={`${formId}-slogan`}>
        标语
        <Input
          id={`${formId}-slogan`}
          disabled={busy}
          maxLength={100}
          placeholder="可选"
          value={slogan}
          onChange={(event) => setSlogan(event.currentTarget.value)}
        />
      </label>
      <div className="flex flex-col gap-2 text-body-sm">
        <label htmlFor={`${formId}-accent`}>强调色</label>
        <div className="flex items-center gap-2">
          <input
            aria-label="选择强调色"
            className="h-(--control-height-xl) w-12 shrink-0 cursor-pointer rounded-lg border border-input-border bg-input-bg p-1 ui-focus disabled:cursor-not-allowed"
            disabled={busy}
            type="color"
            value={isAccentColor(typedAccent) ? typedAccent.toLowerCase() : PICKER_FALLBACK}
            onChange={(event) => setAccent(event.currentTarget.value)}
          />
          <Input
            id={`${formId}-accent`}
            aria-invalid={accentInvalid}
            className="font-mono"
            disabled={busy}
            maxLength={7}
            placeholder="#RRGGBB，可选"
            spellCheck={false}
            value={accent}
            onChange={(event) => setAccent(event.currentTarget.value)}
          />
        </div>
      </div>
      {error === null ? null : (
        <p role="alert" className="text-body-sm text-error">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button disabled={busy} onClick={onCancel} size="md" type="button" variant="ghost">
          取消
        </Button>
        <Button loading={busy} size="md" type="submit" variant="tonal">
          {busy ? '正在保存…' : '保存品牌设置'}
        </Button>
      </div>
    </form>
  )
}
