// Excerpt from HyperFrames Studio v0.8.168 (commit 6e1f9ee1): packages/studio/src/player/components/timelineGroupEditing.ts
// Copyright 2026 HeyGen, Inc. Licensed under the Apache License, Version 2.0 (LICENSE in the vendor root).
// Modifications:
// - lines 1-175 only; the multi-select group-resize wiring (lines 177-308) and the imports it
//   needed (TimelineElement, clampToHostStart, getTimelineEditCapabilities) are left out;
// - the `clampPlaybackRate` import from @hyperframes/parsers is replaced by its source
//   (packages/parsers/src/mediaDuration.ts lines 25-34, same repo, tag and licence);
// - DEFAULT_TIMELINE_MIN_DURATION is exported.
import { roundToCenti } from "../../utils/rounding";

/** The one bound on a clip's playback rate; core re-exports it for the rate lane. */
const MIN_PLAYBACK_RATE = 0.1;
const MAX_PLAYBACK_RATE = 10;

/** A playback rate clamped to the bounds above; anything non-positive or non-finite is 1. */
function clampPlaybackRate(raw: number): number {
  return Number.isFinite(raw) && raw > 0
    ? Math.max(MIN_PLAYBACK_RATE, Math.min(MAX_PLAYBACK_RATE, raw))
    : 1;
}

export const DEFAULT_TIMELINE_MIN_DURATION = 0.1;
const ABSOLUTE_TIMELINE_MIN_DURATION = 0.05;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function roundTimelineTime(value: number): number {
  return roundToCenti(value);
}

const SAVED_MEDIA_OFFSET_TOLERANCE = 1e-5;

function ceilTimelineTime(value: number): number {
  return Math.ceil((value - SAVED_MEDIA_OFFSET_TOLERANCE) * 100) / 100;
}

function floorTimelineTime(value: number): number {
  return Math.floor((value + SAVED_MEDIA_OFFSET_TOLERANCE) * 100) / 100;
}

export function resolveTimelineMinDuration(minDuration?: number): number {
  return Math.max(ABSOLUTE_TIMELINE_MIN_DURATION, minDuration ?? DEFAULT_TIMELINE_MIN_DURATION);
}

/** Playback rate never drops to zero (would make media-in-point math divide by ~0). */
export function resolveTimelinePlaybackRate(rate?: number): number {
  return clampPlaybackRate(rate ?? 1);
}

interface TimelineStartTrimClip {
  start: number;
  duration: number;
  playbackStart?: number;
  playbackRate?: number;
}

/**
 * Delta bounds for trimming a clip's START edge (shared by single-clip and group
 * resize). Left-bounded by how far the start can move toward `minStart` and by the
 * media in-point (`playbackStart / playbackRate`); right-bounded by `minDuration`, the start
 * floored onto the centisecond grid. Otherwise unrounded; applyClipStartTrimDelta rounds.
 */
export function clipStartTrimDeltaBounds(
  clip: TimelineStartTrimClip,
  minStart: number,
  minDuration: number,
): { minDelta: number; maxDelta: number } {
  const playbackRate = resolveTimelinePlaybackRate(clip.playbackRate);
  const maxLeftExtensionFromMedia =
    clip.playbackStart != null ? clip.playbackStart / playbackRate : Number.POSITIVE_INFINITY;
  return {
    minDelta: -Math.min(clip.start - minStart, maxLeftExtensionFromMedia),
    maxDelta: floorTimelineTime(clip.start + clip.duration - minDuration) - clip.start,
  };
}

/**
 * Apply a start-edge delta to one clip: rounds the start once, keeps the end fixed,
 * and derives the media in-point from the rounded start (clamped at 0), so the media
 * clock `start - playbackStart / playbackRate` survives any number of head trims.
 */
export function applyClipStartTrimDelta(
  clip: TimelineStartTrimClip,
  delta: number,
): { start: number; duration: number; playbackStart?: number } {
  const playbackRate = resolveTimelinePlaybackRate(clip.playbackRate);
  const mediaZero =
    clip.playbackStart != null ? clip.start - clip.playbackStart / playbackRate : -Infinity;
  const start = Math.max(roundTimelineTime(clip.start + delta), ceilTimelineTime(mediaZero));
  return {
    start,
    duration: roundTimelineTime(clip.start + clip.duration - start),
    playbackStart:
      clip.playbackStart != null
        ? Math.max(0, clip.playbackStart + (start - clip.start) * playbackRate)
        : undefined,
  };
}

export interface TimelineGroupTimingMember {
  start: number;
  duration: number;
  playbackStart?: number;
  playbackRate?: number;
  minStart?: number;
}

export type TimelineGroupResizeEdge = "start" | "end";

export interface TimelineGroupMoveResult {
  delta: number;
  members: Array<Pick<TimelineGroupTimingMember, "start" | "duration">>;
}

export interface TimelineGroupResizeResult {
  delta: number;
  members: Array<Pick<TimelineGroupTimingMember, "start" | "duration" | "playbackStart">>;
}

function clampTimelineGroupMoveDelta(
  rawDelta: number,
  members: readonly TimelineGroupTimingMember[],
): number {
  if (members.length === 0) return 0;
  const minDelta = Math.max(...members.map((member) => -(member.start - (member.minStart ?? 0))));
  return roundTimelineTime(Math.max(rawDelta, minDelta));
}

export function resolveTimelineGroupMove(
  members: readonly TimelineGroupTimingMember[],
  rawDelta: number,
): TimelineGroupMoveResult {
  const delta = clampTimelineGroupMoveDelta(rawDelta, members);
  return {
    delta,
    members: members.map((member) => ({
      start: roundTimelineTime(member.start + delta),
      duration: member.duration,
    })),
  };
}

export function clampTimelineGroupResizeDelta(
  rawDelta: number,
  members: readonly TimelineGroupTimingMember[],
  edge: TimelineGroupResizeEdge,
  minDuration = resolveTimelineMinDuration(),
): number {
  if (members.length === 0) return 0;

  if (edge === "end") {
    const minDelta = Math.max(...members.map((member) => minDuration - member.duration));
    return roundTimelineTime(Math.max(rawDelta, minDelta));
  }

  // Rigid group: the applied delta is bounded by the most-constrained member.
  const bounds = members.map((member) =>
    clipStartTrimDeltaBounds(member, member.minStart ?? 0, minDuration),
  );
  const minDelta = ceilTimelineTime(Math.max(...bounds.map((b) => b.minDelta)));
  const maxDelta = Math.min(...bounds.map((b) => b.maxDelta));
  const delta = roundTimelineTime(clamp(rawDelta, minDelta, maxDelta));
  const roundedPastTightestMember = delta > maxDelta + SAVED_MEDIA_OFFSET_TOLERANCE;
  return roundedPastTightestMember ? maxDelta - SAVED_MEDIA_OFFSET_TOLERANCE : delta;
}

export function resolveTimelineGroupResize(
  members: readonly TimelineGroupTimingMember[],
  edge: TimelineGroupResizeEdge,
  rawDelta: number,
  minDuration = resolveTimelineMinDuration(),
): TimelineGroupResizeResult {
  const delta = clampTimelineGroupResizeDelta(rawDelta, members, edge, minDuration);
  return {
    delta,
    members: members.map((member) => {
      if (edge === "end") {
        return {
          start: member.start,
          duration: roundTimelineTime(member.duration + delta),
          playbackStart: member.playbackStart,
        };
      }

      return applyClipStartTrimDelta(member, delta);
    }),
  };
}
