import { describe, it, expect } from "vitest";
import {
  SYNTH_PARAMS,
  SYNTH_KEYS,
  SYNTH_WIRE,
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
  retiredFromSynth,
  isDefaultSound,
  oscType,
  LFO_OCTAVES,
  lfoCents,
  contourCents,
  cutoffAt,
} from "./params.js";

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
    expect(flat.sort()).toEqual([...SYNTH_KEYS].sort());
  });

  it("lays the filter's columns out side by side, in the table's order", () => {
    expect(SYNTH_GROUPS.map((g) => g.name)).toEqual(["Osc", "Filter", "Filter env", "Amp env", "Space"]);
    expect(SYNTH_GROUPS[1].keys[0]).toBe("filterType");
  });

  it("gives every preset a value for every parameter, in range", () => {
    for (const [name, p] of Object.entries(PRESETS)) {
      expect(Object.keys(p).sort(), name).toEqual([...SYNTH_KEYS].sort());
      for (const k of SYNTH_KEYS) {
        const spec = SYNTH_PARAMS[k];
        if (spec.kind === "enum") expect(spec.options, `${name}.${k}`).toContain(p[k]);
        else {
          expect(p[k], `${name}.${k}`).toBeGreaterThanOrEqual(spec.min);
          expect(p[k], `${name}.${k}`).toBeLessThanOrEqual(spec.max);
        }
      }
    }
  });

  it("keeps one preset with the filter standing still, to hear the others against", () => {
    expect(PRESETS.Organ.filterEnv).toBe(0);
    expect(PRESETS.Organ.lfoDepth).toBe(0);
  });

  it("shows off the highpass with at least one preset", () => {
    expect(Object.values(PRESETS).some((p) => p.filterType === "highpass")).toBe(true);
  });
});

describe("the wire format", () => {
  it("writes every live parameter exactly once", () => {
    const live = SYNTH_WIRE.filter((s) => !s.startsWith("~"));
    expect([...live].sort()).toEqual([...SYNTH_KEYS].sort());
    expect(new Set(SYNTH_WIRE).size).toBe(SYNTH_WIRE.length);
  });

  it("keeps the slots every existing link was written against", () => {
    // append-only: these positions are in links people have already shared
    expect(SYNTH_WIRE.slice(0, 16)).toEqual([
      "wave", "spread", "drive",
      "attack", "decay", "sustain", "release",
      "cutoff", "resonance", "lfoRate", "lfoDepth",
      "chorus", "reverb", "size",
      "~dynamics", "~humanise",
    ]);
  });
});

describe("slider mapping", () => {
  it("round-trips every preset value through the slider", () => {
    for (const [name, p] of Object.entries(PRESETS)) {
      for (const k of SYNTH_KEYS) {
        if (SYNTH_PARAMS[k].kind === "enum") continue;
        const back = paramFromPos(k, paramToPos(k, p[k]));
        // 1000 steps over a log range is finer than a tenth of a percent
        expect(Math.abs(back - p[k]) / (p[k] || 1), `${name}.${k}`).toBeLessThan(0.01);
      }
    }
  });

  it("puts the ends of the range at the ends of the slider", () => {
    for (const k of SYNTH_KEYS) {
      const p = SYNTH_PARAMS[k];
      if (p.kind === "enum") continue;
      expect(paramToPos(k, p.min), k).toBe(0);
      expect(paramToPos(k, p.max), k).toBe(1000);
      expect(paramFromPos(k, 0), k).toBeCloseTo(p.min, 3);
      expect(paramFromPos(k, 1000), k).toBeCloseTo(p.max, 3);
    }
  });

  it("spends the middle of a log slider on a geometric mean, not an average", () => {
    // cutoff runs 80Hz–14kHz: halfway is ~1.06kHz, not ~7kHz
    const mid = paramFromPos("cutoff", 500);
    expect(mid).toBeGreaterThan(1000);
    expect(mid).toBeLessThan(1120);
  });

  it("clamps out-of-range and junk values", () => {
    expect(clampParam("cutoff", 99999)).toBe(SYNTH_PARAMS.cutoff.max);
    expect(clampParam("cutoff", -5)).toBe(SYNTH_PARAMS.cutoff.min);
    expect(clampParam("cutoff", "banana")).toBe(null);
    expect(clampParam("wave", "sawtooth")).toBe("sawtooth");
    expect(clampParam("wave", "bagpipe")).toBe("sine");
    expect(clampParam("filterType", "notch")).toBe("lowpass");
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
    expect(formatParam("filterEnv", 2.6)).toBe("2.6 oct");
    expect(formatParam("filterEnv", 0)).toBe("off");
  });
});

