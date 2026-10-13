/* ------------------------------------------------------------------ *
 *  SYNTH PARAMETERS — the patch model behind the synth
 *
 *  Pure, import-free, same as harmony.js: this file knows what the knobs
 *  are, what they mean, what a preset is and how a patch packs into a
 *  URL. It builds no audio nodes — engine.js reads these numbers and turns
 *  them into a signal chain.
 * ------------------------------------------------------------------ */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ------------------------------------------------------------------------
//  THE KNOBS
// ------------------------------------------------------------------------
// One entry per control, in the order the panel shows them: the panel's
// columns are derived from each entry's `group` (see SYNTH_GROUPS), so a new
// knob only has to name its column. The order a patch is written into a link
// is a separate list, SYNTH_WIRE, below — append-only, whatever happens here.
//
// `log` marks a parameter where equal slider travel should mean equal
// *ratio*, not equal difference — cutoff, times, rates: 200→400Hz and 4k→8k
// are the same musical move, and a linear slider spends nine tenths of its
// length above the range anyone wants. `hint` is the tooltip, and is the only
// place each control explains itself. `legacy` is the value a link gets for a
// parameter added after it was written, when that should differ from the
// default preset's — a filter envelope a sound never had stays shut.
export const SYNTH_PARAMS = {
  wave: {
    group: "Osc", kind: "enum", label: "Wave",
    options: ["sine", "triangle", "sawtooth", "square"],
    hint: "The raw waveform. Sine is pure, triangle hollow, sawtooth bright and buzzy, square woody.",
  },
  spread: {
    group: "Osc", label: "Spread", min: 0, max: 40, fmt: "cents",
    hint: "Detune three copies of the oscillator against each other. A little is width; a lot is seasick.",
  },
  drive: {
    group: "Osc", label: "Drive", min: 0, max: 1, fmt: "pct",
    hint: "Saturate the signal — adds harmonics the oscillator doesn't have, and grit with them.",
  },

  filterType: {
    group: "Filter", kind: "enum", label: "Type",
    options: ["lowpass", "highpass"], legacy: "lowpass",
    hint: "Lowpass keeps what's below the cutoff and rolls off everything above it, so closing it darkens the sound. Highpass is the mirror: it keeps what's above, and thins the sound from the bottom up.",
  },
  cutoff: {
    group: "Filter", label: "Cutoff", min: 80, max: 14000, log: true, fmt: "hz",
    hint: "The filter's corner frequency, where it starts to cut. Both the envelope and the LFO move it from here.",
  },
  resonance: {
    group: "Filter", label: "Resonance", min: 0, max: 12, fmt: "num",
    hint: "Emphasise the frequencies right at the cutoff. High values whistle, and make a sweep audible.",
  },
  lfoRate: {
    group: "Filter", label: "LFO rate", min: 0.05, max: 8, log: true, fmt: "rate",
    hint: "How fast the LFO sweeps the cutoff up and down. Under 1Hz drifts; over 4Hz wobbles.",
  },
  lfoDepth: {
    group: "Filter", label: "LFO depth", min: 0, max: 1, fmt: "pct",
    hint: "How far the sweep travels either side of the cutoff. At zero the LFO leaves the filter alone.",
  },

  filterEnv: {
    group: "Filter env", label: "Amount", min: 0, max: 5, fmt: "oct", legacy: 0,
    hint: "How far the envelope opens the filter at its peak, in octaves from the cutoff. At zero the filter ignores the envelope; turn it up and each note bites as it starts.",
  },
  filterAttack: {
    group: "Filter env", label: "Attack", min: 0.002, max: 2, log: true, fmt: "sec",
    hint: "How long the filter takes to open to its peak once a note starts.",
  },
  filterDecay: {
    group: "Filter env", label: "Decay", min: 0.02, max: 4, log: true, fmt: "sec",
    hint: "How long the filter takes to close from its peak down to the sustain level.",
  },
  filterSustain: {
    group: "Filter env", label: "Sustain", min: 0, max: 1, fmt: "pct",
    hint: "How open the filter stays while a note is held, as a share of the amount. When the note ends it closes the rest of the way, over the amp's release.",
  },

  attack: {
    group: "Amp env", label: "Attack", min: 0.002, max: 2, log: true, fmt: "sec",
    hint: "How long a note takes to reach full volume. Short is struck, long is breathed in.",
  },
  decay: {
    group: "Amp env", label: "Decay", min: 0.02, max: 2, log: true, fmt: "sec",
    hint: "How long it takes to fall from the attack peak down to the sustain level.",
  },
  sustain: {
    group: "Amp env", label: "Sustain", min: 0, max: 1, fmt: "pct",
    hint: "The level a held note settles at. Low makes a pluck, high makes a pad.",
  },
  release: {
    group: "Amp env", label: "Release", min: 0.05, max: 4, log: true, fmt: "sec",
    hint: "How long the note takes to fade once it ends — and the filter envelope closes over the same time. Long releases blur one chord into the next.",
  },

  chorus: {
    group: "Space", label: "Chorus", min: 0, max: 1, fmt: "pct",
    hint: "Blend in a detuned, slightly delayed copy. Widens a thin sound across the stereo field.",
  },
  reverb: {
    group: "Space", label: "Reverb", min: 0, max: 1, fmt: "pct",
    hint: "How much of the sound comes back as reflections — how wet the room is.",
  },
  size: {
    group: "Space", label: "Room size", min: 0.3, max: 8, log: true, fmt: "sec",
    hint: "How long the reverb takes to die away. Short is a room, long is a cathedral.",
  },
};

