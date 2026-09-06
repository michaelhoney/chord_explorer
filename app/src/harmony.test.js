import { describe, it, expect } from "vitest";
import {
  classify,
  buildKey,
  resolveKey,
  suspensionsFor,
  suggestLoop,
  decorateChain,
  optionsFrom,
  rootPositionMidi,
  voiceLeadMidi,
  applyInversion,
  computeVoicings,
  voicingDistance,
  voiceSteps,
  optionDistance,
  midiToNotes,
  bassNameOf,
  chordNoteNames,
  motionLabel,
  nameOf,
  hueOf,
} from "./harmony.js";

const C = 0;
const names = (chords) => chords.map((c) => c.name);
const romans = (chords) => chords.map((c) => c.roman);

describe("buildKey — diatonic sets", () => {
  it("spells C major as triads with the standard romans", () => {
    const key = buildKey(C, "major");
    expect(names(key.diatonic)).toEqual(["C", "Dm", "Em", "F", "G", "Am", "B°"]);
    expect(romans(key.diatonic)).toEqual(["I", "ii", "iii", "IV", "V", "vi", "vii°"]);
  });

  it("spells A minor from the natural minor scale", () => {
    const key = buildKey(9, "minor");
    expect(names(key.diatonic)).toEqual(["Am", "B°", "C", "Dm", "Em", "F", "G"]);
    expect(romans(key.diatonic)).toEqual(["i", "ii°", "III", "iv", "v", "VI", "VII"]);
  });

  it("gives Mixolydian its ♭VII and marks the roman as flattened", () => {
    const key = buildKey(C, "mixolydian");
    // NB: spelling follows the key root, so in C (a sharp key) the ♭VII prints
    // as A# even though its roman says ♭VII. Cosmetic only — pitch classes are
    // what the audio and the ranking use.
    expect(names(key.diatonic)).toEqual(["C", "Dm", "E°", "F", "Gm", "Am", "A#"]);
    expect(key.diatonic[6].rootPc).toBe(10);
    expect(key.diatonic[6].roman).toBe("♭VII");
  });

  it("uses flat spelling for keys that read nicer in flats", () => {
    expect(names(buildKey(10, "major").diatonic)).toEqual(
      ["B♭", "Cm", "Dm", "E♭", "F", "Gm", "A°"]
    );
  });

  it("gives every chord a function and a numeric tension", () => {
    for (const mode of ["major", "minor", "mixolydian"]) {
      const key = buildKey(C, mode);
      for (const c of [...key.diatonic, ...key.colour, ...suspensionsFor(key)]) {
        expect(c.func, `${mode} ${c.roman}`).toBeTruthy();
        expect(hueOf(c.func)).toMatch(/home|build|tension|outside/);
        expect(typeof c.tension).toBe("number");
      }
    }
  });
});

describe("classify / resolveKey — sevenths", () => {
  it("names a stack of thirds by its quality", () => {
    expect(classify([0, 4, 7]).suffix).toBe("");
    expect(classify([0, 3, 7]).suffix).toBe("m");
    expect(classify([0, 4, 7, 10]).suffix).toBe("7");
    expect(classify([0, 4, 7, 11]).suffix).toBe("maj7");
    expect(classify([0, 3, 6]).suffix).toBe("°");
    expect(classify([0, 3, 6, 10]).romanSuffix).toBe("ø7");
    expect(classify([0, 5, 7]).suffix).toBe("sus4");
    expect(classify([0, 2, 7]).suffix).toBe("sus2");
  });

  it("makes V a dominant 7th and vii° half-diminished when add7 is on", () => {
    const key = resolveKey(C, "major", true);
    expect(key.diatonic[4].name).toBe("G7");
    expect(key.diatonic[4].roman).toBe("V7");
    expect(key.diatonic[6].name).toBe("Bm7♭5");
    expect(key.diatonic[6].roman).toBe("viiø7");
  });

  it("leaves the key untouched when add7 is off", () => {
    expect(resolveKey(C, "major", false).diatonic).toEqual(buildKey(C, "major").diatonic);
  });
});

describe("chord tones", () => {
  it("lists a chord's note names spelled to the key", () => {
    const key = buildKey(C, "major");
    expect(chordNoteNames(key.diatonic[0], C)).toEqual(["C", "E", "G"]);
    expect(chordNoteNames(key.diatonic[6], C)).toEqual(["B", "D", "F"]);
  });

  it("names a pitch class by the key's accidental preference", () => {
    expect(nameOf(6, 0)).toBe("F#");
    expect(nameOf(6, 10)).toBe("G♭");
  });
});

