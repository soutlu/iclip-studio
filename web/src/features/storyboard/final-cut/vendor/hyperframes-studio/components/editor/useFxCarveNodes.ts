// Excerpt from the upstream repository at tag v0.9.59 (commit 028ab755): packages/studio/src/components/editor/useFxCarveNodes.ts
// Copyright 2026 HeyGen, Inc. Licensed under the Apache License, Version 2.0 (LICENSE in the vendor root).
// Modifications: this header was added; CarveClip and measureCarve (lines 64-133) are dropped,
//   because they fetch and decode in the studio's own way, and the imports are cut down to what
//   mintCarveNodes, carveLanes and carveLaneFor use.
/**
 * What a carve analysis COMPILES TO: the filter nodes it mints and the
 * automation lanes it writes for them.
 *
 * Split out of `useFxCarve.ts` to keep it under the studio's 600-line cap. This
 * half is pure — it takes measurements and returns nodes and lanes — while the
 * hook keeps the effects, the persistence and the auto-carve decisions.
 */

import {
  defaultAudioFxParams,
  mintAudioFxNodeId,
  type HfAudioFxChain,
  type HfAudioFxNode,
} from "@hyperframes/core/audio-fx";
import { analyseCarveBands, analyseCarveDynamics } from "@hyperframes/core/audio-carve";
import { fxAutomationTarget, type HfAutomationLane } from "@hyperframes/core/audio-automation";

/** Decode rate every carve measurement shares — see `measureCarve`. */
const DECODE_SAMPLE_RATE = 48000;

/**
 * Turns the analysed bands (and, if the carve is asked to match levels, a
 * ducking envelope) into chain nodes — tagged so a re-run replaces them
 * instead of stacking, and minted against the nodes already claiming an id
 * because a dynamic carve automates these filters and a lane addresses its
 * node by id.
 */
export function mintCarveNodes(
  chain: HfAudioFxChain,
  carved: HfAudioFxChain,
  duck: { t: number; v: number }[],
): { next: HfAudioFxChain; carvedNodes: HfAudioFxNode[]; duckNode: HfAudioFxNode | null } {
  const kept = chain.nodes.filter((n) => !n.fromCarve);
  let claimed: HfAudioFxChain = { version: 1, nodes: kept };
  const mint = (node: HfAudioFxNode): HfAudioFxNode => {
    const withId = { ...node, id: mintAudioFxNodeId(claimed), fromCarve: true };
    claimed = { version: 1, nodes: [...claimed.nodes, withId] };
    return withId;
  };
  const carvedNodes: HfAudioFxNode[] = carved.nodes.map(mint);
  // The gain stage sits after the filters, and only exists when the carve was
  // asked to make level room. It sits at 0 and is driven by the envelope below.
  const duckNode =
    duck.length > 0
      ? mint({ type: "gain", enabled: true, params: { ...defaultAudioFxParams("gain"), gain: 0 } })
      : null;
  return {
    next: { version: 1, nodes: [...carvedNodes, ...(duckNode ? [duckNode] : []), ...kept] },
    carvedNodes,
    duckNode,
  };
}

/** Each filter's depth as an envelope, plus the level envelope if there is one. */
export function carveLanes(
  carvedNodes: HfAudioFxNode[],
  duckNode: HfAudioFxNode | null,
  duck: { t: number; v: number }[],
  voiceMix: Float32Array,
  bands: ReturnType<typeof analyseCarveBands>,
): HfAutomationLane[] {
  // Each filter's depth becomes an envelope of the speech's level in that
  // band, so pauses leave the bed alone and whoever is talking sets the depth.
  const lanes = analyseCarveDynamics(voiceMix, DECODE_SAMPLE_RATE, bands).flatMap((dyn, i) => {
    const id = carvedNodes[i]?.id;
    return id ? carveLaneFor(id, dyn.points) : [];
  });
  // The level envelope rides the gain stage, on the same clock as the bands.
  if (duckNode?.id && duck.length > 0) lanes.push(...carveLaneFor(duckNode.id, duck));
  return lanes;
}

/**
 * One carve envelope as a lane on this bed's clock.
 *
 * No shifting: the voices were summed onto the bed's clock before the analysis
 * ran, so what comes back is already in the bed's own time. A lane does hold
 * its first value backwards to the start of its clip, so an envelope that
 * begins later needs an explicit "no cut" at zero or the bed starts out ducked.
 */
function carveLaneFor(id: string, points: { t: number; v: number }[]): HfAutomationLane[] {
  const timed = points.map((p) => ({ t: Number(p.t.toFixed(3)), v: p.v })).filter((p) => p.t >= 0);
  if ((timed[0]?.t ?? 0) > 0) timed.unshift({ t: 0, v: 0 });
  return timed.length > 1 ? [{ target: fxAutomationTarget(id, "gain"), points: timed }] : [];
}
