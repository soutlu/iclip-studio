// Local stand-in, not an upstream copy: HyperFrames Studio v0.8.168 (commit 6e1f9ee1) defines these
// types in packages/studio/src/player/store/playerStore.ts and player/store/timelineElement.ts,
// together with a zustand store this vendor does not take. Only the types the copied files import
// are declared here: `ZoomMode` verbatim, `TimelineElement` reduced to the fields they read.
export type ZoomMode = "fit" | "manual";

export interface TimelineElement {
  id: string;
  key?: string;
  start: number;
  duration: number;
}