describe("colour chords", () => {
  it("adds secondary dominants that point at their target", () => {
    const key = buildKey(C, "major");
    const a7 = key.colour.find((c) => c.name === "A7");
    expect(a7.roman).toBe("V7/ii");
    expect(a7.resolvesTo).toBe(2); // D — the root of ii
    expect(a7.func).toBe("secondary");
  });

  it("borrows iv, ♭VII and ♭VI from the parallel minor", () => {
    const borrowed = buildKey(C, "major").colour.filter((c) => c.func === "borrowed");
    expect(romans(borrowed)).toEqual(["iv", "♭VII", "♭VI"]);
  });

  it("offers the harmonic-minor dominant in a minor key", () => {
    const v = buildKey(9, "minor").colour.find((c) => c.roman === "V");
    expect(v.name).toBe("E"); // major triad on the fifth, raised leading tone
    expect(v.resolvesTo).toBe(9);
  });

  it("builds sus2/sus4 pairs that resolve to their own triad", () => {
    const key = buildKey(C, "major");
    const sus = suspensionsFor(key);
    expect(sus.filter((s) => s.rootPc === 0).map((s) => s.name)).toEqual(["Csus2", "Csus4"]);
    // the diminished vii° has no plain triad to suspend, so it is skipped
    expect(sus.some((s) => s.rootPc === 11)).toBe(false);
    for (const s of sus) expect(s.resolvesTo).toBe(s.rootPc);
  });

  it("suspends the borrowed chords too, not just the diatonic ones", () => {
    // F is ♭VII in G — borrowed, so it only has a sus form if colour chords count
    const sus = suspensionsFor(buildKey(7, "major"));
    const f = sus.filter((s) => s.rootPc === 5);
    expect(f.map((s) => s.name)).toEqual(["Fsus2", "Fsus4"]);
    expect(f.map((s) => s.roman)).toEqual(["♭VIIsus2", "♭VIIsus4"]);
    expect(f.every((s) => s.func === "borrowed")).toBe(true); // hue stays "outside"
  });

  it("gives each root one sus pair, however many triads share it", () => {
    // C major has both a diatonic IV and a borrowed iv on F; they suspend alike
    const sus = suspensionsFor(buildKey(C, "major"));
    expect(sus.filter((s) => s.name === "Fsus4")).toHaveLength(1);
    expect(sus.find((s) => s.name === "Fsus4").roman).toBe("IVsus4"); // diatonic wins
  });

  it("spells a sus roman the way its mode spells the degree", () => {
    const sus = suspensionsFor(buildKey(C, "mixolydian"));
    expect(sus.find((s) => s.rootPc === 10).roman).toBe("♭VIIsus2");
  });

  it("treats only the plain triad as a suspension's resolution", () => {
    const key = { ...buildKey(C, "major"), suspensions: suspensionsFor(buildKey(C, "major")) };
    const fsus4 = key.suspensions.find((s) => s.name === "Fsus4");
    const { inKey, sus } = optionsFrom(fsus4, key);
    // the triad underneath releases it...
    expect(inKey.find((c) => c.name === "F").resolution).toBe(true);
    // ...but its sus siblings, which share the root, do not
    expect(sus.filter((s) => s.rootPc === 5).some((s) => s.resolution)).toBe(false);
  });

  it("leaves secondary dominants unsuspended", () => {
    // pull the 3rd out of a V7/x and the tritone that defines it goes too
    const sus = suspensionsFor(buildKey(C, "major"));
    expect(sus.some((s) => s.func === "secondary")).toBe(false);
  });
});

describe("motionLabel", () => {
  it("describes root motion by shortest direction", () => {
    expect(motionLabel(0, 5)).toBe("up a fourth");
    expect(motionLabel(0, 7)).toBe("up a fifth");
    expect(motionLabel(0, 11)).toBe("down a semitone");
    expect(motionLabel(7, 0)).toBe("up a fourth"); // G→C wraps to +5
    expect(motionLabel(0, 0)).toBe("same root");
  });
});

