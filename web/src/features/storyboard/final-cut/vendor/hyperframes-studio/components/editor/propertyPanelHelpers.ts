// Excerpt from the upstream repository at tag v0.9.31 (commit cf900546): packages/studio/src/components/editor/propertyPanelHelpers.ts
// Copyright 2026 HeyGen, Inc. Licensed under the Apache License, Version 2.0 (LICENSE in the vendor root).
// Modifications: this header was added; only formatNumericValue (lines 248-253) is kept, with the
//   one import it uses.
import { roundToCenti } from "../../utils/rounding";

export function formatNumericValue(value: number): string {
  const rounded = roundToCenti(value);
  return Number.isInteger(rounded)
    ? `${rounded}`
    : rounded.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
