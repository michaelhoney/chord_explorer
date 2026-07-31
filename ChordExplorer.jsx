import React, { useState, useMemo, useRef, useCallback, useEffect } from "react";
import * as Tone from "tone";

/* ------------------------------------------------------------------ *
 *  CHORD PATHS — a functional-harmony explorer
 *  Pick a chord, hear it, and see where it can go next — with every
 *  move tagged by what it *does* (root motion + harmonic function).
 *  Colour encodes function: home / build / tension / outside.
 * ------------------------------------------------------------------ */

// --- pitch-class naming -------------------------------------------------
const SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT = ["C", "D♭", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "B"];
const FLAT_KEYS = new Set([1, 3, 5, 6, 8, 10]); // roots that read nicer in flats
const nameOf = (pc, root) => (FLAT_KEYS.has(root) ? FLAT : SHARP)[((pc % 12) + 12) % 12];

// --- scales -------------------------------------------------------------
const STEPS = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10], // natural minor; harmonic-minor dominant added as colour
  mixolydian: [0, 2, 4, 5, 7, 9, 10], // major with a ♭7 — that flat-seventh colour
};
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII"];
// scale degrees written with a ♭ prefix on their roman (flattened vs the major scale)
const FLAT_DEG = { mixolydian: new Set([6]) }; // ♭VII
const romanFor = (mode, d, q) =>
  (FLAT_DEG[mode]?.has(d) ? "♭" : "") +
  (q.upper ? ROMAN[d] : ROMAN[d].toLowerCase()) +
  q.romanSuffix;

// harmonic function + a rough "distance from home" tension value, per degree
const FUNC = {
  major: [
    ["tonic", 0], ["predominant", 2], ["tonic", 1], ["predominant", 2],
    ["dominant", 3], ["tonic", 1], ["dominant", 3],
  ],
  minor: [
    ["tonic", 0], ["predominant", 2], ["tonic", 1], ["predominant", 2],
    ["dominant", 2.5], ["tonic", 1], ["subtonic", 2.5],
  ],
  mixolydian: [
    ["tonic", 0], ["predominant", 2], ["tonic", 1.5], ["predominant", 2],
    ["dominant", 2], ["tonic", 1], ["subtonic", 2.5],
  ],
};

// --- classify a stack of thirds into a chord quality --------------------
function classify(intervals) {
  const has = (x) => intervals.includes(x);
  // suspended: no 3rd, a 2nd or 4th standing in for it (quality-neutral)
  if (!has(3) && !has(4) && (has(5) || has(2))) {
    const s = has(5) ? "sus4" : "sus2";
    return { triad: "sus", seventh: null, suffix: s, romanSuffix: s, upper: true };
  }
  let triad;
  if (has(4) && has(7)) triad = "maj";
  else if (has(3) && has(7)) triad = "min";
  else if (has(3) && has(6)) triad = "dim";
  else if (has(4) && has(8)) triad = "aug";
  else triad = "maj";
  let seventh = null;
  if (has(11)) seventh = "M7";
  else if (has(10)) seventh = "m7";
  else if (has(9)) seventh = "d7";

  let suffix = "", romanSuffix = "", upper = triad === "maj" || triad === "aug";
  if (triad === "maj") {
    if (seventh === "M7") { suffix = "maj7"; romanSuffix = "maj7"; }
    else if (seventh === "m7") { suffix = "7"; romanSuffix = "7"; }
  } else if (triad === "min") {
    suffix = "m";
    if (seventh === "m7") { suffix = "m7"; romanSuffix = "7"; }
    else if (seventh === "M7") { suffix = "m(maj7)"; romanSuffix = "maj7"; }
  } else if (triad === "dim") {
    suffix = "°"; romanSuffix = "°";
    if (seventh === "m7") { suffix = "m7♭5"; romanSuffix = "ø7"; }
    else if (seventh === "d7") { suffix = "°7"; romanSuffix = "°7"; }
  } else if (triad === "aug") {
    suffix = "+"; romanSuffix = "+";
  }
  return { triad, seventh, suffix, romanSuffix, upper };
}

// map function -> palette role
function hueOf(func) {
  if (func === "tonic") return "home";
  if (func === "predominant" || func === "subtonic") return "build";
  if (func === "dominant") return "tension";
  return "outside"; // secondary / borrowed
}

const mod12 = (n) => ((n % 12) + 12) % 12;

// the distinct pitch classes of a chord, in chord-tone order (root, 3rd, 5th, 7th…)
function chordPitchClasses(chord) {
  const seen = new Set();
  const out = [];
  chord.intervals.forEach((i) => {
    const pc = mod12(chord.rootPc + i);
    if (!seen.has(pc)) { seen.add(pc); out.push(pc); }
  });
  return out;
}

// the note names of a chord's tones, spelled to suit the key
function chordNoteNames(chord, keyRoot) {
  return chordPitchClasses(chord).map((pc) => nameOf(pc, keyRoot));
}

// midi note of pitch-class `pc` placed in the octave closest to `target`
const nearestMidi = (pc, target) => pc + 12 * Math.round((target - pc) / 12);

// plain root position — the chord's own tones, stacked from C4
function rootPositionMidi(chord) {
  const rootMidi = 60 + mod12(chord.rootPc); // C4..B4
  return chord.intervals.map((i) => rootMidi + i);
}

// voice-led realisation: place each new tone in the octave nearest to the
// previous chord's notes, so common tones hold and the rest step. Inversions
// fall out of this — no explicit inversion bookkeeping needed.
function voiceLeadMidi(prevMidi, chord) {
  const pcs = chordPitchClasses(chord);
  if (!prevMidi || !prevMidi.length) {
    // first chord: settle a plain root position around A3–C4
    const rootMidi = nearestMidi(chord.rootPc, 57);
    return chord.intervals.map((i) => rootMidi + i).sort((a, b) => a - b);
  }
  return pcs
    .map((pc) => {
      let best = null, bestDist = Infinity;
      for (const p of prevMidi) {
        const cand = nearestMidi(pc, p);
        const d = Math.abs(cand - p);
        if (d < bestDist) { bestDist = d; best = cand; }
      }
      return best;
    })
    .sort((a, b) => a - b);
}

// "inversion scrolling": roll a voicing by octaves at its extremes. inv > 0 moves
// the lowest note up an octave (repeatably — the new lowest rolls next); inv < 0
// moves the highest note down. Applied on top of the derived voicing, per chord,
// so a nudge stays local and doesn't re-shuffle the rest of the chain.
function applyInversion(notes, inv) {
  if (!inv) return notes;
  const out = [...notes];
  for (let k = 0; k < Math.abs(inv); k++) {
    let idx = 0;
    for (let j = 1; j < out.length; j++) {
      if (inv > 0 ? out[j] < out[idx] : out[j] > out[idx]) idx = j;
    }
    out[idx] += inv > 0 ? 12 : -12;
  }
  return out;
}