describe("optionsFrom — ranking", () => {
  const key = buildKey(C, "major");

  it("ranks V and IV above the tonic substitutes when leaving home", () => {
    const order = romans(optionsFrom(key.diatonic[0], key).inKey);
    expect(order.slice(0, 2)).toEqual(["V", "IV"]);
    expect(order.indexOf("V")).toBeLessThan(order.indexOf("vi"));
    expect(order.indexOf("IV")).toBeLessThan(order.indexOf("iii"));
  });

  it("lists chords in degree order with no current chord", () => {
    const opts = optionsFrom(null, key);
    expect(romans(opts.inKey)).toEqual(["I", "ii", "iii", "IV", "V", "vi", "vii°"]);
    expect(opts.inKey.every((c) => c.motion === null)).toBe(true);
  });

  it("flags a secondary dominant's target as a resolution and sorts it first", () => {
    const a7 = key.colour.find((c) => c.name === "A7");
    const opts = optionsFrom(a7, key);
    expect(opts.inKey[0].roman).toBe("ii");
    expect(opts.inKey[0].resolution).toBe(true);
    expect(opts.inKey[0].move).toMatch(/^Resolution —/);
    expect(opts.inKey.filter((c) => c.resolution)).toHaveLength(1);
  });

  it("names the cadence for a known move and falls back to the role otherwise", () => {
    const fromV = optionsFrom(key.diatonic[4], key).inKey;
    expect(fromV.find((c) => c.roman === "I").move).toMatch(/Authentic cadence/);
    expect(fromV.find((c) => c.roman === "vi").move).toMatch(/Deceptive cadence/);
    expect(fromV.find((c) => c.roman === "iii").move).toMatch(/Mediant colour/);
  });

  it("decorates every option with root motion from the current chord", () => {
    const opts = optionsFrom(key.diatonic[0], key);
    expect(opts.inKey.find((c) => c.roman === "V").motion).toBe("up a fifth");
    expect(opts.inKey.find((c) => c.roman === "IV").motion).toBe("up a fourth");
  });

  it("passes suspensions through when the key carries them", () => {
    const withSus = { ...key, suspensions: suspensionsFor(key) };
    expect(optionsFrom(key.diatonic[0], withSus).sus.length).toBe(16);
    expect(optionsFrom(key.diatonic[0], key).sus).toEqual([]);
  });
});

describe("voicing", () => {
  const key = buildKey(C, "major");
  const [I, , , IV, V, vi] = key.diatonic;

  it("stacks root position from C4", () => {
    expect(rootPositionMidi(I)).toEqual([60, 64, 67]);
    expect(rootPositionMidi(V)).toEqual([67, 71, 74]);
  });

  it("settles the first voice-led chord around A3–C4", () => {
    expect(voiceLeadMidi(null, I)).toEqual([60, 64, 67]);
    expect(voiceLeadMidi([], vi)).toEqual([57, 60, 64]);
  });

  it("holds common tones and steps the rest — C→Am keeps C and E, G moves to A", () => {
    const from = rootPositionMidi(I); // 60 64 67
    const to = voiceLeadMidi(from, vi);
    expect(to).toEqual([60, 64, 69]);
    expect(to.filter((n) => from.includes(n))).toEqual([60, 64]);
  });

  it("moves each remaining voice by the smallest available interval", () => {
    // C→F: C holds, E→F (1), G→A (2) — no voice travels more than a whole step
    const to = voiceLeadMidi(rootPositionMidi(I), IV);
    expect(to).toEqual([60, 65, 69]);
  });

  it("rolls octaves at the extremes for inversions", () => {
    expect(applyInversion([60, 64, 67], 1)).toEqual([72, 64, 67]);
    expect(applyInversion([60, 64, 67], 2)).toEqual([72, 76, 67]);
    expect(applyInversion([60, 64, 67], -1)).toEqual([60, 64, 55]);
    expect(applyInversion([60, 64, 67], 0)).toEqual([60, 64, 67]);
  });

  it("chains a progression, honouring each chord's stored inversion", () => {
    const prog = [I, vi, IV];
    expect(computeVoicings(prog, false)).toEqual([
      [60, 64, 67],
      [69, 72, 76],
      [65, 69, 72],
    ]);
    expect(computeVoicings(prog, true)).toEqual([
      [60, 64, 67],
      [60, 64, 69],
      [60, 65, 69],
    ]);
    expect(computeVoicings([{ ...I, inv: 1 }], false)).toEqual([[72, 64, 67]]);
  });

  it("is a pure function of the progression — no state stored on the chords", () => {
    const prog = [I, vi, IV];
    const snapshot = JSON.stringify(prog);
    computeVoicings(prog, true);
    computeVoicings(prog, false);
    expect(JSON.stringify(prog)).toBe(snapshot);
  });

  it("measures voice travel as combined keyboard distance", () => {
    expect(voicingDistance([60, 64, 67], [62, 66, 69])).toBe(6); // whole step, 3 voices
    expect(voicingDistance([60, 64, 67], [60, 65, 67])).toBe(1); // major → sus4
    expect(voicingDistance(null, [60])).toBe(0);
  });

  it("reports each voice's semitone step, keyed by the note it lands on", () => {
    // C(60 64 67) → Am voice-led (60 64 69): C and E hold, G steps up to A
    const steps = voiceSteps([60, 64, 67], [60, 64, 69]);
    expect(steps.get(60)).toBe(0);
    expect(steps.get(64)).toBe(0);
    expect(steps.get(69)).toBe(2);
  });

  it("pairs voices by ascending pitch regardless of stored order", () => {
    // an inverted voicing is stored out of order — the pairing still goes by pitch
    expect([...voiceSteps([60, 64, 67], [72, 64, 67]).entries()].sort()).toEqual(
      [...voiceSteps([60, 64, 67], [64, 67, 72]).entries()].sort()
    );
    expect(voiceSteps([60, 64, 67], [72, 64, 67]).get(72)).toBe(5); // 67 → 72
  });

  it("signs downward motion and skips voices with no counterpart", () => {
    const down = voiceSteps([67, 71, 74], [60, 64, 67]);
    expect([...down.values()]).toEqual([-7, -7, -7]);
    const grown = voiceSteps([60, 64, 67], [60, 64, 67, 71]); // triad → seventh
    expect(grown.has(71)).toBe(false);
    expect(grown.size).toBe(3);
  });

  it("returns nothing when there is no previous chord", () => {
    expect(voiceSteps(null, [60, 64, 67]).size).toBe(0);
    expect(voiceSteps([], [60, 64, 67]).size).toBe(0);
  });

  it("previews what picking an option would cost", () => {
    const from = rootPositionMidi(I);
    expect(optionDistance(from, vi, true)).toBe(2); // just G→A
    expect(optionDistance(from, vi, false)).toBe(voicingDistance(from, rootPositionMidi(vi)));
    expect(optionDistance(null, vi, true)).toBe(null);
  });

  it("reads the bass note for slash-chord display", () => {
    expect(bassNameOf([64, 67, 72], C)).toBe("E");
    expect(bassNameOf([], C)).toBe(null);
  });

  it("converts midi to the note strings Tone expects", () => {
    expect(midiToNotes([60, 61, 45, 57, 72, 35])).toEqual(
      ["C4", "C#4", "A2", "A3", "C5", "B1"]
    );
  });
});

