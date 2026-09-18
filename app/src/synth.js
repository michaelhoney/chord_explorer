/* ------------------------------------------------------------------ *
 *  SYNTH — the parameter model behind the Sound panel
 *
 *  Pure, import-free, same as harmony.js: this file knows what the knobs
 *  are, what they mean, what a preset is and how a setting packs into a
 *  URL. It builds no audio nodes — Tone lives in the presentation layer,
 *  which reads these numbers and turns them into a signal chain.
 * ------------------------------------------------------------------ */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ------------------------------------------------------------------------
//  THE KNOBS
// ------------------------------------------------------------------------
// One entry per control. `log` marks a parameter where equal slider travel
// should mean equal *ratio*, not equal difference — cutoff, times, rates:
// 200→400Hz and 4k→8k are the same musical move, and a linear slider spends
// nine tenths of its length above the range anyone wants.
// `hint` is the tooltip, and is the only place each control explains itself.
export const SYNTH_PARAMS = {
  wave: {
    group: "Voice", kind: "enum", label: "Wave",
    options: ["sine", "triangle", "sawtooth", "square"],
    hint: "The raw waveform. Sine is pure, triangle hollow, sawtooth bright and buzzy, square woody.",
  },
  spread: {
    group: "Voice", label: "Spread", min: 0, max: 40, fmt: "cents",
    hint: "Detune three copies of the oscillator against each other. A little is width; a lot is seasick.",
  },
  drive: {
    group: "Voice", label: "Drive", min: 0, max: 1, fmt: "pct",
    hint: "Saturate the signal — adds harmonics the oscillator doesn't have, and grit with them.",
  },

  attack: {
    group: "Envelope", label: "Attack", min: 0.002, max: 2, log: true, fmt: "sec",
    hint: "How long a note takes to reach full volume. Short is struck, long is breathed in.",
  },
  decay: {
    group: "Envelope", label: "Decay", min: 0.02, max: 2, log: true, fmt: "sec",
    hint: "How long it takes to fall from the attack peak down to the sustain level.",
  },
  sustain: {
    group: "Envelope", label: "Sustain", min: 0, max: 1, fmt: "pct",
    hint: "The level a held note settles at. Low makes a pluck, high makes a pad.",
  },
  release: {
    group: "Envelope", label: "Release", min: 0.05, max: 4, log: true, fmt: "sec",
    hint: "How long the note takes to fade once it ends. Long releases blur one chord into the next.",
  },

  cutoff: {
    group: "Filter", label: "Cutoff", min: 180, max: 14000, log: true, fmt: "hz",
    hint: "The lowpass corner — everything above it is rolled off. Lower is darker and further away.",
  },
  resonance: {
    group: "Filter", label: "Resonance", min: 0, max: 12, fmt: "num",
    hint: "Emphasise the frequencies right at the cutoff. High values whistle, and make a sweep audible.",
  },
  lfoRate: {
    group: "Filter", label: "LFO rate", min: 0.05, max: 8, log: true, fmt: "rate",
    hint: "How fast the cutoff sweeps up and down. Under 1Hz drifts; over 4Hz wobbles.",
  },
  lfoDepth: {
    group: "Filter", label: "LFO depth", min: 0, max: 1, fmt: "pct",
    hint: "How far the sweep travels either side of the cutoff. At zero the filter holds still.",
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

  dynamics: {
    group: "Feel", label: "Dynamics", min: 0, max: 1, fmt: "pct",
    hint: "Spread the voices apart in volume — bass firm, melody singing, inner voices sitting back. At zero every note is equally loud, which is the organ sound.",
  },
  humanise: {
    group: "Feel", label: "Humanise", min: 0, max: 1, fmt: "pct",
    hint: "Scatter each note's volume and timing by a few percent, so a block chord sounds struck rather than triggered.",
  },
};

// fixed order — this is what packSynth writes and unpackSynth reads, so
// appending a parameter is safe and reordering one breaks every old link
export const SYNTH_ORDER = Object.keys(SYNTH_PARAMS);

// the panel's layout, derived rather than restated so a new knob only has to
// name its group above to appear in the right column
export const SYNTH_GROUPS = SYNTH_ORDER.reduce((acc, k) => {
  const g = SYNTH_PARAMS[k].group;
  const found = acc.find((x) => x.name === g);
  if (found) found.keys.push(k);
  else acc.push({ name: g, keys: [k] });
  return acc;
}, []);

// ------------------------------------------------------------------------
//  PRESETS
// ------------------------------------------------------------------------
// Starting points, not destinations: picking one sets every slider, and the
// sliders are then yours. Organ is deliberately flat — no dynamics, no
// humanise, no filter movement — so you can hear what the others are doing
// by switching to it and back.
export const PRESETS = {
  Mellow: {
    wave: "triangle", spread: 6, drive: 0,
    attack: 0.015, decay: 0.25, sustain: 0.55, release: 1.3,
    cutoff: 3200, resonance: 0.8, lfoRate: 0.3, lfoDepth: 0,
    chorus: 0.15, reverb: 0.25, size: 2.2,
    dynamics: 0.5, humanise: 0.35,
  },
  Pad: {
    wave: "sawtooth", spread: 22, drive: 0,
    attack: 0.45, decay: 0.8, sustain: 0.8, release: 2.6,
    cutoff: 1400, resonance: 1.5, lfoRate: 0.18, lfoDepth: 0.35,
    chorus: 0.55, reverb: 0.5, size: 4.5,
    dynamics: 0.35, humanise: 0.5,
  },
  Pluck: {
    wave: "sawtooth", spread: 8, drive: 0.15,
    attack: 0.004, decay: 0.28, sustain: 0.08, release: 0.5,
    cutoff: 2600, resonance: 4, lfoRate: 0.5, lfoDepth: 0,
    chorus: 0.1, reverb: 0.18, size: 1.4,
    dynamics: 0.7, humanise: 0.45,
  },
  Glass: {
    wave: "sine", spread: 14, drive: 0,
    attack: 0.08, decay: 1.2, sustain: 0.45, release: 2.2,
    cutoff: 9000, resonance: 0.5, lfoRate: 2.6, lfoDepth: 0.12,
    chorus: 0.6, reverb: 0.55, size: 5.5,
    dynamics: 0.4, humanise: 0.3,
  },
  Sweep: {
    wave: "sawtooth", spread: 18, drive: 0.25,
    attack: 0.1, decay: 0.5, sustain: 0.75, release: 1.8,
    cutoff: 900, resonance: 7, lfoRate: 0.9, lfoDepth: 0.8,
    chorus: 0.3, reverb: 0.35, size: 3.2,
    dynamics: 0.3, humanise: 0.3,
  },
  Organ: {
    wave: "square", spread: 0, drive: 0,
    attack: 0.006, decay: 0.05, sustain: 1, release: 0.25,
    cutoff: 2200, resonance: 0, lfoRate: 0.2, lfoDepth: 0,
    chorus: 0.2, reverb: 0.15, size: 1.8,
    dynamics: 0, humanise: 0,
  },
};

export const DEFAULT_PRESET = "Mellow";
export const defaultSound = () => ({ ...PRESETS[DEFAULT_PRESET] });

// Which preset you're on — derived by comparison rather than stored, so a
// shared link that carries only numbers still opens with the right name in
// the dropdown, and nudging one slider honestly reads as "custom".
export function presetNameFor(sound) {
  for (const [name, p] of Object.entries(PRESETS)) {
    if (SYNTH_ORDER.every((k) => sameParam(k, sound[k], p[k]))) return name;
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
// Sliders always run 0–1000 in integers, whatever the parameter's own range:
// float `step` on a range input drifts, and a log parameter has no usable
// linear step anyway. The mapping lives here so it round-trips exactly.
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
// Every slider shows its value in the unit the value is actually in, not a
// percentage of a range nobody can see.
export function formatParam(k, value) {
  const p = SYNTH_PARAMS[k];
  const v = Number(value);
  switch (p.fmt) {
    case "hz":
      return v < 1000 ? `${Math.round(v)} Hz` : `${(v / 1000).toFixed(v < 10000 ? 2 : 1)} kHz`;
    case "sec":
      return v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`;
    case "rate":
      return `${v < 1 ? v.toFixed(2) : v.toFixed(1)} Hz`;
    case "pct":
      return `${Math.round(v * 100)}%`;
    case "cents":
      return v ? `${Math.round(v)}¢` : "off";
    default:
      return v.toFixed(1);
  }
}

// ------------------------------------------------------------------------
//  SHARING
// ------------------------------------------------------------------------
// Packed as one bare list of numbers in SYNTH_ORDER — the wave is its index
// in the options, everything else is its own value. Joined with "-" because
// every value is non-negative and the decimal point is taken.
export function packSynth(sound) {
  return SYNTH_ORDER.map((k) => {
    const p = SYNTH_PARAMS[k];
    return p.kind === "enum" ? p.options.indexOf(sound[k]) : round3(sound[k]);
  }).join("-");
}

// Missing, malformed and out-of-range values all fall back to the default
// preset's value for that one parameter rather than throwing the lot away:
// a link written by an older build is short, not wrong.
export function unpackSynth(str) {
  const base = defaultSound();
  if (!str) return base;
  const parts = String(str).split("-");
  const out = { ...base };
  SYNTH_ORDER.forEach((k, i) => {
    const raw = parts[i];
    if (raw == null || raw === "") return;
    const p = SYNTH_PARAMS[k];
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

export const isDefaultSound = (sound) =>
  SYNTH_ORDER.every((k) => sameParam(k, sound[k], PRESETS[DEFAULT_PRESET][k]));

// ------------------------------------------------------------------------
//  DERIVED AUDIO SETTINGS
// ------------------------------------------------------------------------
// Still pure maths, so it belongs here rather than in the hook that applies it.

// Tone's fat oscillators are a separate type name, not a flag — and handing
// count/spread to a plain oscillator is an error, so the two travel together.
export const oscType = (wave, spread) => (spread > 0 ? `fat${wave}` : wave);

// The LFO drives the filter's cutoff outright (connecting a signal to a
// Tone.Signal replaces its value rather than adding to it), so the sweep's
// endpoints have to carry the cutoff setting themselves. Centred on the
// cutoff and measured in octaves, so the same depth sounds like the same
// sweep wherever you put the corner. Depth 0 collapses it to a constant,
// which is exactly a filter that isn't moving.
export function lfoRange(cutoff, depth) {
  const octaves = depth * 2.2;
  const f = Math.pow(2, octaves);
  return {
    min: clamp(cutoff / f, 30, 18000),
    max: clamp(cutoff * f, 30, 18000),
  };
}

// ------------------------------------------------------------------------
//  VELOCITY SHAPING
// ------------------------------------------------------------------------
// A chord played with every note at the same volume is an organ; a chord
// played by hands has a firm bass, a singing top and inner voices tucked
// under both. `dynamics` is how far apart those get, `humanise` scatters the
// result so no two chords land identically.
//
// `midi` must be in ascending pitch order — the shape is positional, and the
// caller sorts anyway to roll an arpeggio upward. `rand` is injected, not
// reached for, the same bargain suggestLoop makes: the function stays pure
// and a test can pin the sequence.
const FLAT = 0.8; // every voice at this level is where dynamics 0 lands
const TARGET = { bass: 1, top: 0.85, inner: 0.5, alone: 0.9 };

export function velocityCurve(midi, sound = {}, rand = Math.random) {
  const dynamics = clamp(Number(sound.dynamics) || 0, 0, 1);
  const humanise = clamp(Number(sound.humanise) || 0, 0, 1);
  const n = midi.length;
  return midi.map((_, i) => {
    const target =
      n === 1 ? TARGET.alone : i === 0 ? TARGET.bass : i === n - 1 ? TARGET.top : TARGET.inner;
    let velocity = FLAT + (target - FLAT) * dynamics;
    // two draws every time, whatever humanise is, so turning it down doesn't
    // reshuffle which note gets which wobble
    const vJitter = rand() * 2 - 1;
    const tJitter = rand();
    velocity = clamp(velocity * (1 + vJitter * 0.12 * humanise), 0.05, 1);
    return { velocity, delay: tJitter * 0.014 * humanise };
  });
}

// ------------------------------------------------------------------------
//  ARPEGGIO
// ------------------------------------------------------------------------
// The order an arpeggio plays a chord in: one note per step, the steps spread
// evenly over the chord's slot (the timing is the caller's job). `midi` must be
// ascending. `order` is "rise" (low to high) or "random" — a fresh shuffle
// every time the chord plays, so a loop never repeats itself exactly.
//
// `four` pads a three-note chord to four steps by coming back to the second
// note played — 1 3 5 3 when rising — so triads and seventh chords take the
// same four steps and the rhythm doesn't lurch between threes and fours.
// Chords of four or more notes play as they are. `rand` is injected, the same
// bargain velocityCurve makes.
export function arpSequence(midi, { four = false, order = "rise" } = {}, rand = Math.random) {
  const seq = [...midi];
  if (order === "random") {
    // Fisher–Yates: every order equally likely, n−1 draws
    for (let i = seq.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [seq[i], seq[j]] = [seq[j], seq[i]];
    }
  }
  if (four && seq.length === 3) seq.push(seq[1]);
  return seq;
}

// ------------------------------------------------------------------------
//  WHAT A CHORD PLAYS
// ------------------------------------------------------------------------
// A realised chord in, a list of note events out — { midi, at, dur, velocity },
// `at` in seconds from the chord's start — for the built-in synth and the MIDI
// port alike. Pure, `rand` injected: it feeds both the humanise scatter and a
// random arpeggio order.
//
// `upper` is the chord's voicing; `bass` is the bass voice's note, or null when
// that's off. Passed separately rather than as the lowest note, because it's
// not guaranteed to be the lowest: an inversion can roll an upper voice down
// past it.
//
//   block chord   every note at once, for `dur`
//   arpeggio      one note per step, the steps spread evenly over `span` (the
//                 whole slot in playback, so the last step runs straight into
//                 the next chord), each gated to 0.9 of its step — the
//                 envelope's release rings on past it
//   holdBass      with an arpeggio: the bass sounds for the whole of `dur`
//                 under an arpeggio of the upper voices, instead of being the
//                 arpeggio's first step. So with -4-, a triad over a bass is
//                 either B 1 3 5 (in the arp) or 1 3 5 3 over a held B.
export function chordEvents(upper, bass, opts = {}, rand = Math.random) {
  const {
    arp = false, four = false, order = "rise", holdBass = false,
    dur = 1.1, span = dur, sound = {},
  } = opts;
  const all = (bass == null ? [...upper] : [bass, ...upper]).sort((a, b) => a - b);
  // shaped over the whole chord, so the bass keeps the bass's weight either way
  const shaped = velocityCurve(all, sound, rand);
  const feel = (m) => shaped[all.indexOf(m)];
  const note = (m, at, d) => ({ midi: m, at: at + feel(m).delay, dur: d, velocity: feel(m).velocity });

  if (!arp || all.length < 2) return all.map((m) => note(m, 0, dur));

  const held = holdBass && bass != null;
  const pool = held ? [...upper].sort((a, b) => a - b) : all;
  const seq = arpSequence(pool, { four, order }, rand);
  const step = span / seq.length;
  const events = seq.map((m, k) => note(m, k * step, step * 0.9));
  return held ? [note(bass, 0, dur), ...events] : events;
}