// realise a whole progression as midi-note arrays, chaining voice leading, then
// applying each chord's stored inversion shift (voicing stays derived from prog)
function computeVoicings(prog, voiceLead) {
  let base;
  if (!voiceLead) {
    base = prog.map(rootPositionMidi);
  } else {
    base = [];
    let prev = null;
    for (const c of prog) {
      const v = voiceLeadMidi(prev, c);
      base.push(v);
      prev = v;
    }
  }
  return base.map((v, i) => applyInversion(v, prog[i].inv || 0));
}

const midiToNotes = (midi) => midi.map((m) => Tone.Frequency(m, "midi").toNote());

// "edit distance" between two realised chords: the combined keyboard travel of
// their voices, paired by ascending pitch (the same pairing the roll's connectors
// draw). A triad up two semitones = 3×2 = 6; major → sus4 = 1 (just the 3rd steps).
// Lower means smoother — the metric for minimal-motion progressions.
function voicingDistance(a, b) {
  if (!a || !b) return 0;
  const x = [...a].sort((p, q) => p - q);
  const y = [...b].sort((p, q) => p - q);
  let d = 0;
  for (let v = 0; v < Math.min(x.length, y.length); v++) d += Math.abs(x[v] - y[v]);
  return d;
}

// distance from a realised chord to a candidate option, voiced the way `choose`
// would voice it — so a chooser card previews the motion picking it would cost
function optionDistance(prevMidi, opt, voiceLead) {
  if (!prevMidi) return null;
  const optMidi = voiceLead ? voiceLeadMidi(prevMidi, opt) : rootPositionMidi(opt);
  return voicingDistance(prevMidi, optMidi);
}

// the lowest sounding note's name — for slash-chord display of inversions
const bassNameOf = (midi, keyRoot) =>
  midi && midi.length ? nameOf(mod12(Math.min(...midi)), keyRoot) : null;

// --- build the diatonic set + colour chords for a key -------------------
function buildKey(root, mode) {
  const scale = STEPS[mode].map((s) => (root + s) % 12);

  const diatonic = scale.map((_, d) => {
    const idx = [d, d + 2, d + 4];
    const pcs = idx.map((i) => scale[i % 7]);
    const r = pcs[0];
    const intervals = pcs.map((pc) => (((pc - r) % 12) + 12) % 12);
    const q = classify(intervals);
    const [func, tension] = FUNC[mode][d];
    const roman = romanFor(mode, d, q);
    return {
      rootPc: r,
      intervals,
      quality: q,
      name: nameOf(r, root) + q.suffix,
      roman,
      degree: d + 1,
      func,
      tension,
      group: "in-key",
      resolvesTo: null,
    };
  });

  const colour = [];
  const mk = (rootPc, ints, roman, func, tension, desc, resolvesTo = null) => {
    const q = classify(ints);
    return {
      rootPc,
      intervals: ints,
      quality: q,
      name: nameOf(rootPc, root) + q.suffix,
      roman,
      degree: null,
      func,
      tension,
      group: "colour",
      resolvesTo,
      colourDesc: desc,
    };
  };

  if (mode === "major") {
    // secondary dominants of ii, iii, IV, V, vi
    [1, 2, 3, 4, 5].forEach((d) => {
      const target = diatonic[d];
      const secRoot = (target.rootPc + 7) % 12;
      colour.push(
        mk(
          secRoot,
          [0, 4, 7, 10],
          "V7/" + target.roman.replace(/7|maj7/g, ""),
          "secondary",
          4,
          `Secondary dominant — briefly makes ${target.name} feel like home. Wants to resolve to ${target.name}.`,
          target.rootPc
        )
      );
    });
    // borrowed from the parallel minor
    colour.push(mk((root + 5) % 12, [0, 3, 7], "iv", "borrowed", 2.5,
      "Borrowed minor iv — bittersweet; the flattened sixth leans down toward the fifth."));
    colour.push(mk((root + 10) % 12, [0, 4, 7], "♭VII", "borrowed", 2.5,
      "Borrowed ♭VII — modal, rock/folk flavour; a whole step below home."));
    colour.push(mk((root + 8) % 12, [0, 4, 7], "♭VI", "borrowed", 2.5,
      "Borrowed ♭VI — cinematic lift straight out of the parallel minor."));
  } else if (mode === "minor") {
    // harmonic-minor dominant: the real pull back to the minor tonic
    colour.push(mk((root + 7) % 12, [0, 4, 7], "V", "dominant", 3,
      "Major dominant (raised leading tone) — the strong pull back to the minor tonic.",
      root));
    colour.push(mk((root + 7) % 12, [0, 4, 7, 10], "V7", "dominant", 3.5,
      "Dominant 7th — that tritone really wants to resolve home to the minor tonic.",
      root));
    colour.push(mk((root + 11) % 12, [0, 3, 6], "vii°", "dominant", 3.5,
      "Leading-tone diminished — tense, resolves up into the tonic.",
      root));
    colour.push(mk((root + 5) % 12, [0, 4, 7], "IV", "borrowed", 2.5,
      "Major IV (Dorian colour) — brightens the minor subdominant."));
    colour.push(mk((root + 8) % 12, [0, 4, 7, 10], "V7/III", "secondary", 4,
      `Secondary dominant — sets up the relative major (${nameOf((root + 3) % 12, root)}).`,
      (root + 3) % 12));
  } else if (mode === "mixolydian") {
    // borrow Ionian's leading tone when you want a real cadence instead of the soft v
    colour.push(mk((root + 7) % 12, [0, 4, 7], "V", "dominant", 3,
      "Major V (borrowed leading tone) — a stronger pull home than the modal v.",
      root));
    colour.push(mk((root + 7) % 12, [0, 4, 7, 10], "V7", "dominant", 3.5,
      "Dominant 7th — the leading-tone cadence, if you want to leave Mixolydian for a moment.",
      root));
    // secondary dominant of the signature ♭VII
    colour.push(mk((root + 5) % 12, [0, 4, 7, 10], "V7/♭VII", "secondary", 4,
      `Secondary dominant — sets up the ♭VII (${nameOf((root + 10) % 12, root)}).`,
      (root + 10) % 12));
    // parallel-minor ♭VI, the cinematic lift
    colour.push(mk((root + 8) % 12, [0, 4, 7], "♭VI", "borrowed", 2.5,
      "Borrowed ♭VI — cinematic lift from the parallel minor."));
  }

  return { diatonic, colour, root, mode, scale };
}

// sus2 / sus4 forms of the key's plain major/minor triads. The 3rd is swapped for
// a 2nd (open) or 4th (leaning), so they're quality-neutral; each one resolves to
// its own plain triad, which is the classic suspension → resolution gesture.
function suspensionsFor(key) {
  const out = [];
  key.diatonic.forEach((c) => {
    if (c.quality.triad !== "maj" && c.quality.triad !== "min") return; // skip °/+
    const baseRoman = ROMAN[c.degree - 1];
    const triadName = nameOf(c.rootPc, key.root); // the resolution target's name
    [
      ["sus2", [0, 2, 7], `Suspended 2nd — open and unresolved; settles onto ${triadName}.`],
      ["sus4", [0, 5, 7], `Suspended 4th — the 4th leans on the 3rd; resolves down to ${triadName}.`],
    ].forEach(([kind, ints, desc]) => {
      const q = classify(ints);
      out.push({
        rootPc: c.rootPc,
        intervals: ints,
        quality: q,
        name: nameOf(c.rootPc, key.root) + q.suffix,
        roman: baseRoman + kind,
        degree: null,
        func: c.func,
        tension: c.tension + 0.5, // a touch more tense than the triad it resolves to
        group: "colour",
        resolvesTo: c.rootPc,
        colourDesc: desc,
      });
    });
  });
  return out;
}

