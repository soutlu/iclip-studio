// Excerpt from the upstream repository at tag v0.9.59 (commit 028ab755): packages/studio/src/components/editor/domEditOverlayCrop.ts
// Copyright 2026 HeyGen, Inc. Licensed under the Apache License, Version 2.0 (LICENSE in the vendor root).
// Modifications: this header was added; only the pure crop math is kept (CropScreenRect, cropRectFromInsets,
//   parseCropClipPath and hugRectForClipPath). The crop lift, the element clip-path reader, the drag
//   resolvers and the oriented crop frame are dropped, together with the editing-port import only they use.
import {
  parseInsetClipPathSides,
  type ClipPathInsetSides,
  type ParsedInsetClipPathSides,
} from "./clipPathHelpers";

export interface CropScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Element-space insets → the cropped region in overlay (screen) space. */
export function cropRectFromInsets(
  rect: CropScreenRect,
  insets: ClipPathInsetSides,
  scaleX: number,
  scaleY: number,
): CropScreenRect {
  const sx = scaleX > 0 ? scaleX : 1;
  const sy = scaleY > 0 ? scaleY : 1;
  const left = rect.left + insets.left * sx;
  const top = rect.top + insets.top * sy;
  return {
    left,
    top,
    width: Math.max(0, rect.width - (insets.left + insets.right) * sx),
    height: Math.max(0, rect.height - (insets.top + insets.bottom) * sy),
  };
}

/** Zeros = no clip yet. `null` = a clip this tool cannot represent (circle/polygon/non-px inset):
 *  croppers must not lift, edit, or restore it, or deselect silently replaces or destroys it. */
function parseCropClipPath(value: string): ParsedInsetClipPathSides | null {
  if (!value || value === "none") return { top: 0, right: 0, bottom: 0, left: 0, radius: 0 };
  return parseInsetClipPathSides(value);
}

/** `hugRectForElement` for a clip-path read elsewhere; null is one that could not be read. */
export function hugRectForClipPath(
  rect: CropScreenRect & { editScaleX: number; editScaleY: number },
  clipPath: string | null,
): CropScreenRect {
  const insets = clipPath === null ? null : parseCropClipPath(clipPath);
  // Uneditable clip — show the full element rect.
  if (!insets || (insets.top <= 0 && insets.right <= 0 && insets.bottom <= 0 && insets.left <= 0))
    return rect;
  return cropRectFromInsets(rect, insets, rect.editScaleX, rect.editScaleY);
}
