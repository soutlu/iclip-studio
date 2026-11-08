// Local stand-in, not an upstream copy: HyperFrames Studio v0.8.168 (commit 6e1f9ee1) defines this
// type in packages/studio/src/player/lib/timelineClipIndex.ts together with a clip interval index
// this vendor does not take. Only the type timelineLayout.ts imports is declared here, verbatim.
export interface TimelineTimeRange {
  readonly start: number;
  readonly end: number;
}
