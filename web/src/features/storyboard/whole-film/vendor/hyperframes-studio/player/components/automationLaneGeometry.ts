// Excerpt from the upstream repository at tag v0.9.31 (commit cf900546): packages/studio/src/player/components/automationLaneGeometry.ts
// Copyright 2026 HeyGen, Inc. Licensed under the Apache License, Version 2.0 (LICENSE in the vendor root).
// Modifications: this header was added; only toUnit and fromUnit (lines 103-121) are kept, so the
//   import is cut down to the one type they use.
import type { AutomationRange } from "@hyperframes/core/audio-automation";

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
