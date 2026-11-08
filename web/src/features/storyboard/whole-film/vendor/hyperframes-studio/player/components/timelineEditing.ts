// Excerpt from HyperFrames Studio v0.8.168 (commit 6e1f9ee1): packages/studio/src/player/components/timelineEditing.ts
// Copyright 2026 HeyGen, Inc. Licensed under the Apache License, Version 2.0 (LICENSE in the vendor root).
// Modifications: only the move/resize math is taken (upstream lines 2, 15-27, 34-40, 44-75,
// 110-187, 217-241, 458-464). Left out: edit capabilities, auto-scroll, marquee selection,
// agent prompts, keyframe beat snap, drag escape, and the z-index stacking branch of
// resolveTimelineMove together with its four optional input fields and three optional
// result fields (they need timelineTrackOrder / timelineLayerDrag / timelineStacking).
import { roundToCenti } from "../../utils/rounding";

import {
  applyClipStartTrimDelta,
  clipStartTrimDeltaBounds,
  resolveTimelineMinDuration,
} from "./timelineGroupEditing";

export {
  clampTimelineGroupResizeDelta,
  resolveTimelineGroupMove,
  resolveTimelineGroupResize,
  type TimelineGroupResizeEdge,
  type TimelineGroupTimingMember,
} from "./timelineGroupEditing";

const roundToCentiseconds = roundToCenti;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

const EDGE_TRACK_CREATE_THRESHOLD = 0.55;

export interface TimelineMoveInput {
  start: number;
  track: number;
  duration: number;
  originClientX: number;
  /** Vertical position as a track-row index, not pixels: rows vary in height. */
  originRow: number;
  originScrollLeft?: number;
  currentScrollLeft?: number;
  pixelsPerSecond: number;
  minStart?: number;
  maxStart: number;
  trackOrder: number[];
}

export interface TimelineResizeInput {
  start: number;
  duration: number;
  originClientX: number;
  pixelsPerSecond: number;
  minStart: number;
  maxEnd: number;
  minDuration?: number;
  playbackStart?: number;
  playbackRate?: number;
}

export function resolveTimelineMove(
  input: TimelineMoveInput,
  clientX: number,
  currentRow: number,
): {
  start: number;
  track: number;
} {
  const scrollDeltaX = (input.currentScrollLeft ?? 0) - (input.originScrollLeft ?? 0);
  const deltaTime =
    (clientX - input.originClientX + scrollDeltaX) / Math.max(input.pixelsPerSecond, 1);
  // Rows, so vertical scroll and per-row heights are the caller's problem: rows
  // have varied in height since lanes expand, and a single trackHeight can't
  // describe them.
  const trackDeltaRaw = currentRow - input.originRow;
  const deltaTrack = Math.round(trackDeltaRaw);
  const nextStart = clamp(
    roundToCentiseconds(input.start + deltaTime),
    input.minStart ?? 0,
    Math.max(0, input.maxStart),
  );

  const currentTrackIndex = Math.max(0, input.trackOrder.indexOf(input.track));
  const desiredTrackIndex = currentTrackIndex + deltaTrack;
  const nextTrackIndex = clamp(desiredTrackIndex, 0, Math.max(0, input.trackOrder.length - 1));
  const minTrack = Math.min(...input.trackOrder);
  const maxTrack = Math.max(...input.trackOrder);
  let nextTrack = input.trackOrder[nextTrackIndex] ?? input.track;

  const startedOnFirstTrack = currentTrackIndex === 0;
  const startedOnLastTrack = currentTrackIndex === input.trackOrder.length - 1;

  if (
    startedOnFirstTrack &&
    desiredTrackIndex < 0 &&
    currentTrackIndex + trackDeltaRaw <= -EDGE_TRACK_CREATE_THRESHOLD
  ) {
    nextTrack = minTrack - 1;
  } else if (
    startedOnLastTrack &&
    desiredTrackIndex > input.trackOrder.length - 1 &&
    currentTrackIndex + trackDeltaRaw >= input.trackOrder.length - 1 + EDGE_TRACK_CREATE_THRESHOLD
  ) {
    nextTrack = maxTrack + 1;
  }

  return {
    start: nextStart,
    track: nextTrack,
  };
}

export function resolveTimelineResize(
  input: TimelineResizeInput,
  edge: "start" | "end",
  clientX: number,
): { start: number; duration: number; playbackStart?: number } {
  const minDuration = resolveTimelineMinDuration(input.minDuration);
  const deltaTime = (clientX - input.originClientX) / Math.max(input.pixelsPerSecond, 1);

  if (edge === "end") {
    const nextDuration = clamp(
      roundToCentiseconds(input.duration + deltaTime),
      minDuration,
      Math.max(minDuration, input.maxEnd - input.start),
    );
    return {
      start: input.start,
      duration: nextDuration,
      playbackStart: input.playbackStart,
    };
  }

  const { minDelta, maxDelta } = clipStartTrimDeltaBounds(input, input.minStart, minDuration);
  const clampedDelta = clamp(deltaTime, minDelta, maxDelta);
  return applyClipStartTrimDelta(input, clampedDelta);
}

export function formatTimelineAttributeNumber(value: number): string {
  return Number(roundToCentiseconds(value).toFixed(2)).toString();
}

export function formatTimelineMediaOffset(value: number): string {
  return Number(value.toFixed(6)).toString();
}