// --- root-motion label --------------------------------------------------
const MOTION = {
  0: "same root", 1: "up a semitone", 2: "up a whole step", 3: "up a minor third",
  4: "up a major third", 5: "up a fourth", 6: "a tritone", 7: "up a fifth",
  8: "down a major third", 9: "down a minor third", 10: "down a whole step",
  11: "down a semitone",
};
const motionLabel = (from, to) => MOTION[(((to - from) % 12) + 12) % 12];

// --- contextual "what this move does" -----------------------------------
const SPECIAL = {
  major: {
    "5>1": "Authentic cadence — the dominant resolves home. The strongest landing.",
    "7>1": "Leading-tone snap — tension resolves straight to the tonic.",
    "4>1": "Plagal cadence — the gentle ‘Amen’ home.",
    "5>6": "Deceptive cadence — you expect home, you get the relative minor.",
    "2>5": "ii–V — the smoothest possible setup for the dominant.",
    "4>5": "Subdominant into dominant — winding the spring.",
    "1>4": "Steps away from home into subdominant space.",
    "1>5": "Straight to the dominant — poised to return.",
    "1>2": "Eases into predominant space.",
    "1>6": "Slips to the relative minor — same family, softer light.",
    "6>4": "Predominant motion, heading for the dominant.",
    "6>2": "Predominant motion, heading for the dominant.",
    "3>6": "Falling fifths — pulled toward the tonic family.",
  },
  minor: {
    "5>1": "Dominant resolves to the minor tonic (strongest with the raised leading tone).",
    "7>3": "Subtonic falls to the relative major — a bright exit.",
    "1>4": "Into the brooding minor subdominant.",
    "4>5": "Building toward the dominant.",
    "1>6": "Lifts to the submediant — a shaft of major light.",
    "1>7": "Down a step to the subtonic — modal, folk/rock colour.",
  },
  mixolydian: {
    "7>1": "♭VII → I — the signature Mixolydian cadence; a whole-step drop home.",
    "1>7": "Down to ♭VII — leans into that flat-seventh colour.",
    "4>1": "Plagal — the gentle ‘Amen’ home.",
    "5>1": "Soft modal cadence — minor v eases home, no leading tone.",
    "1>4": "Opens into the bright subdominant.",
    "1>5": "To the modal v — mellower than a major dominant.",
    "4>7": "IV to ♭VII — the classic two-chord Mixolydian vamp.",
  },
};
const ROLE = {
  major: {
    1: "Home — the tonic, point of rest.",
    2: "Predominant — sets up the dominant.",
    3: "Mediant colour — wistful; shares tones with I and V.",
    4: "Subdominant — opens the harmony up.",
    5: "The dominant — pulls hard toward home.",
    6: "Relative minor — a softer resting point.",
    7: "Leading-tone chord — tense, wants to resolve up.",
  },
  minor: {
    1: "Home — the minor tonic.",
    2: "Predominant (ii°) — leans toward the dominant.",
    3: "Relative major — a brighter resting point.",
    4: "Minor subdominant — brooding predominant.",
    5: "Weak dominant (v). For a real pull, reach for the major V in Colour.",
    6: "Submediant — lush, borrowed-from-major brightness.",
    7: "Subtonic — the modal step below; folk/rock, or a route to III.",
  },
  mixolydian: {
    1: "Home — the Mixolydian tonic (major, but with a ♭7 in the air).",
    2: "Supertonic minor — a gentle predominant.",
    3: "Diminished mediant — tense, best as a passing chord.",
    4: "Subdominant — bright, opens the harmony up.",
    5: "Minor v — the soft modal dominant, no leading tone.",
    6: "Submediant minor — a mellow resting point.",
    7: "♭VII — the signature Mixolydian chord, a whole step below home.",
  },
};

function moveDescription(mode, fromDeg, to) {
  if (to.group === "colour") return to.colourDesc;
  const roleTxt = ROLE[mode][to.degree];
  if (fromDeg == null) return roleTxt;
  const s = SPECIAL[mode][`${fromDeg}>${to.degree}`];
  return s || roleTxt;
}

// ordering: how idiomatic is from-function -> to-function
function score(fromFunc, to) {
  const f = fromFunc, g = to.func;
  const m = {
    tonic: { predominant: 3, dominant: 3, tonic: 1, borrowed: 2, secondary: 2, subtonic: 2 },
    predominant: { dominant: 3, tonic: 1, predominant: 1, borrowed: 1, secondary: 2, subtonic: 1 },
    dominant: { tonic: 3, borrowed: 1, predominant: 1, secondary: 1, dominant: 0, subtonic: 1 },
    subtonic: { tonic: 2, predominant: 2, dominant: 2, secondary: 1, borrowed: 1 },
    secondary: { tonic: 2, dominant: 2, predominant: 2, borrowed: 1, secondary: 1, subtonic: 1 },
    borrowed: { tonic: 2, dominant: 2, predominant: 2, borrowed: 1, secondary: 1, subtonic: 1 },
  };
  return (m[f] && m[f][g]) || 1;
}

// how "reach-for-it obvious" a destination is, breaking ties within a function
const SAL_MAJOR = { 1: 0.95, 2: 0.7, 3: 0.4, 4: 0.9, 5: 1.0, 6: 0.6, 7: 0.45 };
const SAL_MINOR = { 1: 0.9, 2: 0.6, 3: 0.55, 4: 0.85, 5: 0.5, 6: 0.65, 7: 0.75 };
function salience(mode, chord) {
  if (chord.group === "colour")
    return chord.func === "dominant" ? 0.9 : chord.func === "secondary" ? 0.5 : 0.4;
  return (mode === "minor" ? SAL_MINOR : SAL_MAJOR)[chord.degree] || 0.5;
}

// build the option list from the current chord
function optionsFrom(current, key) {
  const fromFunc = current ? current.func : null;
  const fromDeg = current ? current.degree : null;

  const decorate = (c) => ({
    ...c,
    move: moveDescription(key.mode, fromDeg, c),
    motion: current ? motionLabel(current.rootPc, c.rootPc) : null,
    resolution:
      current && current.resolvesTo != null && current.resolvesTo === c.rootPc,
  });

  const rank = (c) =>
    score(fromFunc, c) * 10 + salience(key.mode, c) + (c.resolution ? 100 : 0);

  let inKey = key.diatonic.map(decorate);
  if (current) {
    inKey = inKey.map((c) =>
      c.resolution
        ? { ...c, move: `Resolution — lands home on ${c.name}, releasing the previous chord’s tension.` }
        : c
    );
    inKey.sort((a, b) => rank(b) - rank(a) || a.degree - b.degree);
  } else {
    inKey.sort((a, b) => a.degree - b.degree);
  }
  const colour = key.colour.map(decorate);
  const sus = (key.suspensions || []).map(decorate);
  return { inKey, colour, sus };
}

