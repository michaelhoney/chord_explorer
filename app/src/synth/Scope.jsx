import { useEffect, useRef } from "react";
import { SCOPE_SIZE, scopeBuffers } from "./engine.js";
import { cutoffAt, formatHz } from "./params.js";
import {
  filterResponse, logFreqs, logPos, spectrumAt, scopeSpan, findTrigger, sampleFrame,
} from "./dsp.js";

// ------------------------------------------------------------------------
//  THE DISPLAY — what the filter is doing, two ways
// ------------------------------------------------------------------------
// Both panes compare the same two signals: the voices as they'd sound with
// no filter (grey) and as they come out of it (lit). The engine taps them
// either side of the filter, before drive and the effects, so the only
// difference between the traces is the filter.
//
//   Wave       the waveform, held still the way a hardware scope holds it:
//              a lowpass rounds a saw's corners off, resonance rings at the
//              cutoff, a highpass pulls the bottom out of the shape
//   Spectrum   the same by frequency, with the filter's response drawn over
//              both — where the line dips, the filter cuts, and the lit
//              harmonics sit under it. The line moves as the envelope and
//              the LFO move the cutoff; the dashed one is where the
//              envelope opens it to at its peak.
//
// Drawn on canvases from an animation frame, never through React state —
// sixty frames a second of it would re-render the whole synth.

const F_LO = 20, F_HI = 20000;
const DB_TOP = 30, DB_BOT = -60; // the spectrum's range, relative to the loudest "in" harmonic
const TICKS = [
  [50, "50"], [100, "100"], [200, "200"], [500, "500"],
  [1000, "1k"], [2000, "2k"], [5000, "5k"], [10000, "10k"],
];
const DRY = "#77776F";
const GRID = "#2A2A27";
const RULE = "#3D3D39";

// a canvas sized to its box at the screen's pixel density
function fit(c) {
  const r = c.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * dpr));
  const h = Math.max(1, Math.round(r.height * dpr));
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  return { ctx: c.getContext("2d"), w, h, dpr };
}

function trace(ctx, xs, ys) {
  ctx.beginPath();
  for (let i = 0; i < xs.length; i++) {
    if (i) ctx.lineTo(xs[i], ys[i]);
    else ctx.moveTo(xs[i], ys[i]);
  }
}

