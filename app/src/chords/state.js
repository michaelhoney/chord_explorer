import { resolveKey, suspensionsFor, suggestLoop, decorateChain } from "./harmony.js";
import { FEEL, defaultFeel } from "./perform.js";

// ------------------------------------------------------------------------
//  THE EXPLORER'S STATE, AS A LINK
// ------------------------------------------------------------------------
// The explorer's slice of the query string (the synth writes its own `sy=`
// beside it; see useUrlSlice). A chord is identified by root + intervals; the
// reader rebuilds the key's chord pool and looks each one up, so links carry
// no derived data (voicings stay derived).

// Evolve's pace: land a mutation after this many times round
export const EVOLVE_EVERY = [1, 2, 4, 8];
export const DEFAULT_TEMPO = 96;

const chordToken = (c) => {
  const base = `${c.rootPc}.${c.intervals.join("-")}`;
  return c.inv ? `${base}~${c.inv}` : base; // trailing ~N carries the inversion shift
};

// a feel level, at the precision a level can be set to by hand
const r2 = (v) => Math.round(v * 100) / 100;

export function encodeState(s) {
  const p = new URLSearchParams();
  p.set("k", s.root);
  if (s.mode === "minor") p.set("m", "min");
  else if (s.mode === "mixolydian") p.set("m", "mixo");
  if (s.add7) p.set("s7", "1");
  if (!s.voiceLead) p.set("vl", "0"); // on by default; only record when turned off
  if (s.bass) p.set("bs", "1");
  if (s.arp) p.set("arp", "1");
  if (s.arpFour) p.set("a4", "1");
  if (s.arpOrder === "random") p.set("ao", "rnd");
  if (s.holdBass) p.set("bh", "1");
  if (!s.loop) p.set("lp", "0"); // on by default; only record when turned off
  if (s.evolve) p.set("ev", "1");
  if (s.evolveEvery !== 1) p.set("ee", s.evolveEvery);
  if (s.mutLevel !== 1) p.set("ml", s.mutLevel); // shapes what Evolve does, so it travels
  if (s.susOn) p.set("su", "1");
  if (s.tempo !== DEFAULT_TEMPO) p.set("t", s.tempo);
  // how the chords are played travels with them — it's part of the performance
  if (r2(s.feel.dynamics) !== FEEL.dynamics.default) p.set("dy", r2(s.feel.dynamics));
  if (r2(s.feel.humanise) !== FEEL.humanise.default) p.set("hu", r2(s.feel.humanise));
  if (s.prog.length) p.set("p", s.prog.map(chordToken).join("_"));
  return p.toString();
}

// A naked URL — no query string at all — opens somewhere rather than on an empty
// page: a random key, major or minor, with a 4-bar suggestion on the roll, ready
// for Play. Waiting rather than playing, since audio can't start before a press.
// A link with any state in it opens exactly as written (see decodeState).
export function randomStart() {
  const root = Math.floor(Math.random() * 12);
  const mode = Math.random() < 0.5 ? "major" : "minor";
  const prog = suggestLoop(resolveKey(root, mode, false), { bars: 4 }).map((c, i) => ({ ...c, id: i + 1 }));
  return { root, mode, prog };
}

// `legacyFeel` is what an older link carried for Dynamics and Humanise inside
// the synth's patch, from before they moved here; a link's own `dy`/`hu` win.
export function decodeState(search, legacyFeel = {}) {
  const p = new URLSearchParams(search);
  if (![...p.keys()].length) return null;
  const clampNum = (v, def, lo, hi) => {
    if (v == null || v === "") return def; // absent param → default (Number(null) is 0!)
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : def;
  };
  const level = (v, def) => {
    const n = v == null || v === "" ? NaN : Number(v);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : def;
  };
  const root = clampNum(p.get("k"), 0, 0, 11);
  const mode = p.get("m") === "min" ? "minor" : p.get("m") === "mixo" ? "mixolydian" : "major";
  const add7 = p.get("s7") === "1";
  const voiceLead = p.get("vl") !== "0"; // default on; also honours legacy vl=1
  const bass = p.get("bs") === "1";
  const arp = p.get("arp") === "1";
  const arpFour = p.get("a4") === "1";
  const arpOrder = p.get("ao") === "rnd" ? "random" : "rise";
  const holdBass = p.get("bh") === "1";
  const loop = p.get("lp") !== "0";
  const evolve = loop && p.get("ev") === "1";
  const evolveEvery = EVOLVE_EVERY.includes(Number(p.get("ee"))) ? Number(p.get("ee")) : 1;
  const mutLevel = clampNum(p.get("ml"), 1, 1, 3);
  const susOn = p.get("su") === "1";
  const tempo = clampNum(p.get("t"), DEFAULT_TEMPO, 30, 150);
  const base = { ...defaultFeel(), ...legacyFeel };
  const feel = { dynamics: level(p.get("dy"), base.dynamics), humanise: level(p.get("hu"), base.humanise) };
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
      prog.push({ ...match, inv });
    }
  }
  // decorated through the engine, so a reconstituted chord carries exactly the
  // fields a chosen or suggested one does
  const chain = decorateChain(prog, mode).map((c, i) => ({ ...c, id: i + 1 }));
  return {
    root, mode, add7, voiceLead, bass, arp, arpFour, arpOrder, holdBass,
    loop, evolve, evolveEvery, mutLevel, susOn, tempo, feel, prog: chain,
  };
}
