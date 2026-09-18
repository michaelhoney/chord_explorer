import { describe, it, expect } from "vitest";
import {
  SYNTH_PARAMS,
  SYNTH_ORDER,
  SYNTH_GROUPS,
  PRESETS,
  DEFAULT_PRESET,
  defaultSound,
  presetNameFor,
  paramToPos,
  paramFromPos,
  clampParam,
  formatParam,
  packSynth,
  unpackSynth,
  isDefaultSound,
  oscType,
  lfoRange,
  velocityCurve,
  arpSequence,
  chordEvents,
} from "./synth.js";

// a deterministic stand-in for Math.random — velocityCurve takes rand as an
// argument precisely so a test can do this
const seq = (...vals) => {
  let i = 0;
  return () => vals[i++ % vals.length];
};

describe("the parameter table", () => {
  it("gives every parameter a label, a group and a way to read it", () => {
    for (const [k, p] of Object.entries(SYNTH_PARAMS)) {
      expect(p.label, k).toBeTruthy();
      expect(p.group, k).toBeTruthy();
      expect(p.hint, k).toBeTruthy();
      if (p.kind === "enum") expect(p.options.length, k).toBeGreaterThan(1);
      else expect(p.max, k).toBeGreaterThan(p.min);
    }
  });

  it("groups the knobs without losing or duplicating one", () => {
    const flat = SYNTH_GROUPS.flatMap((g) => g.keys);
    expect(flat.sort()).toEqual([...SYNTH_ORDER].sort());
  });

  it("gives every preset a value for every parameter, in range", () => {
    for (const [name, p] of Object.entries(PRESETS)) {
      for (const k of SYNTH_ORDER) {
        const spec = SYNTH_PARAMS[k];
        expect(p[k], `${name}.${k}`).toBeDefined();
        if (spec.kind === "enum") expect(spec.options).toContain(p[k]);
        else {
          expect(p[k], `${name}.${k}`).toBeGreaterThanOrEqual(spec.min);
          expect(p[k], `${name}.${k}`).toBeLessThanOrEqual(spec.max);
        }
      }
    }
  });
});

describe("slider mapping", () => {
  it("round-trips every preset value through the slider", () => {
    for (const [name, p] of Object.entries(PRESETS)) {
      for (const k of SYNTH_ORDER) {
        if (SYNTH_PARAMS[k].kind === "enum") continue;
        const back = paramFromPos(k, paramToPos(k, p[k]));
        // 1000 steps over a log range is finer than a tenth of a percent
        expect(Math.abs(back - p[k]) / (p[k] || 1), `${name}.${k}`).toBeLessThan(0.01);
      }
    }
  });

  it("puts the ends of the range at the ends of the slider", () => {
    for (const k of SYNTH_ORDER) {
      const p = SYNTH_PARAMS[k];
      if (p.kind === "enum") continue;
      expect(paramToPos(k, p.min), k).toBe(0);
      expect(paramToPos(k, p.max), k).toBe(1000);
      expect(paramFromPos(k, 0), k).toBeCloseTo(p.min, 3);
      expect(paramFromPos(k, 1000), k).toBeCloseTo(p.max, 3);
    }
  });

  it("spends the middle of a log slider on a geometric mean, not an average", () => {
    // cutoff runs 180Hz–14kHz: halfway is ~1.6kHz, not ~7kHz
    const mid = paramFromPos("cutoff", 500);
    expect(mid).toBeGreaterThan(1400);
    expect(mid).toBeLessThan(1700);
  });

  it("clamps out-of-range and junk values", () => {
    expect(clampParam("cutoff", 99999)).toBe(SYNTH_PARAMS.cutoff.max);
    expect(clampParam("cutoff", -5)).toBe(SYNTH_PARAMS.cutoff.min);
    expect(clampParam("cutoff", "banana")).toBe(null);
    expect(clampParam("wave", "sawtooth")).toBe("sawtooth");
    expect(clampParam("wave", "bagpipe")).toBe("sine");
  });
});