export default function Scope({ engine, sound, lamp }) {
  const waveRef = useRef(null);
  const specRef = useRef(null);
  const spanRef = useRef(null);
  const cutRef = useRef(null);
  const wrapRef = useRef(null);
  // read from the animation frame, which outlives every render
  const soundRef = useRef(sound);
  const lampRef = useRef(lamp);
  useEffect(() => {
    soundRef.current = sound;
    lampRef.current = lamp;
  });

  useEffect(() => {
    const buf = scopeBuffers();
    let raf = 0;
    let visible = true;
    let prev = null; // the last frame, sampled — what the trigger matches against
    let gain = 1; // the wave pane's vertical scale, eased so it doesn't jump
    let offset = 30; // dB that puts the loudest "in" harmonic on the 0dB line
    let freqs = [];
    let quiet = ""; // what was last drawn with no audio, to skip redrawing it

    const wave = (st) => {
      const { ctx, w, h, dpr } = fit(waveRef.current);
      ctx.clearRect(0, 0, w, h);
      ctx.lineWidth = dpr;
      ctx.strokeStyle = GRID;
      for (let i = 1; i < 8; i++) {
        ctx.beginPath();
        ctx.moveTo((w * i) / 8, 0);
        ctx.lineTo((w * i) / 8, h);
        ctx.stroke();
      }
      for (const f of [0.25, 0.75]) {
        ctx.beginPath();
        ctx.moveTo(0, h * f);
        ctx.lineTo(w, h * f);
        ctx.stroke();
      }
      ctx.strokeStyle = RULE;
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();

      const sr = st?.sampleRate ?? 48000;
      const span = scopeSpan(st?.lowestHz ?? 0, sr);
      spanRef.current.textContent = `${((span / sr) * 1000).toFixed(span / sr < 0.01 ? 1 : 0)} ms`;
      if (!st) {
        // no audio yet: a scope at rest draws its trace flat, not nothing
        ctx.lineWidth = 2 * dpr;
        ctx.strokeStyle = lampRef.current;
        ctx.beginPath();
        ctx.moveTo(0, h / 2);
        ctx.lineTo(w, h / 2);
        ctx.stroke();
        return;
      }

      // trigger on what goes in — a raw oscillator has the cleanest edges —
      // unless there's nothing there, and draw both from the same moment, so
      // any shift between them is the filter's
      let dryPeak = 0, wetPeak = 0;
      for (let i = SCOPE_SIZE - 2 * span; i < SCOPE_SIZE; i++) {
        dryPeak = Math.max(dryPeak, Math.abs(buf.dry[i]));
        wetPeak = Math.max(wetPeak, Math.abs(buf.wet[i]));
      }
      const src = dryPeak > 1e-4 ? buf.dry : buf.wet;
      const start = findTrigger(src, SCOPE_SIZE - 2 * span, SCOPE_SIZE - span, span, prev);
      prev = sampleFrame(src, start, span, 96);
      const peak = Math.max(dryPeak, wetPeak);
      if (peak > 1e-4) {
        const target = 0.85 / peak;
        // shrink fast so a loud note never clips, grow slowly so a decay reads as one
        gain += (target - gain) * (target < gain ? 0.5 : 0.06);
      }
      const xs = new Float32Array(span);
      const ys = new Float32Array(span);
      for (let i = 0; i < span; i++) xs[i] = (i / (span - 1)) * w;
      const draw = (x, color, width, glow) => {
        for (let i = 0; i < span; i++) ys[i] = h / 2 - x[start + i] * gain * (h / 2);
        ctx.lineWidth = width * dpr;
        ctx.strokeStyle = color;
        ctx.shadowColor = glow ? color : "transparent";
        ctx.shadowBlur = glow ? 8 * dpr : 0;
        trace(ctx, xs, ys);
        ctx.stroke();
        ctx.shadowBlur = 0;
      };
      draw(buf.dry, DRY, 1.5, false);
      draw(buf.wet, lampRef.current, 2, true);
    };

    const spectrum = (st) => {
      const { ctx, w, h, dpr } = fit(specRef.current);
      const s = soundRef.current;
      const sr = st?.sampleRate ?? 48000;
      const n = Math.max(32, Math.round(w / (2 * dpr))); // a point every 2 CSS px
      if (freqs.length !== n) freqs = logFreqs(n, F_LO, F_HI);
      const xs = freqs.map((f) => logPos(f, F_LO, F_HI) * w);
      const y = (db) => ((DB_TOP - db) / (DB_TOP - DB_BOT)) * h;

      ctx.clearRect(0, 0, w, h);
      ctx.lineWidth = dpr;
      ctx.strokeStyle = GRID;
      for (const [f] of TICKS) {
        const x = logPos(f, F_LO, F_HI) * w;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let db = DB_TOP - 6; db > DB_BOT; db -= 12) {
        ctx.beginPath();
        ctx.moveTo(0, y(db));
        ctx.lineTo(w, y(db));
        ctx.stroke();
      }
      // 0dB: where the loudest harmonic going in sits, and where the filter
      // leaves a signal alone
      ctx.strokeStyle = RULE;
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.beginPath();
      ctx.moveTo(0, y(0));
      ctx.lineTo(w, y(0));
      ctx.stroke();
      ctx.setLineDash([]);

      if (st) {
        const dry = spectrumAt(buf.drySpec, sr, freqs);
        const wet = spectrumAt(buf.wetSpec, sr, freqs);
        const top = Math.max(...dry);
        if (top > -110) offset += (-top - offset) * 0.1;
        const area = (db, fill, line) => {
          const ys = db.map((v) => Math.min(h, y(Math.max(DB_BOT, v + offset))));
          ctx.beginPath();
          ctx.moveTo(xs[0], h);
          for (let i = 0; i < xs.length; i++) ctx.lineTo(xs[i], ys[i]);
          ctx.lineTo(xs[xs.length - 1], h);
          ctx.closePath();
          ctx.fillStyle = fill;
          ctx.fill();
          ctx.lineWidth = dpr;
          ctx.strokeStyle = line;
          trace(ctx, xs, ys);
          ctx.stroke();
        };
        area(dry, "rgba(119,119,111,.16)", DRY);
        ctx.globalAlpha = 0.3;
        area(wet, lampRef.current, lampRef.current);
        ctx.globalAlpha = 1;
      }

      const curve = (cutoff, dashed) => {
        const db = filterResponse({ type: s.filterType, cutoff, q: s.resonance, stages: 2 }, freqs, sr);
        const ys = db.map((v) => Math.max(-4 * dpr, Math.min(h + 4 * dpr, y(v))));
        ctx.setLineDash(dashed ? [3 * dpr, 4 * dpr] : []);
        ctx.lineWidth = (dashed ? 1.25 : 2) * dpr;
        ctx.strokeStyle = dashed ? "#9A9A92" : lampRef.current;
        ctx.shadowColor = dashed ? "transparent" : lampRef.current;
        ctx.shadowBlur = dashed ? 0 : 8 * dpr;
        trace(ctx, xs, ys);
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.setLineDash([]);
      };
      // where the envelope opens it to, before the live curve so it's underneath
      if (s.filterEnv > 0) curve(cutoffAt(s, 1, 0), true);
      const cutoff = cutoffAt(s, st?.env ?? 0, st?.lfo ?? 0);
      curve(cutoff, false);

      // the cutoff, marked and read out
      const x = Math.min(1, Math.max(0, logPos(cutoff, F_LO, F_HI))) * w;
      ctx.strokeStyle = lampRef.current;
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = dpr;
      ctx.setLineDash([2 * dpr, 3 * dpr]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      const label = cutRef.current;
      label.textContent = formatHz(cutoff);
      label.style.transform = `translateX(${x / dpr}px)`;
      // keep the readout on the glass near the right-hand edge
      label.classList.toggle("flip", x / w > 0.82);
    };

    const frame = () => {
      raf = 0;
      if (!visible) return;
      const st = engine.readScope(buf);
      // with no audio the picture only changes when the sound or the size does
      const key = st ? "" : `${JSON.stringify(soundRef.current)}|${lampRef.current}|${waveRef.current.clientWidth}`;
      if (st || key !== quiet) {
        quiet = key;
        wave(st);
        spectrum(st);
      }
      raf = requestAnimationFrame(frame);
    };

    // nobody is watching a scope scrolled off the page
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (visible && !raf) raf = requestAnimationFrame(frame);
    });
    io.observe(wrapRef.current);
    raf = requestAnimationFrame(frame);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [engine]);

  return (
    <div className="ce-scope" ref={wrapRef}>
      <div
        className="ce-scope-pane"
        title="The waveform either side of the filter: grey is what goes in, lit is what comes out. Close a lowpass and a saw's corners round off; wind up the resonance and it rings at the cutoff."
      >
        <div className="ce-scope-top">
          <span className="ce-scope-name">Wave</span>
          <span className="ce-scope-key"><i className="dry" />in</span>
          <span className="ce-scope-key"><i className="wet" />out</span>
        </div>
        <div className="ce-scope-plot">
          <canvas ref={waveRef} />
        </div>
        <div className="ce-scope-axis">
          <span>0</span>
          <span ref={spanRef} />
        </div>
      </div>
      <div
        className="ce-scope-pane"
        title="The same two signals by frequency, with the filter's response drawn over them: where the line falls away, the filter is cutting. It moves with the envelope and the LFO; the dashed line is where the envelope opens it to."
      >
        <div className="ce-scope-top">
          <span className="ce-scope-name">Spectrum</span>
          <span className="ce-scope-key"><i className="dry" />in</span>
          <span className="ce-scope-key"><i className="fill" />out</span>
          <span className="ce-scope-key"><i className="wet" />filter</span>
        </div>
        <div className="ce-scope-plot">
          <canvas ref={specRef} />
          <span className="ce-scope-cut" ref={cutRef} />
        </div>
        <div className="ce-scope-axis ticks" aria-hidden="true">
          {TICKS.map(([f, t]) => (
            <span key={f} style={{ left: `${logPos(f, F_LO, F_HI) * 100}%` }}>{t}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