export const SYNTH_KEYS = Object.keys(SYNTH_PARAMS);

// the panel's layout, derived rather than restated so a new knob only has to
// name its group above to appear in the right column
export const SYNTH_GROUPS = SYNTH_KEYS.reduce((acc, k) => {
  const g = SYNTH_PARAMS[k].group;
  const found = acc.find((x) => x.name === g);
  if (found) found.keys.push(k);
  else acc.push({ name: g, keys: [k] });
  return acc;
}, []);

// The order a patch is written into a link — every shared `sy=` was written
// against this, so it is append-only: a new parameter goes on the end, and
// nothing is ever reordered or removed. A slot whose parameter has left the
// synth is retired in place (a leading ~) and written empty, so every slot
// after it keeps its position. Dynamics and Humanise were the synth's until
// they moved to the chord player, which is where they act: they're how a
// chord is played, not how the synth sounds. See retiredFromSynth.
export const SYNTH_WIRE = [
  "wave", "spread", "drive",
  "attack", "decay", "sustain", "release",
  "cutoff", "resonance", "lfoRate", "lfoDepth",
  "chorus", "reverb", "size",
  "~dynamics", "~humanise",
  "filterType", "filterEnv", "filterAttack", "filterDecay", "filterSustain",
];
const isRetired = (slot) => slot.startsWith("~");

// ------------------------------------------------------------------------
//  PRESETS
// ------------------------------------------------------------------------
// Starting points, not destinations: picking one sets every level, and the
// levels are then yours. Organ is deliberately flat — no filter movement at
// all — so you can hear what the others are doing by switching to it and
// back. Pluck and Brass are the filter envelope's worked examples (fast and
// shut, slow and swelling), Reed is the highpass one, Sweep is the LFO's.
export const PRESETS = {
  Mellow: {
    wave: "triangle", spread: 6, drive: 0,
    filterType: "lowpass", cutoff: 2400, resonance: 0.8, lfoRate: 0.3, lfoDepth: 0,
    filterEnv: 1, filterAttack: 0.01, filterDecay: 0.5, filterSustain: 0.4,
    attack: 0.015, decay: 0.25, sustain: 0.55, release: 1.3,
    chorus: 0.15, reverb: 0.25, size: 2.2,
  },
  Pad: {
    wave: "sawtooth", spread: 22, drive: 0,
    filterType: "lowpass", cutoff: 800, resonance: 1.5, lfoRate: 0.18, lfoDepth: 0.3,
    filterEnv: 1.6, filterAttack: 1.2, filterDecay: 1.6, filterSustain: 0.6,
    attack: 0.45, decay: 0.8, sustain: 0.8, release: 2.6,
    chorus: 0.55, reverb: 0.5, size: 4.5,
  },
  Pluck: {
    wave: "sawtooth", spread: 8, drive: 0.15,
    filterType: "lowpass", cutoff: 380, resonance: 4, lfoRate: 0.5, lfoDepth: 0,
    filterEnv: 3.6, filterAttack: 0.002, filterDecay: 0.22, filterSustain: 0.05,
    attack: 0.004, decay: 0.28, sustain: 0.08, release: 0.5,
    chorus: 0.1, reverb: 0.18, size: 1.4,
  },
  Brass: {
    wave: "sawtooth", spread: 10, drive: 0.1,
    filterType: "lowpass", cutoff: 420, resonance: 2, lfoRate: 0.3, lfoDepth: 0,
    filterEnv: 2.6, filterAttack: 0.09, filterDecay: 0.7, filterSustain: 0.45,
    attack: 0.04, decay: 0.3, sustain: 0.85, release: 0.45,
    chorus: 0.2, reverb: 0.25, size: 2.4,
  },
  Reed: {
    wave: "square", spread: 0, drive: 0.1,
    filterType: "highpass", cutoff: 650, resonance: 5, lfoRate: 4.5, lfoDepth: 0.04,
    filterEnv: 0.8, filterAttack: 0.03, filterDecay: 0.5, filterSustain: 0.3,
    attack: 0.03, decay: 0.2, sustain: 0.8, release: 0.4,
    chorus: 0.15, reverb: 0.3, size: 2.8,
  },
  Glass: {
    wave: "sine", spread: 14, drive: 0,
    filterType: "lowpass", cutoff: 9000, resonance: 0.5, lfoRate: 2.6, lfoDepth: 0.12,
    filterEnv: 0, filterAttack: 0.01, filterDecay: 0.5, filterSustain: 0.5,
    attack: 0.08, decay: 1.2, sustain: 0.45, release: 2.2,
    chorus: 0.6, reverb: 0.55, size: 5.5,
  },
  Sweep: {
    wave: "sawtooth", spread: 18, drive: 0.25,
    filterType: "lowpass", cutoff: 900, resonance: 7, lfoRate: 0.9, lfoDepth: 0.8,
    filterEnv: 0, filterAttack: 0.01, filterDecay: 0.5, filterSustain: 0.5,
    attack: 0.1, decay: 0.5, sustain: 0.75, release: 1.8,
    chorus: 0.3, reverb: 0.35, size: 3.2,
  },
  Organ: {
    wave: "square", spread: 0, drive: 0,
    filterType: "lowpass", cutoff: 2200, resonance: 0, lfoRate: 0.2, lfoDepth: 0,
    filterEnv: 0, filterAttack: 0.01, filterDecay: 0.5, filterSustain: 0.5,
    attack: 0.006, decay: 0.05, sustain: 1, release: 0.25,
    chorus: 0.2, reverb: 0.15, size: 1.8,
  },
};