describe("readouts", () => {
  it("reads each value in its own unit", () => {
    expect(formatParam("cutoff", 440)).toBe("440 Hz");
    expect(formatParam("cutoff", 3200)).toBe("3.20 kHz");
    expect(formatParam("attack", 0.015)).toBe("15 ms");
    expect(formatParam("release", 1.3)).toBe("1.30 s");
    expect(formatParam("sustain", 0.55)).toBe("55%");
    expect(formatParam("spread", 0)).toBe("off");
    expect(formatParam("spread", 22)).toBe("22¢");
    expect(formatParam("resonance", 4)).toBe("4.0");
  });
});

describe("sharing a sound", () => {
  it("round-trips a preset exactly", () => {
    for (const [name, p] of Object.entries(PRESETS)) {
      expect(unpackSynth(packSynth(p)), name).toEqual(p);
    }
  });

  it("round-trips a sound that isn't a preset", () => {
    const custom = { ...defaultSound(), cutoff: 812.5, lfoDepth: 0.63, wave: "square" };
    expect(unpackSynth(packSynth(custom))).toEqual(custom);
  });

  it("reopens a shared preset under its own name, not as custom", () => {
    for (const name of Object.keys(PRESETS)) {
      expect(presetNameFor(unpackSynth(packSynth(PRESETS[name])))).toBe(name);
    }
  });

  it("calls a nudged preset custom", () => {
    expect(presetNameFor({ ...PRESETS.Pad, cutoff: 1401 })).toBe(null);
  });

  it("falls back per-parameter rather than discarding a short or damaged link", () => {
    const d = defaultSound();
    expect(unpackSynth("")).toEqual(d);
    expect(unpackSynth(undefined)).toEqual(d);
    // only the wave and spread survive; the rest defaults
    expect(unpackSynth("3-20")).toEqual({ ...d, wave: "square", spread: 20 });
    // junk in one slot doesn't take the others with it
    const junk = unpackSynth("99-x--0.5");
    expect(junk.wave).toBe(d.wave);
    expect(junk.spread).toBe(d.spread);
    expect(junk.attack).toBe(0.5);
  });

  it("knows when there is nothing worth putting in the URL", () => {
    expect(isDefaultSound(defaultSound())).toBe(true);
    expect(isDefaultSound(PRESETS[DEFAULT_PRESET])).toBe(true);
    expect(isDefaultSound(PRESETS.Organ)).toBe(false);
  });
});

describe("derived audio settings", () => {
  it("only asks Tone for a fat oscillator when there is detuning to do", () => {
    expect(oscType("sawtooth", 0)).toBe("sawtooth");
    expect(oscType("sawtooth", 12)).toBe("fatsawtooth");
  });

  it("centres the filter sweep on the cutoff", () => {
    const { min, max } = lfoRange(1000, 0.5);
    expect(min * max).toBeCloseTo(1000 * 1000, -2); // geometrically centred
    expect(min).toBeLessThan(1000);
    expect(max).toBeGreaterThan(1000);
  });

  it("collapses to a still filter at zero depth", () => {
    const { min, max } = lfoRange(2200, 0);
    expect(min).toBe(2200);
    expect(max).toBe(2200);
  });

  it("keeps a deep sweep inside audible range", () => {
    const { min, max } = lfoRange(14000, 1);
    expect(min).toBeGreaterThanOrEqual(30);
    expect(max).toBeLessThanOrEqual(18000);
  });
});