// ------------------------------------------------------------------------
//  AUDIO
// ------------------------------------------------------------------------
function useSynth() {
  const ref = useRef(null);
  const ensure = useCallback(async () => {
    if (!ref.current) {
      await Tone.start();
      const synth = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: "triangle" },
        envelope: { attack: 0.015, decay: 0.25, sustain: 0.55, release: 1.3 },
      });
      synth.volume.value = -9;
      const rev = new Tone.Reverb({ decay: 2.2, wet: 0.22 });
      synth.chain(rev, Tone.Destination);
      ref.current = synth;
    } else if (Tone.getContext().state !== "running") {
      await Tone.start();
    }
    return ref.current;
  }, []);
  return ensure;
}

// ------------------------------------------------------------------------
//  UI
// ------------------------------------------------------------------------
const HUE = {
  home: "var(--home)",
  build: "var(--build)",
  tension: "var(--tension)",
  outside: "var(--outside)",
};
const HUE_LABEL = {
  home: "Home",
  build: "Build",
  tension: "Tension",
  outside: "Outside",
};

// buildKey, restacked with sevenths when add7 is on — pure, so URL decode can
// rebuild the exact chord pool a saved progression was chosen from.
function resolveKey(root, mode, add7) {
  const base = buildKey(root, mode);
  if (!add7) return base;
  const scale = base.scale;
  const diatonic = scale.map((_, d) => {
    const idx = [d, d + 2, d + 4, d + 6];
    const pcs = idx.map((i) => scale[i % 7]);
    const r = pcs[0];
    const intervals = pcs.map((pc) => (((pc - r) % 12) + 12) % 12);
    const q = classify(intervals);
    const [func, tension] = FUNC[mode][d];
    const roman = romanFor(mode, d, q);
    return {
      rootPc: r, intervals, quality: q, name: nameOf(r, root) + q.suffix,
      roman, degree: d + 1, func, tension, group: "in-key", resolvesTo: null,
    };
  });
  return { ...base, diatonic };
}

// --- shareable state via querystring ---
// A chord is identified by root + intervals; the reader rebuilds the key's chord
// pool and looks each one up, so links carry no derived data (voicings stay derived).
const chordToken = (c) => {
  const base = `${c.rootPc}.${c.intervals.join("-")}`;
  return c.inv ? `${base}~${c.inv}` : base; // trailing ~N carries the inversion shift
};

function encodeState(s) {
  const p = new URLSearchParams();
  p.set("k", s.root);
  if (s.mode === "minor") p.set("m", "min");
  else if (s.mode === "mixolydian") p.set("m", "mixo");
  if (s.add7) p.set("s7", "1");
  if (!s.voiceLead) p.set("vl", "0"); // on by default; only record when turned off
  if (s.arp) p.set("arp", "1");
  if (s.susOn) p.set("su", "1");
  if (s.tempo !== 96) p.set("t", s.tempo);
  if (s.prog.length) p.set("p", s.prog.map(chordToken).join("_"));
  return p.toString();
}

function decodeState(search) {
  const p = new URLSearchParams(search);
  if (![...p.keys()].length) return null;
  const clampNum = (v, def, lo, hi) => {
    if (v == null || v === "") return def; // absent param → default (Number(null) is 0!)
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : def;
  };
  const root = clampNum(p.get("k"), 0, 0, 11);
  const mode = p.get("m") === "min" ? "minor" : p.get("m") === "mixo" ? "mixolydian" : "major";
  const add7 = p.get("s7") === "1";
  const voiceLead = p.get("vl") !== "0"; // default on; also honours legacy vl=1
  const arp = p.get("arp") === "1";
  const susOn = p.get("su") === "1";
  const tempo = clampNum(p.get("t"), 96, 60, 140);
  const pool = (() => {
    const key = resolveKey(root, mode, add7);
    // suspensions always in the lookup pool so a shared progression reconstitutes
    return [...key.diatonic, ...key.colour, ...suspensionsFor(key)];
  })();
  const prog = [];
  const raw = p.get("p");
  if (raw) {
    for (const tok of raw.split("_")) {
      const [chordPart, invPart] = tok.split("~");
      const inv = invPart ? clampNum(invPart, 0, -24, 24) : 0;
      const [rp, iv] = chordPart.split(".");
      const rootPc = Number(rp);
      const intervals = iv ? iv.split("-").map(Number) : [];
      const match = pool.find(
        (c) =>
          c.rootPc === rootPc &&
          c.intervals.length === intervals.length &&
          c.intervals.every((x, i) => x === intervals[i])
      );
      if (!match) break; // unknown chord — stop rather than guess
      // decorate like optionsFrom so a reconstituted chord matches a chosen one
      const prev = prog.length ? prog[prog.length - 1] : null;
      const resolution =
        !!prev && prev.resolvesTo != null && prev.resolvesTo === match.rootPc;
      prog.push({
        ...match,
        id: prog.length + 1,
        inv,
        motion: prev ? motionLabel(prev.rootPc, match.rootPc) : null,
        resolution,
        move: resolution
          ? `Resolution — lands home on ${match.name}, releasing the previous chord’s tension.`
          : moveDescription(mode, prev ? prev.degree : null, match),
      });
    }
  }
  return { root, mode, add7, voiceLead, arp, susOn, tempo, prog };
}

