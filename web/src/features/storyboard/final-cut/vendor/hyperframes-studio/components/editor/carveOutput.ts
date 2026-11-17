// Excerpt from the upstream repository at tag v0.9.59 (commit 028ab755): packages/studio/src/components/editor/carveOutput.ts
// Copyright 2026 HeyGen, Inc. Licensed under the Apache License, Version 2.0 (LICENSE in the vendor root).
// Modifications: this header was added; only withoutCarveLanes (lines 12-20) is kept, with the two
//   types it uses.
import type { HfAudioFxChain } from "@hyperframes/core/audio-fx";
import type { HfAutomation } from "@hyperframes/core/audio-automation";

/** Lanes belonging to nodes the carve generated, which a re-run replaces. */
export function withoutCarveLanes(automation: HfAutomation, chain: HfAudioFxChain): HfAutomation {
  const prefixes = chain.nodes.filter((n) => n.fromCarve && n.id).map((n) => `fx.${n.id}.`);
  if (prefixes.length === 0) return automation;
  return {
    version: automation.version,
    lanes: automation.lanes.filter((lane) => !prefixes.some((p) => lane.target.startsWith(p))),
  };
}
