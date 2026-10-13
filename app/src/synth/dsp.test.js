import { describe, it, expect } from "vitest";
import {
  filterResponse,
  logFreqs,
  logPos,
  spectrumAt,
  scopeSpan,
  findTrigger,
  sampleFrame,
} from "./dsp.js";

const SR = 48000;
const at = (spec, f) => filterResponse(spec, [f], SR)[0];

describe("the filter's response", () => {
  const lp = { type: "lowpass", cutoff: 1000, q: 0 };
  const hp = { type: "highpass", cutoff: 1000, q: 0 };

  it("passes the lows untouched through a lowpass, and the highs through a highpass", () => {
    expect(at(lp, 20)).toBeCloseTo(0, 1);
    expect(at(hp, 20000)).toBeCloseTo(0, 0);
  });

  it("puts the resonance at the cutoff — Web Audio reads Q in dB, once per stage", () => {
    // the RBJ biquads have gain Q exactly at the corner, whatever the type
    for (const q of [0, 3, 12]) {
      expect(at({ ...lp, q }, 1000), `lp q=${q}`).toBeCloseTo(2 * q, 4);
      expect(at({ ...hp, q }, 1000), `hp q=${q}`).toBeCloseTo(2 * q, 4);
      expect(at({ ...lp, q, stages: 1 }, 1000), `one stage q=${q}`).toBeCloseTo(q, 4);
    }
  });

  it("falls at about 24dB an octave past the corner, two stages deep", () => {
    const oneOct = at(lp, 4000) - at(lp, 2000);
    expect(oneOct).toBeLessThan(-20);
    expect(oneOct).toBeGreaterThan(-26);
    const below = at(hp, 250) - at(hp, 500);
    expect(below).toBeLessThan(-20);
  });

  it("mirrors: a highpass cuts what a lowpass keeps", () => {
    expect(at(lp, 100)).toBeGreaterThan(-1);
    expect(at(hp, 100)).toBeLessThan(-60);
    expect(at(lp, 10000)).toBeLessThan(-60);
    expect(at(hp, 10000)).toBeGreaterThan(-1);
  });

  it("whistles louder at the corner the more resonance it has", () => {
    expect(at({ ...lp, q: 8 }, 1000)).toBeGreaterThan(at({ ...lp, q: 2 }, 1000));
  });

  it("treats a cutoff at or past Nyquist as Web Audio does: lowpass open, highpass shut", () => {
    expect(at({ ...lp, cutoff: 30000 }, 5000)).toBeCloseTo(0, 6);
    expect(at({ ...hp, cutoff: 30000 }, 5000)).toBeLessThan(-200);
  });
});

describe("the octave axis", () => {
  it("spaces frequencies evenly in octaves, end to end", () => {
    const f = logFreqs(11, 20, 20480);
    expect(f[0]).toBeCloseTo(20);
    expect(f[10]).toBeCloseTo(20480);
    expect(f[1] / f[0]).toBeCloseTo(2); // ten octaves in ten steps
    expect(f[7] / f[6]).toBeCloseTo(2);
  });

  it("places a frequency along it", () => {
    expect(logPos(20, 20, 20000)).toBe(0);
    expect(logPos(20000, 20, 20000)).toBeCloseTo(1);
    expect(logPos(632.46, 20, 20000)).toBeCloseTo(0.5, 3); // the geometric middle
  });
});

describe("the spectrum on an octave axis", () => {
  // 1024 bins at 48kHz: bin k is k × 23.4375Hz
  const bins = new Float32Array(1024).fill(-100);
  bins[43] = -20; // ~1kHz
  bins[427] = -30; // ~10kHz

  it("never lets a harmonic fall between two display points", () => {
    const freqs = logFreqs(40, 20, 20000); // coarse at the top: many bins per point
    const s = spectrumAt(bins, SR, freqs);
    expect(Math.max(...s)).toBe(-20);
    expect(s.filter((v) => v === -30)).toHaveLength(1);
  });

  it("draws a straight line between bins where points are finer than bins", () => {
    const b = new Float32Array(1024).fill(-100);
    b[4] = -40;
    b[5] = -60;
    const binHz = SR / 2048;
    const [mid] = spectrumAt(b, SR, [4.5 * binHz, 4.6 * binHz]);
    expect(mid).toBeCloseTo(-50);
  });
});

describe("the scope's frame", () => {
  it("shows three periods of the lowest note, within bounds", () => {
    expect(scopeSpan(100, SR)).toBe(1440); // 30ms
    expect(scopeSpan(0, SR)).toBe(Math.round((3 / 261.63) * SR)); // middle C when silent
    expect(scopeSpan(5000, SR)).toBe(192); // no shorter than 4ms
    expect(scopeSpan(20, SR)).toBe(2160); // no longer than 45ms
  });

  const sine = (n, period, phase = 0) =>
    Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * (i + phase)) / period));

  it("starts on a rising zero crossing, the newest when there's nothing to match", () => {
    const x = sine(1000, 100, 30.5); // crosses upward between 69 and 70, 169 and 170…
    const t = findTrigger(x, 0, 900, 200, null);
    expect(t % 100).toBe(70);
    expect(t).toBe(870);
    expect(x[t - 1]).toBeLessThan(0);
    expect(x[t]).toBeGreaterThanOrEqual(0);
  });

  it("shows the newest samples when nothing crosses zero", () => {
    expect(findTrigger(new Float32Array(500).fill(0.3), 0, 400, 100, null)).toBe(400);
    expect(findTrigger(new Float32Array(500), 0, 400, 100, null)).toBe(400);
  });

  it("locks onto a chord's own shape, not just any crossing", () => {
    // a fundamental under a strong third harmonic crosses zero upward three
    // times a period, at points that look nothing alike; the frame drawn last time picks the right one
    const n = 2000, P = 200;
    const x = Float32Array.from({ length: n }, (_, i) =>
      Math.sin((2 * Math.PI * i) / P) + 1.2 * Math.sin((2 * Math.PI * 3 * i) / P + 1.2)
    );
    const crossings = [];
    for (let i = 1; i < P + 1; i++) if (x[i - 1] < 0 && x[i] >= 0) crossings.push(i);
    expect(crossings.length).toBeGreaterThan(1);
    const span = 2 * P;
    // whichever crossing was drawn last time, the next frame starts a whole
    // number of periods later
    for (const c of crossings) {
      const prev = sampleFrame(x, c, span, 96);
      const t = findTrigger(x, 600, 1400, span, prev);
      expect((t - c) % P, `from ${c}`).toBe(0);
    }
  });

  it("samples a frame evenly, and pads past the end with silence", () => {
    const x = Float32Array.from({ length: 10 }, (_, i) => i);
    expect(sampleFrame(x, 2, 6, 3)).toEqual([2, 4, 6]);
    expect(sampleFrame(x, 8, 4, 4)).toEqual([8, 9, 0, 0]);
  });
});
