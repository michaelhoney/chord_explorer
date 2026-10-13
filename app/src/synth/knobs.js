/* ------------------------------------------------------------------ *
 *  KNOBS — a controller's knobs, mapped onto the synth's levels
 *
 *  Pure and import-free, like params.js. Eight slots, K1–K8, laid out
 *  like an MPK Mini's two rows of four. A slot is a physical knob — the
 *  controller number it sends — and the level it turns. This file knows
 *  what the slots are, how they change when you remap one, how they're
 *  stored, and when a knob gets to move a level at all (`takeover`).
 * ------------------------------------------------------------------ */

// An MPK Mini mk3's knobs send CC 70–77 out of the box, so they work before
// anything is mapped: the top row on the filter, the bottom row on its LFO
// and the amp — the controls you reach for when exploring what a filter does.
export const DEFAULT_KNOBS = [
  { cc: 70, param: "cutoff" },
  { cc: 71, param: "resonance" },
  { cc: 72, param: "filterEnv" },
  { cc: 73, param: "filterDecay" },
  { cc: 74, param: "lfoRate" },
  { cc: 75, param: "lfoDepth" },
  { cc: 76, param: "attack" },
  { cc: 77, param: "release" },
];
export const KNOB_COUNT = DEFAULT_KNOBS.length;

// Put `param` on slot `i`. One knob per level: two knobs on one level would
// fight, so the level leaves whichever slot had it.
export function assignParam(slots, i, param) {
  return slots.map((s, j) =>
    j === i ? { ...s, param } : s.param === param ? { ...s, param: null } : s
  );
}

// Slot `i` is now the knob that sends `cc`; any other slot claiming that
// knob lets go of it.
export function adoptCc(slots, i, cc) {
  return slots.map((s, j) => (j === i ? { ...s, cc } : s.cc === cc ? { ...s, cc: null } : s));
}

export const slotForCc = (slots, cc) => slots.findIndex((s) => s.cc === cc);
export const slotForParam = (slots, param) => slots.findIndex((s) => s.param === param);

// ------------------------------------------------------------------------
//  PICKUP
// ------------------------------------------------------------------------
// A knob and its level can disagree: pick a preset and Cutoff jumps, while
// the knob stays where your hand left it. Turning it then shouldn't snap the
// level to the knob — that's an audible lurch, and on a resonant filter a
// loud one. So a knob has to *pick the level up* first: it does nothing
// until it comes within a step of the level, or passes it, and from then on
// it holds the level and moves it. Anything else that moves the level — a
// preset, a mouse, a link — makes the knob let go again (that's the
// caller's half: `held` is only kept while the level is where the knob left
// it).
//
// `prev` is { pos, held } — the knob's last position (null if it hasn't
// been heard from) and whether it was holding the level. Returns whether it
// holds the level now, at position `knob`, with the level at `level`.
export const PICKUP_EPS = 1.5 / 127;

export function takeover(prev, knob, level, eps = PICKUP_EPS) {
  if (prev.held) return true;
  if (Math.abs(knob - level) <= eps) return true;
  // passed it between two messages: a fast turn skips straight over
  return prev.pos != null && (prev.pos - level) * (knob - level) < 0;
}

// ------------------------------------------------------------------------
//  STORAGE
// ------------------------------------------------------------------------
// Kept in the browser, not the link: like the MIDI port, which knob turns
// what is about your rig, not the music — but it's enough work to set up
// that it should outlive a visit. Read defensively: anything malformed falls
// back to the defaults, a slot at a time. `mappable(param)` says whether a
// parameter can be turned by a knob (the levels, not the keys).
export function parseKnobs(raw, mappable) {
  let data;
  try {
    data = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!Array.isArray(data) || data.length !== KNOB_COUNT) return null;
  // and no two slots on one knob or one level — the first keeps it
  const ccs = new Set();
  const params = new Set();
  return data.map((s) => {
    let cc = Number.isInteger(s?.cc) && s.cc >= 0 && s.cc <= 127 ? s.cc : null;
    let param = typeof s?.param === "string" && mappable(s.param) ? s.param : null;
    if (ccs.has(cc)) cc = null;
    if (params.has(param)) param = null;
    if (cc != null) ccs.add(cc);
    if (param != null) params.add(param);
    return { cc, param };
  });
}