export const DEFAULT_PRESET = "Mellow";
export const defaultSound = () => ({ ...PRESETS[DEFAULT_PRESET] });

// Which preset you're on — derived by comparison rather than stored, so a
// shared link that carries only numbers still opens with the right preset
// lit, and nudging one level honestly reads as custom.
export function presetNameFor(sound) {
  for (const [name, p] of Object.entries(PRESETS)) {
    if (SYNTH_KEYS.every((k) => sameParam(k, sound[k], p[k]))) return name;
  }
  return null;
}

// compared at the precision the URL round-trips at, or a link would reopen
// as "custom" purely from rounding
const sameParam = (k, a, b) =>
  SYNTH_PARAMS[k].kind === "enum" ? a === b : Math.abs(Number(a) - Number(b)) < 5e-4;

// ------------------------------------------------------------------------
//  SLIDER MAPPING
// ------------------------------------------------------------------------
// Levels always run 0–1000 in integers, whatever the parameter's own range:
// float steps drift, and a log parameter has no usable linear step anyway.
// The mapping lives here so it round-trips exactly.
export const SLIDER_STEPS = 1000;

export function paramToPos(k, value) {
  const p = SYNTH_PARAMS[k];
  const v = clamp(Number(value), p.min, p.max);
  const t = p.log
    ? Math.log(v / p.min) / Math.log(p.max / p.min)
    : (v - p.min) / (p.max - p.min);
  return Math.round(t * SLIDER_STEPS);
}

export function paramFromPos(k, pos) {
  const p = SYNTH_PARAMS[k];
  const t = clamp(Number(pos), 0, SLIDER_STEPS) / SLIDER_STEPS;
  const v = p.log ? p.min * Math.pow(p.max / p.min, t) : p.min + t * (p.max - p.min);
  return round3(v);
}

// three decimals is enough for a 2ms attack and keeps the URL short
const round3 = (v) => Math.round(v * 1000) / 1000;

export function clampParam(k, value) {
  const p = SYNTH_PARAMS[k];
  if (p.kind === "enum") return p.options.includes(value) ? value : p.options[0];
  const n = Number(value);
  return Number.isFinite(n) ? round3(clamp(n, p.min, p.max)) : null;
}