describe("velocity shaping", () => {
  const chord = [48, 55, 60, 64];
  const still = () => 0.5; // no jitter drawn from a constant rand at 0.5 midpoint

  it("plays every voice equally at zero dynamics — the organ", () => {
    const v = velocityCurve(chord, { dynamics: 0, humanise: 0 }, still);
    expect(new Set(v.map((x) => x.velocity)).size).toBe(1);
  });

  it("leans on the bass and the top, and tucks the inner voices under", () => {
    const [bass, i1, i2, top] = velocityCurve(chord, { dynamics: 1, humanise: 0 }, still);
    expect(bass.velocity).toBeGreaterThan(top.velocity);
    expect(top.velocity).toBeGreaterThan(i1.velocity);
    expect(i1.velocity).toBe(i2.velocity);
  });

  it("scales continuously between the two", () => {
    const half = velocityCurve(chord, { dynamics: 0.5, humanise: 0 }, still);
    const full = velocityCurve(chord, { dynamics: 1, humanise: 0 }, still);
    expect(half[0].velocity).toBeGreaterThan(0.8);
    expect(half[0].velocity).toBeLessThan(full[0].velocity);
  });

  it("keeps a single note out of the bass/top special cases", () => {
    const [only] = velocityCurve([60], { dynamics: 1, humanise: 0 }, still);
    expect(only.velocity).toBeCloseTo(0.9, 5);
  });

  it("delays nothing and jitters nothing when humanise is off", () => {
    const v = velocityCurve(chord, { dynamics: 0.5, humanise: 0 }, seq(0.1, 0.9, 0.3, 0.7));
    expect(v.every((x) => x.delay === 0)).toBe(true);
    expect(v[1].velocity).toBe(v[2].velocity); // both inner voices, untouched
  });

  it("scatters volume and onset once humanise is up", () => {
    const v = velocityCurve(chord, { dynamics: 0, humanise: 1 }, seq(0.1, 0.9, 0.3, 0.7));
    expect(new Set(v.map((x) => x.velocity)).size).toBeGreaterThan(1);
    expect(v.some((x) => x.delay > 0)).toBe(true);
    expect(v.every((x) => x.delay < 0.02)).toBe(true); // a feel, not a flam
  });

  it("stays a legal velocity however hard it is pushed", () => {
    const v = velocityCurve(chord, { dynamics: 1, humanise: 1 }, seq(1, 1, 0, 0));
    expect(v.every((x) => x.velocity > 0 && x.velocity <= 1)).toBe(true);
  });

  it("draws the same number of times whatever humanise is, so the shape holds", () => {
    let a = 0, b = 0;
    velocityCurve(chord, { humanise: 0 }, () => (a++, 0.5));
    velocityCurve(chord, { humanise: 1 }, () => (b++, 0.5));
    expect(a).toBe(b);
  });

  it("is a pure function of its inputs", () => {
    const one = velocityCurve(chord, PRESETS.Pad, seq(0.2, 0.4, 0.6, 0.8));
    const two = velocityCurve(chord, PRESETS.Pad, seq(0.2, 0.4, 0.6, 0.8));
    expect(one).toEqual(two);
  });
});

// a seeded stand-in for Math.random, for tests that need many draws
const lcg = (s) => () => (s = (s * 9301 + 49297) % 233280) / 233280;

describe("arpeggio order", () => {
  const triad = [60, 64, 67]; // C E G
  const seventh = [55, 60, 64, 67];

  it("rises through the chord by default", () => {
    expect(arpSequence(triad)).toEqual([60, 64, 67]);
    expect(arpSequence(seventh)).toEqual(seventh);
  });

  it("pads a triad to four steps by coming back to the second note: 1 3 5 3", () => {
    expect(arpSequence(triad, { four: true })).toEqual([60, 64, 67, 64]);
  });

  it("leaves chords of four or more notes alone under -4-", () => {
    expect(arpSequence(seventh, { four: true })).toEqual(seventh);
    expect(arpSequence([48, ...seventh], { four: true })).toHaveLength(5);
  });

  it("shuffles into a real permutation of the chord", () => {
    const rand = lcg(37);
    for (let k = 0; k < 50; k++) {
      const s = arpSequence(seventh, { order: "random" }, rand);
      expect([...s].sort((a, b) => a - b)).toEqual(seventh);
    }
  });

  it("actually varies the order when random", () => {
    const rand = lcg(11);
    const seen = new Set();
    for (let k = 0; k < 60; k++) seen.add(arpSequence(triad, { order: "random" }, rand).join());
    expect(seen.size).toBe(6); // all 3! orders turn up
  });

  it("repeats the second note played when random and -4- together", () => {
    const s = arpSequence(triad, { order: "random", four: true }, seq(0.9, 0.1));
    expect(s).toHaveLength(4);
    expect(s[3]).toBe(s[1]);
  });

  it("is a pure function of its inputs, and leaves the chord untouched", () => {
    const chord = [...triad];
    const a = arpSequence(chord, { order: "random", four: true }, seq(0.2, 0.7));
    const b = arpSequence(chord, { order: "random", four: true }, seq(0.2, 0.7));
    expect(a).toEqual(b);
    expect(chord).toEqual(triad);
  });

  it("plays a single note as itself", () => {
    expect(arpSequence([60], { four: true, order: "random" })).toEqual([60]);
  });
});

