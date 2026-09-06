/* ------------------------------------------------------------------ *
 *  HARMONY ENGINE — the pure core of Chord Paths.
 *  Data in, data out: no React, no DOM, no audio. Pitch classes are
 *  integers 0–11 and registers are midi integers; note strings are for
 *  display and for handing to Tone, never for logic.
 * ------------------------------------------------------------------ */

// --- pitch-class naming -------------------------------------------------
export const SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT = ["C", "D♭", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "B"];
const FLAT_KEYS = new Set([1, 3, 5, 6, 8, 10]); // roots that read nicer in flats
export const nameOf = (pc, root) => (FLAT_KEYS.has(root) ? FLAT : SHARP)[((pc % 12) + 12) % 12];

// --- scales -------------------------------------------------------------
export const STEPS = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10], // natural minor; harmonic-minor dominant added as colour
  mixolydian: [0, 2, 4, 5, 7, 9, 10], // major with a ♭7 — that flat-seventh colour
};
export const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII"];
// scale degrees written with a ♭ prefix on their roman (flattened vs the major scale)
const FLAT_DEG = { mixolydian: new Set([6]) }; // ♭VII
export const romanFor = (mode, d, q) =>
  (FLAT_DEG[mode]?.has(d) ? "♭" : "") +
  (q.upper ? ROMAN[d] : ROMAN[d].toLowerCase()) +
  q.romanSuffix;