// ------------------------------------------------------------------------
//  READOUTS
// ------------------------------------------------------------------------
// Every level shows its value in the unit the value is actually in, not a
// percentage of a range nobody can see.
export function formatParam(k, value) {
  const p = SYNTH_PARAMS[k];
  const v = Number(value);
  switch (p.fmt) {
    case "hz":
      return formatHz(v);
    case "sec":
      return v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`;
    case "rate":
      return `${v < 1 ? v.toFixed(2) : v.toFixed(1)} Hz`;
    case "pct":
      return `${Math.round(v * 100)}%`;
    case "cents":
      return v ? `${Math.round(v)}¢` : "off";
    case "oct":
      return v ? `${v.toFixed(1)} oct` : "off";
    default:
      return v.toFixed(1);
  }
}

export const formatHz = (v) =>
  v < 1000 ? `${Math.round(v)} Hz` : `${(v / 1000).toFixed(v < 10000 ? 2 : 1)} kHz`;

// ------------------------------------------------------------------------
//  SHARING
// ------------------------------------------------------------------------
// Packed as one bare list of numbers in SYNTH_WIRE order — an enum is its
// index in the options, everything else is its own value. Joined with "-"
// because every value is non-negative and the decimal point is taken.
export function packSynth(sound) {
  return SYNTH_WIRE.map((k) => {
    if (isRetired(k)) return "";
    const p = SYNTH_PARAMS[k];
    return p.kind === "enum" ? p.options.indexOf(sound[k]) : round3(sound[k]);
  }).join("-");
}

// Malformed and out-of-range values fall back to the default preset's value
// for that one parameter rather than throwing the lot away. A link written
// before a parameter existed is short, not wrong: a missing slot takes the
// parameter's `legacy` value where it has one, so an old sound reopens as it
// was rather than picking up a filter envelope it never had.
export function unpackSynth(str) {
  const base = defaultSound();
  if (!str) return base;
  const parts = String(str).split("-");
  const out = { ...base };
  SYNTH_WIRE.forEach((k, i) => {
    if (isRetired(k)) return;
    const p = SYNTH_PARAMS[k];
    const raw = parts[i];
    if (raw == null || raw === "") {
      if (p.legacy !== undefined) out[k] = p.legacy;
      return;
    }
    if (p.kind === "enum") {
      const idx = Number(raw);
      if (Number.isInteger(idx) && p.options[idx]) out[k] = p.options[idx];
      return;
    }
    const v = clampParam(k, raw);
    if (v !== null) out[k] = v;
  });
  return out;
}

// What an older link carried in the retired slots — Dynamics and Humanise,
// which the chord player now owns. Only the values actually there, so the
// player can fall back to its own defaults for the rest.
export function retiredFromSynth(str) {
  const out = {};
  if (!str) return out;
  const parts = String(str).split("-");
  SYNTH_WIRE.forEach((slot, i) => {
    if (!isRetired(slot) || parts[i] == null || parts[i] === "") return;
    const n = Number(parts[i]);
    if (Number.isFinite(n)) out[slot.slice(1)] = clamp(n, 0, 1);
  });
  return out;
}

export const isDefaultSound = (sound) =>
  SYNTH_KEYS.every((k) => sameParam(k, sound[k], PRESETS[DEFAULT_PRESET][k]));

// ------------------------------------------------------------------------
//  DERIVED AUDIO SETTINGS
// ------------------------------------------------------------------------
// Still pure maths, so it belongs here rather than in the engine that applies it.

// Tone's fat oscillators are a separate type name, not a flag — and handing
// count/spread to a plain oscillator is an error, so the two travel together.
export const oscType = (wave, spread) => (spread > 0 ? `fat${wave}` : wave);

// The LFO and the filter envelope both move the cutoff in octaves, the way a
// control voltage moves a hardware filter (one volt per octave): the same
// depth sounds like the same sweep wherever the cutoff sits. In the engine
// both arrive as cents on the filter's detune, where they add — so neither
// owns the cutoff, and the Cutoff level keeps the filter's frequency to itself.
export const LFO_OCTAVES = 2.2; // a full-depth LFO swings this far either side
export const lfoCents = (depth) => depth * LFO_OCTAVES * 1200;
export const contourCents = (octaves) => octaves * 1200;

// Where the cutoff is with the filter envelope at `env` (0–1) and the LFO at
// `lfo` (−1 to 1). What the display draws the filter at, from the same
// arithmetic the engine hands the filter.
export function cutoffAt(sound, env = 0, lfo = 0) {
  const oct = (Number(sound.filterEnv) || 0) * env + LFO_OCTAVES * (Number(sound.lfoDepth) || 0) * lfo;
  return clamp(sound.cutoff * Math.pow(2, oct), 10, 24000);
}
