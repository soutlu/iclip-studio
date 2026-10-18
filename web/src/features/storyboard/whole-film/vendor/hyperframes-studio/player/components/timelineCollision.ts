// Copied from HyperFrames Studio v0.8.168 (commit 6e1f9ee1): packages/studio/src/player/components/timelineCollision.ts
// Copyright 2026 HeyGen, Inc. Licensed under the Apache License, Version 2.0 (LICENSE in the vendor root).
// Modifications: excerpt — only resolveNearestFreeStart (with floorCenti, ceilCenti, isNearer), resolveInsertRow
//   and timeRangesOverlap are kept; the kind-zone and group-header placement code is removed, nothing is changed.
//   `../store/playerStore` is the local type stand-in (see README).
import type { TimelineElement } from "../store/playerStore";

const floorCenti = (v: number) => Math.floor(v * 100 + 1e-6) / 100;
const ceilCenti = (v: number) => Math.ceil(v * 100 - 1e-6) / 100;

/** Whether `candidate` is nearer `start` than `best`; a tie goes to the later time. */
const isNearer = (candidate: number, best: number, start: number) => {
  const gap = Math.abs(candidate - start) - Math.abs(best - start);
  return gap < 0 || (gap === 0 && candidate > best);
};

/** The start nearest `start`, not below `minStart`, at which [start, start + duration) overlaps
 *  no clip on `track`. Ties go to the later time. The gap after the row's last clip always fits,
 *  so a row with no gap long enough puts the clip right after its last clip. `origin` is the
 *  clip's own start on this track: keeping it rewrites nothing, so it fits between any edges. */
export function resolveNearestFreeStart(
  elements: readonly TimelineElement[],
  track: number,
  start: number,
  duration: number,
  excludeKey: string | null,
  minStart = 0,
  origin: number | null = null,
): number {
  const busy = elements
    .filter((el) => (el.key ?? el.id) !== excludeKey && el.track === track)
    .sort((a, b) => a.start - b.start);
  let best = Number.POSITIVE_INFINITY;
  let gapStart = minStart;
  for (const el of [...busy, null]) {
    const latest = el ? floorCenti(el.start - duration) : Number.POSITIVE_INFINITY;
    if (latest >= gapStart) {
      const candidate = Math.min(Math.max(start, gapStart), latest);
      if (Math.abs(candidate - start) <= Math.abs(best - start)) best = candidate;
    }
    if (el) gapStart = Math.max(gapStart, ceilCenti(el.start + el.duration));
  }
  if (origin === null || origin < minStart || !isNearer(origin, best, start)) return best;
  // Float slack at both ends: 0.333 + 1.733 is 2.0660000000000003, a hair past a neighbour at 2.066.
  const [from, to] = [origin + 1e-6, origin + duration - 1e-6];
  const clear = busy.every((el) => !timeRangesOverlap(from, to, el.start, el.start + el.duration));
  return clear ? origin : best;
}

/**
 * The row boundary a pointer opens a new track at, or null over a row. `rowFloat` is the pointer's
 * position in row units from the top of the first row. Only the empty space above the first row
 * (0) or below the last (`trackCount`) opens one: a drop anywhere on a row stays on that row.
 */
export function resolveInsertRow(rowFloat: number, trackCount: number): number | null {
  if (trackCount === 0 || rowFloat < 0) return 0;
  if (rowFloat >= trackCount) return trackCount;
  return null;
}

/** Half-open overlap test: [aStart, aEnd) intersects [bStart, bEnd). */
export function timeRangesOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}
