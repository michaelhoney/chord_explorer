/* ------------------------------------------------------------------ *
 *  DSP — the arithmetic behind the synth's display
 *
 *  Pure and import-free, like params.js. The scope is drawn from numbers
 *  the engine reads out of the audio graph; everything that turns those
 *  numbers into a picture — the filter's response curve, where a frame
 *  of waveform starts, how FFT bins land on an octave axis — is here,
 *  where it can be tested without a sound card.
 * ------------------------------------------------------------------ */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ------------------------------------------------------------------------
//  THE FILTER'S RESPONSE
// ------------------------------------------------------------------------
// The gain of the synth's filter, in dB, at each of `freqs` — from the
// coefficient formulas the Web Audio spec gives for BiquadFilterNode, so the
// curve on the display is the filter you hear rather than a textbook one. Two
// details matter. Web Audio reads a lowpass or highpass Q in *decibels* — the
// height of the bump at the cutoff — which is what the Resonance level sets.
// And Tone's −24dB/octave filter is two identical biquads in series, so its
// response is one stage's, twice over (`stages`).
export function filterResponse({ type = "lowpass", cutoff, q = 0, stages = 2 }, freqs, sampleRate = 48000) {
  const f0 = clamp(cutoff, 0, sampleRate / 2);
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.pow(10, q / 20));
  const hp = type === "highpass";
  const b0 = hp ? (1 + cw) / 2 : (1 - cw) / 2;
  const b1 = hp ? -(1 + cw) : 1 - cw;
  const b2 = b0;
  const a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
  return freqs.map((f) => {
    const w = (2 * Math.PI * f) / sampleRate;
    const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
    const dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
    const mag2 = (nr * nr + ni * ni) / (dr * dr + di * di);
    return stages * 10 * Math.log10(Math.max(mag2, 1e-30));
  });
}

// `n` frequencies spaced evenly in octaves from `lo` to `hi` — the display's
// horizontal axis, where 100Hz→200Hz is as wide as 5k→10k, as the ear hears it
export function logFreqs(n, lo = 20, hi = 20000) {
  const r = Math.log(hi / lo);
  return Array.from({ length: n }, (_, i) => lo * Math.exp((r * i) / Math.max(1, n - 1)));
}

// where `f` sits along that axis, 0–1
export const logPos = (f, lo = 20, hi = 20000) => Math.log(f / lo) / Math.log(hi / lo);

// ------------------------------------------------------------------------
//  THE SPECTRUM
// ------------------------------------------------------------------------
// An FFT's bins are spaced evenly in Hz, but the display runs in octaves: at
// the bottom several display points share one bin, at the top one point
// spans hundreds. So: between two neighbouring display frequencies, the
// loudest bin — a harmonic must never fall between the cracks — and where no
// bin falls between them, a straight line between the two nearest.
// `bins` is in dB, as an AnalyserNode gives it; bin k sits at k·sr/fftSize.
export function spectrumAt(bins, sampleRate, freqs) {
  const binHz = sampleRate / (2 * bins.length);
  const last = bins.length - 1;
  return freqs.map((f, i) => {
    const lo = f / binHz;
    const hi = (i + 1 < freqs.length ? freqs[i + 1] : f) / binHz;
    if (hi - lo < 1) {
      const k = clamp(Math.floor(lo), 0, last);
      const t = lo - Math.floor(lo);
      const next = bins[Math.min(k + 1, last)];
      return bins[k] + (next - bins[k]) * t;
    }
    let m = -Infinity;
    for (let k = clamp(Math.ceil(lo), 0, last); k <= clamp(Math.floor(hi), 0, last); k++) {
      if (bins[k] > m) m = bins[k];
    }
    return m;
  });
}

// ------------------------------------------------------------------------
//  THE SCOPE
// ------------------------------------------------------------------------
// How many samples a frame of waveform shows: three periods of the lowest
// note sounding, so a bass note and a high chord both draw as a few clear
// cycles rather than one bump or a smear. Middle C when nothing is playing.
export function scopeSpan(lowestHz, sampleRate, { periods = 3, min = 0.004, max = 0.045 } = {}) {
  const hz = lowestHz > 0 ? lowestHz : 261.63;
  return Math.round(clamp(periods / hz, min, max) * sampleRate);
}

// Where to start drawing a frame, so that successive frames line up and the
// trace stands still the way it does on a hardware scope. Candidates are the
// rising zero crossings in [lo, hi); a single note has one per cycle and any
// of them will do, but a chord crosses zero several times a cycle, at points
// that look nothing alike. So each candidate is scored against the frame
// drawn last time (`prev`, sampled evenly across `span`), and the closest
// match wins — the scope locks onto the chord's own shape. With no crossing
// at all (silence, or a DC offset) the newest samples are shown.
export function findTrigger(x, lo, hi, span, prev) {
  const cands = [];
  for (let i = Math.max(1, lo); i < hi; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) cands.push(i);
  }
  if (!cands.length) return hi;
  if (!prev || !prev.length) return cands[cands.length - 1];
  // at most 48 candidates, the newest, so a noisy signal can't run up the bill
  const pool = cands.slice(-48);
  const n = prev.length;
  let best = pool[pool.length - 1];
  let bestErr = Infinity;
  for (const c of pool) {
    let err = 0;
    for (let k = 0; k < n && err < bestErr; k++) {
      const d = x[c + Math.floor((k * span) / n)] - prev[k];
      err += d * d;
    }
    if (err < bestErr) {
      bestErr = err;
      best = c;
    }
  }
  return best;
}

// `n` evenly spaced samples of x[start … start+span) — what findTrigger
// compares the next frame against
export function sampleFrame(x, start, span, n) {
  return Array.from({ length: n }, (_, k) => x[start + Math.floor((k * span) / n)] ?? 0);
}