export default function ChordExplorer() {
  const boot = useMemo(() => decodeState(window.location.search) || {}, []);
  const [root, setRoot] = useState(boot.root ?? 0);
  const [mode, setMode] = useState(boot.mode ?? "major");
  const [add7, setAdd7] = useState(boot.add7 ?? false);
  const [voiceLead, setVoiceLead] = useState(boot.voiceLead ?? true);
  const [arp, setArp] = useState(boot.arp ?? false);
  const [susOn, setSusOn] = useState(boot.susOn ?? false);
  const [tempo, setTempo] = useState(boot.tempo ?? 96);
  const [prog, setProg] = useState(boot.prog ?? []);
  const [playingIdx, setPlayingIdx] = useState(-1);
  const ensure = useSynth();
  const uid = useRef(boot.prog?.length ?? 0);

  // when add7 is on, restack diatonic chords with sevenths; always carry the
  // suspension palette (shown only when the Sus toggle is on)
  const key = useMemo(() => {
    const k = resolveKey(root, mode, add7);
    return { ...k, suspensions: suspensionsFor(k) };
  }, [root, mode, add7]);

  // keep the URL in sync so any state is bookmarkable / shareable
  useEffect(() => {
    const qs = encodeState({ root, mode, add7, voiceLead, arp, susOn, tempo, prog });
    const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    window.history.replaceState(null, "", url);
  }, [root, mode, add7, voiceLead, arp, susOn, tempo, prog]);

  const current = prog.length ? prog[prog.length - 1] : null;
  const { inKey, colour, sus } = useMemo(() => optionsFrom(current, key), [current, key]);

  // midi voicings for the whole progression, chained when voice-leading is on
  const voicings = useMemo(() => computeVoicings(prog, voiceLead), [prog, voiceLead]);

  // total voice movement across the whole progression — lower is smoother
  const totalMotion = useMemo(() => {
    let d = 0;
    for (let i = 1; i < voicings.length; i++) d += voicingDistance(voicings[i - 1], voicings[i]);
    return d;
  }, [voicings]);

  // the current chord's realised voicing — the "from" point for chooser distances
  const fromMidi = voicings.length ? voicings[voicings.length - 1] : null;

  const playVoiced = useCallback(
    async (midi, dur = 1.1, when) => {
      const synth = await ensure();
      const t = when ?? Tone.now();
      if (arp && midi.length > 1) {
        // roll the notes up low-to-high (inversion shifts leave midi unsorted)
        const notes = midiToNotes([...midi].sort((a, b) => a - b));
        const stagger = Math.min(dur * 0.22, 0.16);
        notes.forEach((n, i) => {
          synth.triggerAttackRelease(n, dur - i * stagger, t + i * stagger);
        });
      } else {
        synth.triggerAttackRelease(midiToNotes(midi), dur, t);
      }
    },
    [ensure, arp]
  );

  const preview = useCallback(
    (opt) => {
      // taste the chord without committing it — same voicing choose would use
      const prevMidi = voiceLead && voicings.length ? voicings[voicings.length - 1] : null;
      const midi = voiceLead ? voiceLeadMidi(prevMidi, opt) : rootPositionMidi(opt);
      playVoiced(midi, 0.8);
    },
    [voiceLead, voicings, playVoiced]
  );

  const choose = useCallback(
    async (opt) => {
      // realise the new chord from the current chain end so it matches the recompute
      const prevMidi = voiceLead && voicings.length ? voicings[voicings.length - 1] : null;
      const midi = voiceLead ? voiceLeadMidi(prevMidi, opt) : rootPositionMidi(opt);
      const chord = { ...opt, id: ++uid.current };
      setProg((p) => [...p, chord]);
      await playVoiced(midi);
    },
    [voiceLead, voicings, playVoiced]
  );

  const playAll = useCallback(async () => {
    if (!prog.length) return;
    await ensure();
    const beat = 60 / tempo;
    const step = beat * 2; // one chord = a half note
    const t0 = Tone.now() + 0.06;
    prog.forEach((c, i) => {
      playVoiced(voicings[i], step * 0.92, t0 + i * step);
      const ms = (t0 + i * step - Tone.now()) * 1000;
      setTimeout(() => setPlayingIdx(i), Math.max(0, ms));
    });
    const total = (t0 + prog.length * step - Tone.now()) * 1000;
    setTimeout(() => setPlayingIdx(-1), total);
  }, [prog, tempo, ensure, playVoiced, voicings]);

  const undo = () => setProg((p) => p.slice(0, -1));
  const clear = () => setProg([]);

  // inversion scrolling: nudge one chord's register by an octave at its extreme,
  // and play the result so the change is audible
  const invert = useCallback(
    (i, dir) => {
      setProg((p) =>
        p.map((c, j) => (j === i ? { ...c, inv: (c.inv || 0) + dir } : c))
      );
      if (voicings[i]) playVoiced(applyInversion(voicings[i], dir), 0.8);
    },
    [voicings, playVoiced]
  );
  const changeKey = (r, m) => { setRoot(r); setMode(m); setProg([]); };

  const [copied, setCopied] = useState(false);
  const share = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
    } catch {
      // clipboard blocked (insecure context / permissions) — select-and-copy fallback
      const el = document.createElement("textarea");
      el.value = window.location.href;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      el.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }, []);

  return (
    <div className="ce-root">
      <style>{CSS}</style>

      <header className="ce-head">
        <div className="ce-brand">
          <span className="ce-mark" aria-hidden="true">↳</span>
          <div>
            <h1>Chord Paths</h1>
            <p className="ce-sub">
              Pick a chord, hear it, and follow where it wants to go — every move
              tagged with what it <em>does</em>.
            </p>
          </div>
        </div>

        <div className="ce-controls">
          <label className="ce-field">
            <span>Key</span>
            <select
              value={root}
              onChange={(e) => changeKey(Number(e.target.value), mode)}
            >
              {SHARP.map((_, i) => (
                <option key={i} value={i}>
                  {nameOf(i, i)}
                </option>
              ))}
            </select>
          </label>

          <div className="ce-seg" role="group" aria-label="Mode">
            {[["major", "major"], ["minor", "minor"], ["mixolydian", "mixo"]].map(([m, label]) => (
              <button
                key={m}
                className={mode === m ? "on" : ""}
                aria-pressed={mode === m}
                title={m}
                onClick={() => changeKey(root, m)}
              >
                {label}
              </button>
            ))}
          </div>

          <button
            className={"ce-toggle" + (add7 ? " on" : "")}
            aria-pressed={add7}
            onClick={() => setAdd7((v) => !v)}
            title="Add sevenths to the diatonic chords"
          >
            7ths
          </button>

          <button
            className={"ce-toggle" + (susOn ? " on" : "")}
            aria-pressed={susOn}
            onClick={() => setSusOn((v) => !v)}
            title="Offer suspended chords (sus2 / sus4) that resolve to their triad"
          >
            Sus
          </button>

          <button
            className={"ce-toggle" + (voiceLead ? " on" : "")}
            aria-pressed={voiceLead}
            onClick={() => setVoiceLead((v) => !v)}
            title="Use inversions to minimise the distance each voice moves between chords"
          >
            Voice-leading
          </button>

          <button
            className={"ce-toggle" + (arp ? " on" : "")}
            aria-pressed={arp}
            onClick={() => setArp((v) => !v)}
            title="Roll each chord's notes up one at a time instead of playing them together"
          >
            Arpeggio
          </button>

          <label className="ce-field ce-tempo">
            <span>Tempo {tempo}</span>
            <input
              type="range" min="60" max="140" value={tempo}
              onChange={(e) => setTempo(Number(e.target.value))}
            />
          </label>
        </div>
      </header>

      {/* progression + tension curve */}
      <section className="ce-track">
        <div className="ce-track-head">
          <span className="ce-eyebrow">
            Progression
            {prog.length > 1 && (
              <span className="ce-total-motion" title="Total semitones of voice movement across the progression — lower is smoother">
                {" · "}Δ{totalMotion} total
              </span>
            )}
          </span>
          <div className="ce-transport">
            <button onClick={playAll} disabled={!prog.length}>▶ Play</button>
            <button onClick={undo} disabled={!prog.length}>Undo</button>
            <button onClick={clear} disabled={!prog.length}>Clear</button>
            <button
              className={"ce-share" + (copied ? " copied" : "")}
              onClick={share}
              disabled={!prog.length}
              title="Copy a link to this progression"
            >
              {copied ? "✓ Copied" : "Share"}
            </button>
          </div>
        </div>

        {prog.length ? (
          <>
            <PianoRoll
              prog={prog}
              voicings={voicings}
              playingIdx={playingIdx}
              keyRoot={key.root}
              onPlay={(i) => playVoiced(voicings[i])}
              onPlayNote={(m) => playVoiced([m])}
              onInvert={invert}
            />
          </>
        ) : (
          <p className="ce-empty">
            Choose any chord below to begin. It plays, then shows you the moves
            that follow — and what each one does.
          </p>
        )}
      </section>

      {/* current chord + legend */}
      {current && (
        <section className="ce-now">
          <div
            className="ce-now-badge"
            style={{ "--c": HUE[hueOf(current.func)] }}
          >
            <span className="ce-now-roman">{current.roman}</span>
            <span className="ce-now-name">{current.name}</span>
            <span className="ce-now-notes">{chordNoteNames(current, key.root).join(" ")}</span>
            <span className="ce-now-func">{current.func}</span>
          </div>
          <p className="ce-now-cue">Where to next?</p>
        </section>
      )}

      {/* options */}
      <section className="ce-options">
        <div className="ce-group-head">
          <span className="ce-eyebrow">
            {current ? "In key" : "Start on any chord"}
          </span>
        </div>
        <div className="ce-grid">
          {inKey.map((o) => (
            <ChordCard key={o.roman + o.rootPc} opt={o} onPick={choose} onPreview={preview} keyRoot={key.root} dist={optionDistance(fromMidi, o, voiceLead)} />
          ))}
        </div>

        <div className="ce-group-head ce-colour-head">
          <span className="ce-eyebrow">Colour — borrowed &amp; secondary</span>
          <span className="ce-hint">outside the key, for tension and surprise</span>
        </div>
        <div className="ce-grid">
          {colour.map((o) => (
            <ChordCard key={o.roman + o.rootPc} opt={o} onPick={choose} onPreview={preview} keyRoot={key.root} dist={optionDistance(fromMidi, o, voiceLead)} />
          ))}
        </div>

        {susOn && (
          <>
            <div className="ce-group-head ce-colour-head">
              <span className="ce-eyebrow">Suspensions — sus2 &amp; sus4</span>
              <span className="ce-hint">the 3rd steps aside; each one resolves to its triad</span>
            </div>
            <div className="ce-grid">
              {sus.map((o) => (
                <ChordCard key={o.roman + o.rootPc} opt={o} onPick={choose} onPreview={preview} keyRoot={key.root} dist={optionDistance(fromMidi, o, voiceLead)} />
              ))}
            </div>
          </>
        )}
      </section>

      <footer className="ce-legend">
        {["home", "build", "tension", "outside"].map((h) => (
          <span key={h} className="ce-leg">
            <i style={{ background: HUE[h] }} />
            {HUE_LABEL[h]}
          </span>
        ))}
        <span className="ce-leg-note">Colour shows what a chord does to the harmony.</span>
      </footer>
    </div>
  );
}

