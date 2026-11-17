// Excerpt from the upstream repository: packages/studio/src/player/components/automationLaneGeometry.ts
// toUnit and fromUnit at tag v0.9.31 (commit cf900546, lines 103-121; unchanged at v0.9.59); POINT_MERGE_SEC
//   and MIN_POINT_GAP_SEC at tag v0.9.59 (commit 028ab755, lines 23-50).
// Copyright 2026 HeyGen, Inc. Licensed under the Apache License, Version 2.0 (LICENSE in the vendor root).
// Modifications: this header was added; only the parts listed above are kept, so the
//   import is cut down to the one type they use.
import type { AutomationRange } from "@hyperframes/core/audio-automation";

/** Points nearer than this in clip seconds are the same point, not two. */
export const POINT_MERGE_SEC = 0.02;

/**
 * Closest two breakpoints may sit in clip seconds while still being two points.
 *
 * A drag clamps to this short of its neighbour rather than onto it. Landing on the
 * exact same time is not a step, it is a deletion: the lane's own normalisation
 * collapses points that share a `t`, keeping the later one — so dragging a point
 * fully into its neighbour used to consume that neighbour. A millisecond is under a
 * pixel at any zoom the lane offers, so the two still read as touching.
 */
export const MIN_POINT_GAP_SEC = 0.001;

/** Value → 0..1 up the lane, honouring a log-read knob's own scale. */
export function toUnit(range: AutomationRange, value: number): number {
  const { min, max } = range;
  if (max <= min) return 0;
  if (range.scale === "log" && min > 0 && value > 0) {
    return (Math.log(value) - Math.log(min)) / (Math.log(max) - Math.log(min));
  }
  return (value - min) / (max - min);
}

export function fromUnit(range: AutomationRange, unit: number): number {
  const t = Math.min(1, Math.max(0, unit));
  const { min, max } = range;
  if (range.scale === "log" && min > 0) {
    return Math.exp(Math.log(min) + t * (Math.log(max) - Math.log(min)));
  }
  return min + t * (max - min);
}
