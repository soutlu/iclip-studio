// Copied from HyperFrames Studio v0.8.168 (commit 6e1f9ee1): packages/studio/src/utils/rounding.ts
// Copyright 2026 HeyGen, Inc. Licensed under the Apache License, Version 2.0 (LICENSE in the vendor root).
// Modifications: none; this header was added.
/** Round to 3 decimal places (millisecond precision for GSAP values). */
export function roundTo3(val: number): number {
  return Math.round(val * 1000) / 1000;
}

/** Whole CSS px: GSAP parses a -50% translate against the integer offsetWidth/Height. */
export function roundToLayoutPx(val: number): number {
  return Math.round(val);
}

export function roundToLayoutSize(size: { width: number; height: number }) {
  return {
    width: roundToLayoutPx(Math.max(1, size.width)),
    height: roundToLayoutPx(Math.max(1, size.height)),
  };
}

/** Round to 2 decimal places (centisecond precision for timeline values). */
export function roundToCenti(val: number): number {
  return Math.round(val * 100) / 100;
}