describe("chord events", () => {
  const triad = [60, 64, 67];
  const B = 48; // a C bass
  const still = { dynamics: 0.5, humanise: 0 }; // no timing scatter, so times are exact
  const opts = (o) => ({ dur: 1.1, span: 1.25, sound: still, ...o });
  const shape = (evs) => evs.map((e) => `${e.midi}@${+e.at.toFixed(4)}/${+e.dur.toFixed(4)}`);

  it("plays a block chord all at once, bass included", () => {
    const ev = chordEvents(triad, B, opts({}));
    expect(ev.map((e) => e.midi)).toEqual([48, 60, 64, 67]);
    expect(ev.every((e) => e.at === 0 && e.dur === 1.1)).toBe(true);
  });

  it("spreads an arpeggio evenly across the whole span", () => {
    expect(shape(chordEvents(triad, null, opts({ arp: true })))).toEqual([
      "60@0/0.375", "64@0.4167/0.375", "67@0.8333/0.375",
    ]);
  });

  it("-4- with the bass in the arp: B 1 3 5", () => {
    const ev = chordEvents(triad, B, opts({ arp: true, four: true }));
    expect(ev.map((e) => e.midi)).toEqual([48, 60, 64, 67]);
    expect(ev.map((e) => +e.at.toFixed(4))).toEqual([0, 0.3125, 0.625, 0.9375]);
  });

  it("-4- with the bass held: a whole-slot bass under 1 3 5 3", () => {
    const ev = chordEvents(triad, B, opts({ arp: true, four: true, holdBass: true }));
    expect(shape(ev)).toEqual([
      "48@0/1.1",
      "60@0/0.2813", "64@0.3125/0.2813", "67@0.625/0.2813", "64@0.9375/0.2813",
    ]);
  });

  it("holds the bass out of a random order too", () => {
    for (let k = 0; k < 20; k++) {
      const ev = chordEvents(triad, B, opts({ arp: true, holdBass: true, order: "random" }));
      expect(ev[0]).toMatchObject({ midi: 48, at: 0, dur: 1.1 });
      expect(ev.slice(1).map((e) => e.midi).sort()).toEqual(triad);
    }
  });

  it("ignores holdBass when there is no bass voice", () => {
    const a = chordEvents(triad, null, opts({ arp: true, four: true, holdBass: true }));
    expect(a.map((e) => e.midi)).toEqual([60, 64, 67, 64]);
  });

  it("finds the bass by being told, not by being lowest", () => {
    // an inverted upper voice below the bass: the held note is still the bass
    const ev = chordEvents([45, 64, 67], 48, opts({ arp: true, holdBass: true }));
    expect(ev[0].midi).toBe(48);
    expect(ev.slice(1).map((e) => e.midi)).toEqual([45, 64, 67]);
  });

  it("keeps the bass's weight whether it's held or in the arp", () => {
    const loud = { dynamics: 1, humanise: 0 };
    const held = chordEvents(triad, B, { arp: true, holdBass: true, sound: loud });
    const inArp = chordEvents(triad, B, { arp: true, sound: loud });
    const bassVel = (ev) => ev.find((e) => e.midi === B).velocity;
    expect(bassVel(held)).toBe(bassVel(inArp));
    expect(bassVel(held)).toBeGreaterThan(held.find((e) => e.midi === 64).velocity);
  });
});
