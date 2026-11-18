// Excerpt from the upstream repository at tag v0.9.59 (commit 028ab755): packages/studio/src/components/editor/clipPathHelpers.ts
// Copyright 2026 HeyGen, Inc. Licensed under the Apache License, Version 2.0 (LICENSE in the vendor root).
// Modifications: this header was added; only the inset parsing is kept (the two types, parseInsetLengthPx,
//   sidesFromInsetTokens and parseInsetClipPathSides). The value builders and formatters are dropped,
//   together with the rounding import only they use.
export interface ClipPathInsetSides {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type ParsedInsetClipPathSides = ClipPathInsetSides & { radius: number };

function parseInsetLengthPx(value: string): number | null {
  const normalized = value.trim();
  if (normalized === "0") return 0;
  const match = /^(-?\d+(?:\.\d+)?)px$/i.exec(normalized);
  if (!match) return null;
  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
}

function sidesFromInsetTokens(tokens: number[]): ClipPathInsetSides | null {
  if (tokens.length < 1 || tokens.length > 4) return null;
  // CSS shorthand expansion: T | T R | T R B | T R B L
  const [top, right = top, bottom = top, left = right] = tokens;
  if (top === undefined || right === undefined || bottom === undefined || left === undefined) {
    return null;
  }
  return { top, right, bottom, left };
}

export function parseInsetClipPathSides(
  value: string | undefined,
): ParsedInsetClipPathSides | null {
  // Unambiguous pattern (no nested optional whitespace) to avoid polynomial
  // backtracking on adversarial input; trim the payload instead.
  const match = /^inset\(([^()]*)\)$/i.exec(value?.trim() ?? "");
  if (!match) return null;
  const parts = match[1]
    .trim()
    .replace(/\s+/g, " ")
    .split(/ round /i);
  const insetPart = parts[0]?.trim();
  if (!insetPart || parts.length > 2) return null;

  const tokens = insetPart.split(/\s+/).map(parseInsetLengthPx);
  if (tokens.some((token) => token == null)) return null;
  const numericTokens: number[] = [];
  for (const token of tokens) {
    if (token == null) return null;
    numericTokens.push(token);
  }
  const sides = sidesFromInsetTokens(numericTokens);
  if (!sides) return null;

  const radiusPart = parts[1]?.trim();
  const radius = radiusPart ? parseInsetLengthPx(radiusPart) : 0;
  if (radius == null) return null;
  return { ...sides, radius };
}
