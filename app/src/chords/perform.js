/* ------------------------------------------------------------------ *
 *  PERFORM — how a chord is played
 *
 *  Pure, import-free, like harmony.js. Harmony decides which notes; this
 *  decides how they're struck: block chord or arpeggio, in what order,
 *  how loud each voice is and how loosely it lands. The result is a list
 *  of note events that any instrument can play — the built-in synth and a
 *  MIDI port take exactly the same list, which is why Dynamics and Humanise
 *  live here and not on the synth: they're the player's, not the sound's.
 * ------------------------------------------------------------------ */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ------------------------------------------------------------------------
//  FEEL
// ------------------------------------------------------------------------
// The two levels in the Playback module. Same shape as the synth's table —
// a label, a default and a tooltip that is the only place each explains
// itself — but they belong to the player.
export const FEEL = {
  dynamics: {
    label: "Dynamics", default: 0.5,
    hint: "Spread the voices apart in volume — bass firm, melody singing, inner voices sitting back. At zero every note is equally loud, which is the organ sound.",
  },
  humanise: {
    label: "Humanise", default: 0.35,
    hint: "Scatter each note's volume and timing by a few percent, so a block chord sounds struck rather than triggered.",
  },
};
export const defaultFeel = () => ({ dynamics: FEEL.dynamics.default, humanise: FEEL.humanise.default });

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

export function velocityCurve(midi, feel = {}, rand = Math.random) {
  const dynamics = clamp(Number(feel.dynamics) || 0, 0, 1);
  const humanise = clamp(Number(feel.humanise) || 0, 0, 1);
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
    dur = 1.1, span = dur, feel = {},
  } = opts;
  const all = (bass == null ? [...upper] : [bass, ...upper]).sort((a, b) => a - b);
  // shaped over the whole chord, so the bass keeps the bass's weight either way
  const shaped = velocityCurve(all, feel, rand);
  const shape = (m) => shaped[all.indexOf(m)];
  const note = (m, at, d) => ({ midi: m, at: at + shape(m).delay, dur: d, velocity: shape(m).velocity });

  if (!arp || all.length < 2) return all.map((m) => note(m, 0, dur));

  const held = holdBass && bass != null;
  const pool = held ? [...upper].sort((a, b) => a - b) : all;
  const seq = arpSequence(pool, { four, order }, rand);
  const step = span / seq.length;
  const events = seq.map((m, k) => note(m, k * step, step * 0.9));
  return held ? [note(bass, 0, dur), ...events] : events;
}