function ChordCard({ opt, onPick, onPreview, keyRoot, dist }) {
  const hue = hueOf(opt.func);
  return (
    <button
      className={"ce-card" + (opt.resolution ? " resolve" : "")}
      style={{ "--c": HUE[hue] }}
      onClick={() => onPick(opt)}
    >
      <div className="ce-card-top">
        <span className="ce-card-name" onMouseEnter={() => onPreview(opt)}>{opt.name}</span>
        <span className="ce-card-tr">
          <span className="ce-card-roman">{opt.roman}</span>
          {dist != null && (
            <span
              className={"ce-chip-dist" + (dist <= 2 ? " smooth" : dist >= 7 ? " far" : "")}
              title={`${dist} semitone${dist === 1 ? "" : "s"} of voice movement from the current chord`}
            >
              Δ{dist}
            </span>
          )}
        </span>
      </div>
      <span className="ce-card-notes">{chordNoteNames(opt, keyRoot).join(" ")}</span>
      {opt.motion && <span className="ce-card-motion">root {opt.motion}</span>}
      <span className="ce-card-move">{opt.move}</span>
    </button>
  );
}

// piano-roll progression: each voice sits at its pitch height, so common tones
// line up across columns and the voice leading is visible. Faint connectors trace
// each voice from one chord to the next; the chord tile sits underneath.
const ROLL = { ROW: 11, CELL: 18, COL: 84, GAP: 10 }; // px per semitone, pill, column, gap