describe("sharing a sound", () => {
  it("round-trips a preset exactly", () => {
    for (const [name, p] of Object.entries(PRESETS)) {
      expect(unpackSynth(packSynth(p)), name).toEqual(p);
    }
  });

  it("round-trips a sound that isn't a preset", () => {
    const custom = {
      ...defaultSound(), cutoff: 812.5, lfoDepth: 0.63, wave: "square",
      filterType: "highpass", filterEnv: 3.25, filterDecay: 1.75,
    };
    expect(unpackSynth(packSynth(custom))).toEqual(custom);
  });

  it("reopens a shared preset under its own name, not as custom", () => {
    for (const name of Object.keys(PRESETS)) {
      expect(presetNameFor(unpackSynth(packSynth(PRESETS[name])))).toBe(name);
    }
  });

  it("calls a nudged preset custom", () => {
    expect(presetNameFor({ ...PRESETS.Pad, cutoff: 1401 })).toBe(null);
    expect(presetNameFor({ ...PRESETS.Pluck, filterType: "highpass" })).toBe(null);
  });

  it("writes the retired slots empty", () => {
    const parts = packSynth(defaultSound()).split("-");
    expect(parts).toHaveLength(SYNTH_WIRE.length);
    expect(parts[14]).toBe("");
    expect(parts[15]).toBe("");
  });

  it("falls back per-parameter rather than discarding a short or damaged link", () => {
    const d = defaultSound();
    expect(unpackSynth("")).toEqual(d);
    expect(unpackSynth(undefined)).toEqual(d);
    // only the wave and spread survive; the older parameters take the default
    // preset, and the filter envelope — which the link predates — stays shut
    expect(unpackSynth("3-20")).toEqual({
      ...d, wave: "square", spread: 20, filterType: "lowpass", filterEnv: 0,
    });
    // junk in one slot doesn't take the others with it
    const junk = unpackSynth("99-x--0.5");
    expect(junk.wave).toBe(d.wave);
    expect(junk.spread).toBe(d.spread);
    expect(junk.attack).toBe(0.5);
  });

  it("opens a link from before the filter envelope as it sounded then", () => {
    // the old Pluck, exactly as the previous build wrote it into links
    const old = "2-8-0.15-0.004-0.28-0.08-0.5-2600-4-0.5-0-0.1-0.18-1.4-0.7-0.45";
    const s = unpackSynth(old);
    expect(s.cutoff).toBe(2600);
    expect(s.filterType).toBe("lowpass");
    expect(s.filterEnv).toBe(0);
  });

  it("hands Dynamics and Humanise from an old link to the player", () => {
    const old = "2-8-0.15-0.004-0.28-0.08-0.5-2600-4-0.5-0-0.1-0.18-1.4-0.7-0.45";
    expect(retiredFromSynth(old)).toEqual({ dynamics: 0.7, humanise: 0.45 });
    // a new link has nothing there, and the player keeps its own
    expect(retiredFromSynth(packSynth(PRESETS.Pad))).toEqual({});
    expect(retiredFromSynth(undefined)).toEqual({});
    expect(retiredFromSynth("0-0-0-0-0-0-0-0-0-0-0-0-0-0-7-x")).toEqual({ dynamics: 1 });
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

  it("measures the modulation in cents, an octave being 1200", () => {
    expect(contourCents(2)).toBe(2400);
    expect(lfoCents(1)).toBeCloseTo(LFO_OCTAVES * 1200);
    expect(lfoCents(0)).toBe(0);
  });

  it("puts the cutoff at the level when nothing is moving it", () => {
    expect(cutoffAt(PRESETS.Pluck)).toBe(PRESETS.Pluck.cutoff);
    expect(cutoffAt(PRESETS.Pluck, 0, 0.7)).toBe(PRESETS.Pluck.cutoff); // no LFO depth
  });

  it("opens the filter by the envelope's amount, in octaves, at the peak", () => {
    const s = { ...PRESETS.Pluck, filterEnv: 2 };
    expect(cutoffAt(s, 1)).toBeCloseTo(s.cutoff * 4);
    expect(cutoffAt(s, 0.5)).toBeCloseTo(s.cutoff * 2);
  });

  it("swings the LFO evenly either side of the cutoff, in octaves", () => {
    const s = { ...PRESETS.Sweep };
    const up = cutoffAt(s, 0, 1);
    const down = cutoffAt(s, 0, -1);
    expect(up * down).toBeCloseTo(s.cutoff * s.cutoff, -1); // geometrically centred
    expect(Math.log2(up / s.cutoff)).toBeCloseTo(LFO_OCTAVES * s.lfoDepth);
  });

  it("adds the envelope and the LFO together", () => {
    const s = { ...PRESETS.Sweep, filterEnv: 1, lfoDepth: 0.5, cutoff: 500 };
    expect(cutoffAt(s, 1, 1)).toBeCloseTo(500 * Math.pow(2, 1 + LFO_OCTAVES * 0.5));
  });

  it("keeps an extreme setting inside the range a filter can take", () => {
    const s = { ...PRESETS.Pluck, cutoff: 14000, filterEnv: 5 };
    expect(cutoffAt(s, 1)).toBeLessThanOrEqual(24000);
  });
});