// harmonic function + a rough "distance from home" tension value, per degree
export const FUNC = {
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
export function classify(intervals) {
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
export function hueOf(func) {
  if (func === "tonic") return "home";
  if (func === "predominant" || func === "subtonic") return "build";
  if (func === "dominant") return "tension";
  return "outside"; // secondary / borrowed
}

export const mod12 = (n) => ((n % 12) + 12) % 12;

// the distinct pitch classes of a chord, in chord-tone order (root, 3rd, 5th, 7th…)
export function chordPitchClasses(chord) {
  const seen = new Set();
  const out = [];
  chord.intervals.forEach((i) => {
    const pc = mod12(chord.rootPc + i);
    if (!seen.has(pc)) { seen.add(pc); out.push(pc); }
  });
  return out;
}

// the note names of a chord's tones, spelled to suit the key
export function chordNoteNames(chord, keyRoot) {
  return chordPitchClasses(chord).map((pc) => nameOf(pc, keyRoot));
}

// midi note of pitch-class `pc` placed in the octave closest to `target`
export const nearestMidi = (pc, target) => pc + 12 * Math.round((target - pc) / 12);

// plain root position — the chord's own tones, stacked from C4
export function rootPositionMidi(chord) {
  const rootMidi = 60 + mod12(chord.rootPc); // C4..B4
  return chord.intervals.map((i) => rootMidi + i);
}

// voice-led realisation: place each new tone in the octave nearest to the
// previous chord's notes, so common tones hold and the rest step. Inversions
// fall out of this — no explicit inversion bookkeeping needed.
export function voiceLeadMidi(prevMidi, chord) {
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
export function applyInversion(notes, inv) {
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
export function computeVoicings(prog, voiceLead) {
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

// midi integer -> the note string Tone wants ("C4", "C#4"). Sharp spelling and
// C4 = 60, matching Tone.Frequency(m, "midi").toNote() — done here in plain
// arithmetic so the engine stays free of audio imports.
export const midiToNotes = (midi) =>
  midi.map((m) => SHARP[mod12(m)] + (Math.floor(m / 12) - 1));

// "edit distance" between two realised chords: the combined keyboard travel of
// their voices, paired by ascending pitch (the same pairing the roll's connectors
// draw). A triad up two semitones = 3×2 = 6; major → sus4 = 1 (just the 3rd steps).
// Lower means smoother — the metric for minimal-motion progressions.
export function voicingDistance(a, b) {
  if (!a || !b) return 0;
  const x = [...a].sort((p, q) => p - q);
  const y = [...b].sort((p, q) => p - q);
  let d = 0;
  for (let v = 0; v < Math.min(x.length, y.length); v++) d += Math.abs(x[v] - y[v]);
  return d;
}

// per-voice semitone step from one realised chord to the next, paired by ascending
// pitch (the same pairing the roll's connectors draw). Keyed by the destination midi
// note, so the roll can label each pill with the interval that lands on it: G→A is +2.
// A voice with no counterpart (a triad growing into a seventh) simply gets no entry.
export function voiceSteps(prev, next) {
  const out = new Map();
  if (!prev || !prev.length || !next || !next.length) return out;
  const a = [...prev].sort((p, q) => p - q);
  const b = [...next].sort((p, q) => p - q);
  for (let v = 0; v < Math.min(a.length, b.length); v++) out.set(b[v], b[v] - a[v]);
  return out;
}

// distance from a realised chord to a candidate option, voiced the way `choose`
// would voice it — so a chooser card previews the motion picking it would cost
export function optionDistance(prevMidi, opt, voiceLead) {
  if (!prevMidi) return null;
  const optMidi = voiceLead ? voiceLeadMidi(prevMidi, opt) : rootPositionMidi(opt);
  return voicingDistance(prevMidi, optMidi);
}

// the lowest sounding note's name — for slash-chord display of inversions
export const bassNameOf = (midi, keyRoot) =>
  midi && midi.length ? nameOf(mod12(Math.min(...midi)), keyRoot) : null;

// --- build the diatonic set + colour chords for a key -------------------
export function buildKey(root, mode) {
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
//
// Sources are the chords you can *sit* on: the diatonic triads plus the borrowed
// ones (♭VII, ♭VI, minor iv, Dorian IV), so a borrowed chord gets its suspension
// too. Secondary dominants are deliberately skipped — pull the 3rd out and the
// tritone that makes a chord a secondary dominant goes with it.
export function suspensionsFor(key) {
  const out = [];
  const seen = new Set();
  const sources = [...key.diatonic, ...key.colour.filter((c) => c.func === "borrowed")];
  sources.forEach((c) => {
    if (c.quality.triad !== "maj" && c.quality.triad !== "min") return; // skip °/+
    const triadName = nameOf(c.rootPc, key.root); // the resolution target's name
    [
      ["sus2", [0, 2, 7], `Suspended 2nd — open and unresolved; settles onto ${triadName}.`],
      ["sus4", [0, 5, 7], `Suspended 4th — the 4th leans on the 3rd; resolves down to ${triadName}.`],
    ].forEach(([kind, ints, desc]) => {
      // a major and minor triad on the same root suspend identically (the 3rd is
      // what differed) — keep the first, which is the diatonic reading
      const id = `${c.rootPc}:${kind}`;
      if (seen.has(id)) return;
      seen.add(id);
      const q = classify(ints); // romanSuffix is the sus kind, so romanFor spells it whole
      out.push({
        rootPc: c.rootPc,
        intervals: ints,
        quality: q,
        name: nameOf(c.rootPc, key.root) + q.suffix,
        // a diatonic degree gets the mode's own spelling (Mixolydian's ♭VIIsus4);
        // a colour chord already carries a spelled roman — sus is quality-neutral,
        // so `iv` reads as `IVsus4`
        roman: c.degree
          ? romanFor(key.mode, c.degree - 1, q)
          : c.roman.replace(/[a-z]+/g, (m) => m.toUpperCase()) + kind,
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

// buildKey, restacked with sevenths when add7 is on — pure, so URL decode can
// rebuild the exact chord pool a saved progression was chosen from.
export function resolveKey(root, mode, add7) {
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

// --- root-motion label --------------------------------------------------
const MOTION = {
  0: "same root", 1: "up a semitone", 2: "up a whole step", 3: "up a minor third",
  4: "up a major third", 5: "up a fourth", 6: "a tritone", 7: "up a fifth",
  8: "down a major third", 9: "down a minor third", 10: "down a whole step",
  11: "down a semitone",
};
export const motionLabel = (from, to) => MOTION[(((to - from) % 12) + 12) % 12];

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
    5: "Weak dominant (v). For a real pull, reach for the major V.",
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

export function moveDescription(mode, fromDeg, to) {
  if (to.group === "colour") return to.colourDesc;
  const roleTxt = ROLE[mode][to.degree];
  if (fromDeg == null) return roleTxt;
  const s = SPECIAL[mode][`${fromDeg}>${to.degree}`];
  return s || roleTxt;
}

// ordering: how idiomatic is from-function -> to-function
export function score(fromFunc, to) {
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
export function salience(mode, chord) {
  if (chord.group === "colour")
    return chord.func === "dominant" ? 0.9 : chord.func === "secondary" ? 0.5 : 0.4;
  return (mode === "minor" ? SAL_MINOR : SAL_MAJOR)[chord.degree] || 0.5;
}

// does moving `prev` → `next` discharge what `prev` was leaning on? A chord that
// wants somewhere (a secondary dominant, a suspension) names it in `resolvesTo`.
//
// The second clause rules out a suspension landing on a suspension: a sus resolves
// to its *own* root, so root-matching alone would call Fsus4 → Fsus2 a resolution,
// and Fsus4 → Fsus4 one too. Only the plain triad underneath actually releases it.
// Shared so the URL decoder flags a reconstituted chord exactly like a chosen one.
export const isResolution = (prev, next) =>
  !!prev &&
  prev.resolvesTo != null &&
  prev.resolvesTo === next.rootPc &&
  next.resolvesTo !== next.rootPc;

// build the option list from the current chord
// the one place this sentence lives — optionsFrom and decorateChain both need it
export const resolutionMove = (name) =>
  `Resolution — lands home on ${name}, releasing the previous chord’s tension.`;

// decorate a bare chord sequence into progression items: each chord's motion and
// description read relative to the one before it. Shared by the URL decoder and
// the loop suggester, so a reconstituted, suggested and hand-picked chord all
// carry identical fields.
export function decorateChain(chords, mode) {
  const out = [];
  for (const c of chords) {
    const prev = out.length ? out[out.length - 1] : null;
    const resolution = isResolution(prev, c);
    out.push({
      ...c,
      motion: prev ? motionLabel(prev.rootPc, c.rootPc) : null,
      resolution,
      move: resolution
        ? resolutionMove(c.name)
        : moveDescription(mode, prev ? prev.degree : null, c),
    });
  }
  return out;
}

export function optionsFrom(current, key) {
  const fromFunc = current ? current.func : null;
  const fromDeg = current ? current.degree : null;

  const decorate = (c) => ({
    ...c,
    move: moveDescription(key.mode, fromDeg, c),
    motion: current ? motionLabel(current.rootPc, c.rootPc) : null,
    resolution: isResolution(current, c),
  });

  const rank = (c) =>
    score(fromFunc, c) * 10 + salience(key.mode, c) + (c.resolution ? 100 : 0);

  let inKey = key.diatonic.map(decorate);
  if (current) {
    inKey = inKey.map((c) =>
      c.resolution
        ? { ...c, move: resolutionMove(c.name) }
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


// --- suggest a loop -----------------------------------------------------
// A weighted walk over the transition graph, using the same score()/salience()
// tables that rank the chooser — so a suggestion is idiomatic for the same
// reasons the top of the futures list is.
//
// `rand` is injected rather than reaching for Math.random, which keeps the
// engine a pure function of its inputs and lets tests pin a seed.
function pickWeighted(items, weights, rand) {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return items[Math.floor(rand() * items.length)];
  let r = rand() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

export function suggestLoop(key, { bars = 4, rand = Math.random } = {}) {
  const n = Math.max(2, Math.round(bars));
  // suspensions are a colour you add to a chord, not a skeleton to build on
  const pool = [...key.diatonic, ...key.colour];
  const tonic = key.diatonic[0];
  const chords = [tonic];

  for (let i = 1; i < n; i++) {
    const prev = chords[chords.length - 1];
    const last = i === n - 1;
    // No immediate repeats — and the last bar is adjacent to the first, since the
    // whole point is that it comes round again. Interior bars also can't return
    // to the root two back: A–B–A oscillation is what a weighted walk falls into
    // otherwise, and "C A7 C G" is a worse loop than anything it rules out. The
    // last bar is exempt, so a dominant heard earlier can still bring it home.
    const before = i >= 2 ? chords[i - 2].rootPc : null;
    const excluded = (c) =>
      c.rootPc === prev.rootPc ||
      (last && c.rootPc === tonic.rootPc) ||
      (!last && c.rootPc === before);
    let cands = pool.filter((c) => !excluded(c));
    if (!cands.length) cands = pool.filter((c) => c.rootPc !== prev.rootPc);
    const seen = new Set(chords.map((c) => c.rootPc));
    const weights = cands.map((c) => {
      let w = score(prev.func, c) * salience(key.mode, c);
      // a loop wants somewhere to go. Without these two the walk oscillates —
      // the tonic's salience is high enough to pull it back every other bar,
      // which is how you get I V7/ii I V instead of a progression.
      if (seen.has(c.rootPc)) w *= 0.3;
      if (last) {
        // the last bar has to hand back to the top of the loop
        if (c.func === "dominant") w *= 3;
        else if (c.func === "predominant" || c.func === "subtonic") w *= 1.6;
        else w *= 0.5;
        if (c.resolvesTo === tonic.rootPc) w *= 2;
      } else if (c.rootPc === tonic.rootPc) {
        w *= 0.2; // home mid-loop kills the movement; it already ends there
      }
      return w;
    });
    chords.push(pickWeighted(cands, weights, rand));
  }
  return decorateChain(chords, key.mode);
}