const Chevron = ({ up }) => (
  <svg viewBox="0 0 12 8" width="11" height="7" aria-hidden="true" focusable="false">
    <path
      d={up ? "M1.5 6 L6 1.5 L10.5 6" : "M1.5 2 L6 6.5 L10.5 2"}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

function PianoRoll({ prog, voicings, playingIdx, keyRoot, onPlay, onPlayNote, onInvert }) {
  const { ROW, CELL, COL, GAP } = ROLL;
  const all = voicings.flat();
  if (!all.length) return null;
  const max = Math.max(...all);
  const min = Math.min(...all);
  const bandH = (max - min) * ROW + CELL;
  const width = prog.length * COL + Math.max(0, prog.length - 1) * GAP;
  const topOf = (m) => (max - m) * ROW; // pill top
  const cx = (i) => i * (COL + GAP) + COL / 2; // column centre
  const cy = (m) => topOf(m) + CELL / 2; // pill centre

  // connectors: pair voices by ascending pitch order across adjacent chords
  const links = [];
  for (let i = 0; i < voicings.length - 1; i++) {
    const a = [...voicings[i]].sort((p, q) => p - q);
    const b = [...voicings[i + 1]].sort((p, q) => p - q);
    for (let v = 0; v < Math.min(a.length, b.length); v++) {
      links.push({
        x1: cx(i), y1: cy(a[v]), x2: cx(i + 1), y2: cy(b[v]), held: a[v] === b[v],
      });
    }
  }

  return (
    <div className="ce-roll">
      <div className="ce-roll-inner" style={{ width }}>
        <svg className="ce-roll-links" width={width} height={bandH} aria-hidden="true">
          {links.map((l, k) => (
            <line
              key={k}
              x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
              className={"ce-roll-link" + (l.held ? " held" : "")}
            />
          ))}
        </svg>
        <div className="ce-roll-cols">
          {prog.map((c, i) => {
            const midi = voicings[i];
            const prevSet = i > 0 ? new Set(voicings[i - 1]) : null;
            const rootName = nameOf(c.rootPc, keyRoot);
            const bass = bassNameOf(midi, keyRoot);
            const inverted = bass !== rootName;
            const notes = chordNoteNames(c, keyRoot);
            // semitone travel from the previous chord (the connectors' total length)
            const dist = i > 0 ? voicingDistance(voicings[i - 1], midi) : null;
            return (
              <div
                key={c.id}
                className={"ce-roll-col" + (i === playingIdx ? " playing" : "")}
                style={{ "--c": HUE[hueOf(c.func)], width: COL }}
              >
                <span className="ce-roll-notes" style={{ height: bandH }}>
                  {midi.map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={"ce-roll-note" + (prevSet && prevSet.has(m) ? " held" : "")}
                      style={{ top: topOf(m) }}
                      onClick={() => onPlayNote(m)}
                      title={`Play ${Tone.Frequency(m, "midi").toNote()}`}
                    >
                      {nameOf(mod12(m), keyRoot)}
                    </button>
                  ))}
                </span>
                <div className="ce-roll-tilewrap">
                  <button
                    type="button"
                    className="ce-roll-tile"
                    onClick={() => onPlay(i)}
                    title={`${c.name}${inverted ? "/" + bass : ""} · ${notes.join(" ")} · ${c.move}`}
                  >
                    <span className="ce-chip-name">
                      {c.name}
                      {inverted && <span className="ce-chip-slash">/{bass}</span>}
                    </span>
                    <span className="ce-chip-roman">{c.roman}</span>
                    {dist != null && (
                      <span
                        className={"ce-chip-dist" + (dist <= 2 ? " smooth" : dist >= 7 ? " far" : "")}
                        title={`${dist} semitone${dist === 1 ? "" : "s"} of voice movement from the previous chord`}
                      >
                        Δ{dist}
                      </span>
                    )}
                  </button>
                  <span className="ce-roll-invert">
                    <button
                      type="button"
                      className="ce-inv-btn"
                      onClick={() => onInvert(i, +1)}
                      aria-label="Raise the lowest note an octave"
                      title="Raise the lowest note an octave"
                    >
                      <Chevron up />
                    </button>
                    <button
                      type="button"
                      className="ce-inv-btn"
                      onClick={() => onInvert(i, -1)}
                      aria-label="Lower the highest note an octave"
                      title="Lower the highest note an octave"
                    >
                      <Chevron />
                    </button>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function TensionCurve({ prog, playingIdx }) {
  const W = 100, H = 34, pad = 4;
  const max = 4.5;
  const n = prog.length;
  const x = (i) => (n === 1 ? W / 2 : pad + (i * (W - pad * 2)) / (n - 1));
  const y = (t) => H - pad - (Math.min(t, max) / max) * (H - pad * 2);
  const pts = prog.map((c, i) => `${x(i)},${y(c.tension)}`).join(" ");
  return (
    <svg className="ce-curve" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" y1={H - pad} x2={W} y2={H - pad} className="ce-curve-base" />
      {n > 1 && <polyline points={pts} className="ce-curve-line" />}
      {prog.map((c, i) => (
        <circle
          key={c.id}
          cx={x(i)}
          cy={y(c.tension)}
          r={i === playingIdx ? 2.4 : 1.6}
          style={{ fill: HUE[hueOf(c.func)] }}
        />
      ))}
    </svg>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap');

.ce-root{
  --bg:#E7E1D4; --panel:#F3EEE4; --ink:#221E18; --muted:#6E665A;
  --line:rgba(34,30,24,.12); --line2:rgba(34,30,24,.07);
  --home:#3D9A80; --build:#D69A38; --tension:#D6553F; --outside:#7C6BC4;
  --disp:'Space Grotesk',system-ui,sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,Menlo,monospace;
  background:var(--bg); color:var(--ink); font-family:var(--disp);
  padding:20px; border-radius:16px; max-width:1000px; margin:0 auto;
  -webkit-font-smoothing:antialiased;
}
.ce-root *{box-sizing:border-box;}
.ce-root h1{font-size:22px; font-weight:700; letter-spacing:-.02em; margin:0;}
.ce-sub{margin:2px 0 0; font-size:12.5px; color:var(--muted); max-width:46ch; line-height:1.4;}
.ce-sub em{font-style:italic; color:var(--ink);}

.ce-head{display:flex; flex-wrap:wrap; gap:16px; justify-content:space-between; align-items:flex-start;}
.ce-brand{display:flex; gap:12px; align-items:flex-start;}
.ce-mark{font-size:26px; line-height:1; color:var(--tension); transform:translateY(2px);}

.ce-controls{display:flex; flex-wrap:wrap; gap:10px; align-items:flex-end;}
.ce-field{display:flex; flex-direction:column; gap:4px;}
.ce-field>span{font-family:var(--mono); font-size:10px; text-transform:uppercase; letter-spacing:.09em; color:var(--muted);}
.ce-field select{
  font-family:var(--mono); font-size:14px; padding:7px 10px; border-radius:9px;
  border:1px solid var(--line); background:var(--panel); color:var(--ink); cursor:pointer;
}
.ce-tempo input{width:118px; accent-color:var(--ink); cursor:pointer;}

.ce-seg{display:inline-flex; background:var(--panel); border:1px solid var(--line); border-radius:9px; overflow:hidden;}
.ce-seg button{
  font-family:var(--mono); font-size:12px; text-transform:capitalize;
  padding:8px 12px; border:0; background:transparent; color:var(--muted); cursor:pointer;
}
.ce-seg button.on{background:var(--ink); color:var(--panel);}
.ce-toggle{
  font-family:var(--mono); font-size:12px; padding:8px 13px; border-radius:9px;
  border:1px solid var(--line); background:var(--panel); color:var(--muted); cursor:pointer; align-self:flex-end;
}
.ce-toggle.on{background:var(--ink); color:var(--panel); border-color:var(--ink);}

.ce-eyebrow{font-family:var(--mono); font-size:10px; text-transform:uppercase; letter-spacing:.12em; color:var(--muted);}

.ce-track{margin-top:20px; background:var(--panel); border:1px solid var(--line); border-radius:13px; padding:14px 16px;}
.ce-track-head{display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;}
.ce-total-motion{font-family:var(--mono); font-size:10px; color:var(--muted); letter-spacing:0; text-transform:none; font-weight:600;}
.ce-transport{display:flex; gap:6px;}
.ce-transport button{
  font-family:var(--mono); font-size:12px; padding:6px 11px; border-radius:8px;
  border:1px solid var(--line); background:var(--bg); color:var(--ink); cursor:pointer;
}
.ce-transport button:disabled{opacity:.4; cursor:default;}
.ce-transport button:first-child{background:var(--ink); color:var(--panel); border-color:var(--ink);}
.ce-transport button:first-child:disabled{background:var(--bg); color:var(--ink);}
.ce-share.copied:not(:disabled){background:var(--ink); color:var(--panel); border-color:var(--ink);}

.ce-empty{font-size:13px; color:var(--muted); line-height:1.5; margin:4px 0; max-width:60ch;}

.ce-curve{width:100%; height:46px; display:block; margin:2px 0 12px;}
.ce-curve-base{stroke:var(--line); stroke-width:.5; stroke-dasharray:1.5 1.5;}
.ce-curve-line{fill:none; stroke:var(--ink); stroke-width:1; opacity:.55; vector-effect:non-scaling-stroke;}

/* piano-roll progression */
.ce-roll{overflow-x:auto; padding:2px 0 4px;}
.ce-roll-inner{position:relative;}
.ce-roll-links{position:absolute; top:0; left:0; z-index:0; overflow:visible; pointer-events:none;}
.ce-roll-link{stroke:var(--ink); stroke-width:1; opacity:.13;}
.ce-roll-link.held{opacity:.24;}
.ce-roll-cols{position:relative; z-index:1; display:flex; gap:10px; align-items:flex-start;}
.ce-roll-col{--c:var(--home); flex:0 0 auto; display:flex; flex-direction:column; gap:9px;}
.ce-roll-notes{position:relative; display:block; width:100%;}
.ce-roll-note{
  position:absolute; left:0; right:0; height:18px; padding:0;
  display:flex; align-items:center; justify-content:center; cursor:pointer;
  font-family:var(--mono); font-size:11px; font-weight:500; color:var(--ink); letter-spacing:.02em;
  background:color-mix(in srgb, var(--c) 14%, var(--panel));
  border:1px solid color-mix(in srgb, var(--c) 45%, transparent); border-radius:5px;
  transition:background .1s ease, transform .1s ease;
}
.ce-roll-note.held{
  background:color-mix(in srgb, var(--c) 30%, var(--panel));
  border-color:var(--c);
}
.ce-roll-note:hover{background:color-mix(in srgb, var(--c) 42%, var(--panel)); border-color:var(--c);}
.ce-roll-note:active{transform:scale(.94);}
.ce-roll-note:focus-visible{outline:2px solid var(--ink); outline-offset:1px;}
.ce-roll-col.playing .ce-roll-note{background:color-mix(in srgb, var(--c) 40%, var(--panel)); border-color:var(--c);}

.ce-roll-tile{
  position:relative; display:flex; flex-direction:column; align-items:flex-start; text-align:left; gap:3px;
  padding:6px 8px 7px 12px; border-radius:9px; border:1px solid var(--line);
  background:var(--bg); overflow:hidden; cursor:pointer; transition:background .11s ease;
}
.ce-roll-tile::before{content:""; position:absolute; left:0; top:0; bottom:0; width:4px; background:var(--c);}
.ce-roll-tile:hover{background:var(--panel);}
.ce-roll-tile:focus-visible{outline:2px solid var(--ink); outline-offset:2px;}
.ce-roll-col.playing .ce-roll-tile{background:var(--panel); box-shadow:0 0 0 2px var(--c) inset;}
.ce-chip-name{font-size:15px; font-weight:600; letter-spacing:-.01em;}
.ce-chip-slash{font-weight:500; color:var(--muted);}
.ce-chip-roman{font-family:var(--mono); font-size:10px; color:var(--muted);}
.ce-chip-dist{
  align-self:flex-start; margin-top:1px; font-family:var(--mono); font-size:9.5px; font-weight:600; line-height:1;
  padding:2px 4px; border-radius:5px; color:var(--muted);
  background:color-mix(in srgb, var(--muted) 12%, transparent);
}
.ce-chip-dist.smooth{
  color:#2f7d5b; background:color-mix(in srgb, #2f7d5b 15%, transparent);
}
.ce-chip-dist.far{
  color:#b0642a; background:color-mix(in srgb, #b0642a 15%, transparent);
}

.ce-roll-tilewrap{display:flex; align-items:stretch; gap:4px;}
.ce-roll-tilewrap .ce-roll-tile{flex:1 1 auto; min-width:0;}
.ce-roll-invert{display:flex; flex-direction:column; gap:3px; flex:0 0 auto;}
.ce-inv-btn{
  display:flex; align-items:center; justify-content:center; flex:1 1 0; width:19px; padding:0;
  border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--muted);
  cursor:pointer; transition:background .1s ease, color .1s ease, border-color .1s ease;
}
.ce-inv-btn:hover{background:var(--panel); color:var(--ink); border-color:var(--c);}
.ce-inv-btn:active{transform:scale(.9);}
.ce-inv-btn:focus-visible{outline:2px solid var(--ink); outline-offset:1px;}

.ce-now{display:flex; align-items:center; gap:16px; margin:22px 2px 8px;}
.ce-now-badge{
  --c:var(--home); display:inline-flex; align-items:baseline; gap:12px;
  padding:12px 18px; border-radius:12px; background:var(--panel);
  border:1px solid var(--line); box-shadow:inset 4px 0 0 var(--c);
}
.ce-now-roman{font-family:var(--mono); font-size:14px; color:var(--c); font-weight:500;}
.ce-now-name{font-size:34px; font-weight:700; letter-spacing:-.03em; line-height:1;}
.ce-now-notes{font-family:var(--mono); font-size:11px; letter-spacing:.08em; color:var(--muted);}
.ce-now-func{font-family:var(--mono); font-size:10px; text-transform:uppercase; letter-spacing:.1em; color:var(--muted);}
.ce-now-cue{font-family:var(--mono); font-size:11px; color:var(--muted); letter-spacing:.04em;}

.ce-options{margin-top:8px;}
.ce-group-head{display:flex; align-items:baseline; gap:10px; margin:16px 2px 10px;}
.ce-colour-head{margin-top:26px;}
.ce-hint{font-size:11px; color:var(--muted); font-style:italic;}

.ce-grid{display:grid; grid-template-columns:repeat(auto-fill,minmax(158px,1fr)); gap:9px;}
.ce-card{
  --c:var(--home); text-align:left; display:flex; flex-direction:column; gap:5px;
  padding:12px 13px 13px; border-radius:11px; background:var(--panel);
  border:1px solid var(--line); border-left:3px solid var(--c); cursor:pointer;
  transition:transform .11s ease, box-shadow .11s ease, background .11s ease;
}
.ce-card:hover{transform:translateY(-2px); box-shadow:0 6px 16px -10px rgba(34,30,24,.5); background:#fff;}
.ce-card:active{transform:translateY(0);}
.ce-card:focus-visible{outline:2px solid var(--ink); outline-offset:2px;}
.ce-card.resolve{background:#fff; border-color:var(--c); box-shadow:0 0 0 1px var(--c) inset;}
.ce-card-top{display:flex; align-items:baseline; justify-content:space-between; gap:8px;}
.ce-card-tr{display:flex; flex-direction:column; align-items:flex-end; gap:3px; flex:0 0 auto;}
.ce-card-name{font-size:20px; font-weight:700; letter-spacing:-.02em; border-radius:5px; padding:0 4px; margin:0 -4px; cursor:pointer; transition:background .12s, color .12s;}
.ce-card-name:hover{background:color-mix(in srgb, var(--c) 16%, transparent); color:var(--c);}
.ce-card-roman{font-family:var(--mono); font-size:11px; color:var(--c); font-weight:500;}
.ce-card-notes{font-family:var(--mono); font-size:10.5px; letter-spacing:.06em; color:var(--muted);}
.ce-card-motion{font-family:var(--mono); font-size:10px; color:var(--muted); letter-spacing:.02em;}
.ce-card-move{font-size:12px; line-height:1.4; color:var(--ink);}

.ce-legend{display:flex; flex-wrap:wrap; align-items:center; gap:16px; margin-top:24px; padding-top:14px; border-top:1px solid var(--line);}
.ce-leg{display:inline-flex; align-items:center; gap:6px; font-family:var(--mono); font-size:11px; color:var(--muted);}
.ce-leg i{width:11px; height:11px; border-radius:3px; display:inline-block;}
.ce-leg-note{font-size:11px; color:var(--muted); font-style:italic; margin-left:auto;}

@media (max-width:560px){
  .ce-controls{width:100%;}
  .ce-now-name{font-size:28px;}
  .ce-grid{grid-template-columns:repeat(auto-fill,minmax(140px,1fr));}
}
@media (prefers-reduced-motion:reduce){
  .ce-card{transition:none;}
  .ce-card:hover{transform:none;}
}
`;
