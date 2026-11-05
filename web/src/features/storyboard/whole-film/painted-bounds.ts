import { elementPaintsInk, INTRINSIC_PAINT_TAGS } from '@hyperframes/sdk/adapters/iframe'

type ContentWindow = Window & typeof globalThis

export type Box = { left: number; top: number; width: number; height: number }

export function isShown(element: Element, win: ContentWindow): boolean {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    const style = win.getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    if (Number.parseFloat(style.opacity) === 0) return false
  }
  return true
}

export function painterAt(
  stack: readonly Element[],
  win: ContentWindow,
  point: { x: number; y: number },
): Element | null {
  return (
    stack.find((element) => isShown(element, win) && elementPaintsInk(element, win, point)) ?? null
  )
}

export function ownerOf<T>(element: Element, resolve: (hfId: string) => T | undefined) {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    const hfId = node.getAttribute('data-hf-id')
    if (hfId === null) continue
    const owner = resolve(hfId)
    if (owner !== undefined) return { owner, element: node }
  }
  return undefined
}

export function hitAt<T>(
  stack: readonly Element[],
  win: ContentWindow,
  point: { x: number; y: number },
  resolve: (hfId: string) => T | undefined,
): T | null {
  const painter = painterAt(stack, win, point)
  return painter === null ? null : (ownerOf(painter, resolve)?.owner ?? null)
}

const PICKABLE = '@layer iclip-canvas-pick{*{pointer-events:auto!important}}'

export function stackAt(doc: Document, win: ContentWindow, x: number, y: number): Element[] {
  // CSSStyleSheet 须在目标 iframe 的 window 上构造，方可挂载至其 adoptedStyleSheets。
  const sheet = new win.CSSStyleSheet()
  sheet.replaceSync(PICKABLE)
  doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet]
  try {
    return doc.elementsFromPoint(x, y)
  } finally {
    doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((item) => item !== sheet)
  }
}

// SVG 标签名区分大小写（如 clipPath、foreignObject）。
const SVG_SHAPES =
  'path, rect, circle, ellipse, line, polyline, polygon, text, image, use, foreignObject'
const SVG_RESOURCES = 'defs, clipPath, mask, pattern, symbol, marker'
const SVG_REFERENCES = new Set(['image', 'use', 'foreignobject'])

const hasArea = (rect: DOMRect) => rect.width > 0 && rect.height > 0

const paints = (paint: string) => paint !== 'none' && !isTransparent(paint)

function svgShapeRects(svg: Element, win: ContentWindow): DOMRect[] {
  const rects = [...svg.querySelectorAll(SVG_SHAPES)]
    .filter((shape) => {
      if (shape.parentElement?.closest(SVG_RESOURCES)) return false
      if (!SVG_REFERENCES.has(shape.tagName.toLowerCase())) {
        const style = win.getComputedStyle(shape)
        if (!paints(style.fill) && !paints(style.stroke)) return false
      }
      return isShown(shape, win)
    })
    .map((shape) => shape.getBoundingClientRect())
    .filter(hasArea)
  return rects.length > 0 ? rects : [svg.getBoundingClientRect()]
}

const BORDER_SIDES = ['top', 'right', 'bottom', 'left'] as const

const isTransparent = (color: string) => {
  if (color === '' || color === 'transparent') return true
  const alpha = /^(?:rgba?|hsla?)\(([^)]*)\)$/
    .exec(color)?.[1]
    ?.split(/[\s,/]+/)
    .filter(Boolean)[3]
  return alpha !== undefined && Number.parseFloat(alpha) === 0
}

function paintsOnlyText(element: Element, win: ContentWindow): boolean {
  if (INTRINSIC_PAINT_TAGS.has(element.tagName.toLowerCase())) return false
  const style = win.getComputedStyle(element)
  if (!isTransparent(style.backgroundColor)) return false
  if (style.backgroundImage !== '' && style.backgroundImage !== 'none') return false
  return BORDER_SIDES.every((side) => {
    const line = style.getPropertyValue(`border-${side}-style`)
    const width = Number.parseFloat(style.getPropertyValue(`border-${side}-width`) || '0')
    return line === '' || line === 'none' || line === 'hidden' || !(width > 0)
  })
}

function ownTextRects(element: Element): DOMRect[] {
  const range = element.ownerDocument.createRange()
  return [...element.childNodes]
    .filter((node) => node.nodeType === node.TEXT_NODE && (node.textContent ?? '').trim() !== '')
    .flatMap((node) => {
      range.selectNodeContents(node)
      return [...range.getClientRects()]
    })
    .filter(hasArea)
}

function inkRects(element: Element, win: ContentWindow): DOMRect[] {
  if (element.tagName.toLowerCase() === 'svg') return svgShapeRects(element, win)
  if (paintsOnlyText(element, win)) return ownTextRects(element)
  const rect = element.getBoundingClientRect()
  return hasArea(rect) ? [rect] : []
}

export function paintedBounds(
  roots: readonly Element[],
  win: ContentWindow,
  frame: { width: number; height: number },
): Box | null {
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const root of roots) {
    for (const element of [root, ...root.querySelectorAll('*')]) {
      if (element.parentElement?.closest('svg')) continue
      if (!hasArea(element.getBoundingClientRect())) continue
      if (!elementPaintsInk(element, win) || !isShown(element, win)) continue
      for (const rect of inkRects(element, win)) {
        left = Math.min(left, rect.left)
        top = Math.min(top, rect.top)
        right = Math.max(right, rect.right)
        bottom = Math.max(bottom, rect.bottom)
      }
    }
  }
  left = Math.max(left, 0)
  top = Math.max(top, 0)
  right = Math.min(right, frame.width)
  bottom = Math.min(bottom, frame.height)
  if (right <= left || bottom <= top) return null
  return { left, top, width: right - left, height: bottom - top }
}