// a seeded PRNG, so a "random" suggestion is reproducible in a test
const seeded = (a) => () => {
  a |= 0; a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe("decorateChain", () => {
  it("reads each chord relative to the one before it", () => {
    const key = buildKey(C, "major");
    const chain = decorateChain([key.diatonic[4], key.diatonic[0]], "major");
    expect(chain[0].motion).toBe(null); // nothing precedes the first
    expect(chain[1].motion).toBe("up a fourth");
    expect(chain[1].move).toMatch(/Authentic cadence/);
  });

  it("flags a suspension resolving onto its triad", () => {
    const key = buildKey(C, "major");
    const fsus4 = suspensionsFor(key).find((s) => s.name === "Fsus4");
    const chain = decorateChain([fsus4, key.diatonic[3]], "major");
    expect(chain[1].resolution).toBe(true);
    expect(chain[1].move).toMatch(/^Resolution/);
  });
});

describe("suggestLoop", () => {
  const keys = [
    [C, "major"],
    [9, "minor"],
    [7, "mixolydian"],
  ];

  it("returns the requested number of bars, starting home", () => {
    for (const [root, mode] of keys) {
      const key = buildKey(root, mode);
      for (const bars of [2, 4, 8]) {
        const loop = suggestLoop(key, { bars, rand: seeded(4) });
        expect(loop).toHaveLength(bars);
        expect(loop[0].rootPc).toBe(key.diatonic[0].rootPc);
      }
    }
  });

  it("is a pure function of its inputs — same seed, same loop", () => {
    const key = buildKey(C, "major");
    const a = suggestLoop(key, { bars: 4, rand: seeded(99) });
    const b = suggestLoop(key, { bars: 4, rand: seeded(99) });
    expect(a.map((c) => c.name)).toEqual(b.map((c) => c.name));
  });

  it("keeps moving: no repeats, no A–B–A, and it never ends at home", () => {
    for (const [root, mode] of keys) {
      const key = buildKey(root, mode);
      for (let seed = 0; seed < 60; seed++) {
        const loop = suggestLoop(key, { bars: 4, rand: seeded(seed) });
        const roots = loop.map((c) => c.rootPc);
        for (let i = 1; i < roots.length; i++) expect(roots[i]).not.toBe(roots[i - 1]);
        // interior bars can't bounce back to the root two before them
        for (let i = 2; i < roots.length - 1; i++) expect(roots[i]).not.toBe(roots[i - 2]);
        // the last bar is adjacent to the first when it comes round again
        expect(roots[roots.length - 1]).not.toBe(roots[0]);
      }
    }
  });

  it("only suggests chords that carry a function and a tension", () => {
    // the colour = function invariant: every chord must plot and get a hue
    for (const [root, mode] of keys) {
      const key = buildKey(root, mode);
      const pool = new Set([...key.diatonic, ...key.colour].map((c) => c.roman));
      for (let seed = 0; seed < 30; seed++) {
        for (const c of suggestLoop(key, { bars: 8, rand: seeded(seed) })) {
          expect(pool.has(c.roman)).toBe(true);
          expect(typeof c.func).toBe("string");
          expect(typeof c.tension).toBe("number");
          expect(typeof c.move).toBe("string"); // arrives decorated, like a chosen chord
        }
      }
    }
  });
});
