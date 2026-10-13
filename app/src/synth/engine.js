import { useState, useEffect } from "react";
import * as Tone from "tone";
import { oscType, lfoCents, contourCents } from "./params.js";

/* ------------------------------------------------------------------ *
 *  ENGINE — the synth's signal chain, and everything that plays it
 *
 *  The only file in the app that builds audio nodes. The explorer hands
 *  it lists of note events; the keyboard and MIDI in hand it note-ons
 *  and note-offs; the display reads its taps. None of them touch Tone.
 * ------------------------------------------------------------------ */

// ------------------------------------------------------------------------
//  THE CHAIN
// ------------------------------------------------------------------------
//
//   seq  ┐  each voice: osc → filter → amp env       ┌→ (tap: out of the filter)
//        ├────────────────────────────────────→ post ┤
//   keys ┘                                           └→ drive → chorus → reverb → out
//
//   each voice:  osc → its own copy of the amp env → dry → (tap: into the filter)
//                filter env → contour ┐
//   LFO → lfoDepth → ─────────────────┴→ that voice's filter detune
//
// Two pools of voices, one sound: `seq` plays the explorer's chords and `keys`
// the keyboard and MIDI in, so a key you're holding never gets released by a
// chord that happens to share its note, and Stop never cuts a held key.
//
// Everything after the voices is built once and left in place, wet at zero
// where that means "off" — rebuilding the chain when a level moves would cut
// the sound you're trying to listen to. `applySound` retunes what already
// exists, which is the whole point of a knob.
const VOLUME = -11; // headroom: drive and resonance both add level
export const SCOPE_SIZE = 4096; // samples per scope read: ~85ms, three periods of a low E
const LFO_TAP = 32;

// A voice. Tone's Synth is oscillator → amp envelope; this puts a filter
// between the two, with its own envelope on the cutoff — so every note opens
// and closes the filter for itself, the way a polysynth's voice cards do.
//
// The filter envelope and the shared LFO both arrive on the filter's
// *detune*, in cents, where they add: cutoff × 2^(octaves of modulation),
// the way a control voltage moves a hardware filter. That leaves `frequency`
// to the Cutoff level alone — no signal ever owns it. (Connecting a signal
// to a Tone.Signal replaces its value, which is why the LFO used to have to
// carry the cutoff setting in its own range.)
//
// The LFO comes in through a gain of the voice's own, never straight to the
// detune: Tone's disconnect() can't resolve a Signal's parameter, and falls
// back to disconnecting the source from *everything* — which, for a shared
// LFO, would be every other voice.
function voiceClass(bus) {
  return class Voice extends Tone.Synth {
    constructor(options = {}) {
      super(options);
      const ctx = { context: this.context };
      this.filter = new Tone.Filter({ ...ctx, rolloff: -24, ...options.filter });
      this.filterEnvelope = new Tone.Envelope({ ...ctx, ...options.filterEnvelope });
      // the filter envelope runs 0–1; this turns it into cents of cutoff
      this.contour = new Tone.Gain({ ...ctx, gain: options.contour?.gain ?? 0 });
      this.lfoIn = new Tone.Gain({ ...ctx, gain: 1 });
      // the scope's comparison: this voice as it would sound with no filter —
      // the same oscillator through the same amp envelope
      this.dryEnvelope = new Tone.AmplitudeEnvelope({ ...ctx, ...options.envelope });

      this.oscillator.disconnect(this.envelope);
      this.oscillator.chain(this.filter, this.envelope);
      this.oscillator.chain(this.dryEnvelope, bus.dry);
      this.filterEnvelope.chain(this.contour, this.filter.detune);
      bus.lfo.connect(this.lfoIn);
      this.lfoIn.connect(this.filter.detune);
      this.struck = -Infinity; // when this voice last started a note
      bus.voices.add(this);
    }
    _triggerEnvelopeAttack(time, velocity) {
      super._triggerEnvelopeAttack(time, velocity);
      this.filterEnvelope.triggerAttack(time);
      this.dryEnvelope.triggerAttack(time, velocity);
      this.struck = time;
    }
    _triggerEnvelopeRelease(time) {
      super._triggerEnvelopeRelease(time);
      this.filterEnvelope.triggerRelease(time);
      this.dryEnvelope.triggerRelease(time);
    }
    set(props) {
      super.set(props);
      // the dry copy keeps the amp's shape, so the scope's two traces compare
      // like with like
      if (props.envelope && this.dryEnvelope) this.dryEnvelope.set(props.envelope);
      return this;
    }
    dispose() {
      bus.voices.delete(this);
      bus.lfo.disconnect(this.lfoIn);
      super.dispose();
      for (const n of [this.filter, this.filterEnvelope, this.contour, this.lfoIn, this.dryEnvelope]) n.dispose();
      return this;
    }
  };
}

function voiceSettings(s) {
  return {
    oscillator:
      s.spread > 0
        ? { type: oscType(s.wave, s.spread), count: 3, spread: s.spread }
        : { type: oscType(s.wave, 0) },
    envelope: { attack: s.attack, decay: s.decay, sustain: s.sustain, release: s.release },
    filter: { type: s.filterType, frequency: s.cutoff, Q: s.resonance },
    // no release of its own: the filter closes over the amp's release, so a
    // note darkens as it fades — the way a Minimoog-style contour does
    filterEnvelope: {
      attack: s.filterAttack, decay: s.filterDecay, sustain: s.filterSustain, release: s.release,
    },
    contour: { gain: contourCents(s.filterEnv) },
  };
}

function applySound(n, s) {
  const voice = voiceSettings(s);
  n.seq.set(voice);
  n.keys.set(voice);
  n.lfo.frequency.value = s.lfoRate;
  n.bus.lfo.gain.value = lfoCents(s.lfoDepth);
  n.drive.wet.value = s.drive;
  n.drive.distortion = 0.2 + s.drive * 0.6;
  n.chorus.wet.value = s.chorus;
  n.reverb.wet.value = s.reverb;
  // decay is the one setter that re-renders an impulse response, which is
  // both async and audible — so only when it has actually moved
  if (Math.abs(n.size - s.size) > 1e-3) {
    n.reverb.decay = s.size;
    n.size = s.size;
  }
}

function buildChain(s) {
  const ctx = Tone.getContext();
  const bus = {
    lfo: new Tone.Gain(0), // the LFO in cents — every voice listens to it
    dry: new Tone.Gain(Tone.dbToGain(VOLUME)), // matched to the voices' volume
    voices: new Set(),
  };
  const lfo = new Tone.LFO({ frequency: s.lfoRate, min: -1, max: 1 });
  lfo.connect(bus.lfo);
  lfo.start();
  const Voice = voiceClass(bus);
  const seq = new Tone.PolySynth(Voice, voiceSettings(s));
  const keys = new Tone.PolySynth(Voice, voiceSettings(s));
  seq.volume.value = VOLUME;
  keys.volume.value = VOLUME;
  const post = new Tone.Gain(1);
  const drive = new Tone.Distortion({ distortion: 0.3, wet: 0 });
  const chorus = new Tone.Chorus({ frequency: 1.1, delayTime: 3.5, depth: 0.7, wet: 0 }).start();
  const reverb = new Tone.Reverb({ decay: s.size, preDelay: 0.02, wet: 0 });
  seq.connect(post);
  keys.connect(post);
  post.chain(drive, chorus, reverb, Tone.getDestination());

  // the display's taps: plain AnalyserNodes, which run whether or not they
  // lead anywhere — so the dry copy is heard by the scope and nothing else
  const tap = (size, smoothing = 0) => {
    const a = ctx.createAnalyser();
    a.fftSize = size;
    a.smoothingTimeConstant = smoothing;
    return a;
  };
  const taps = { dry: tap(SCOPE_SIZE, 0.6), wet: tap(SCOPE_SIZE, 0.6), lfo: tap(LFO_TAP) };
  bus.dry.connect(taps.dry);
  post.connect(taps.wet);
  lfo.connect(taps.lfo);
  return { seq, keys, bus, lfo, post, drive, chorus, reverb, taps, size: s.size };
}

// a promise that always settles, and never rejects: its own value, or
// `fallback` if it fails or is still pending after `ms` — for the audio calls
// Safari can leave pending forever
const settle = (p, ms, fallback) =>
  Promise.race([
    Promise.resolve(p).catch(() => fallback),
    new Promise((r) => setTimeout(() => r(fallback), ms)),
  ]);

const noteOf = (m) => Tone.Frequency(m, "midi").toNote();
const running = () => Tone.getContext().state === "running";

// what Audition plays before anything else has: C major, struck
const FIRST_AUDITION = [60, 64, 67].map((midi) => ({ midi, at: 0, dur: 1.5, velocity: 0.75 }));

// ------------------------------------------------------------------------
//  THE ENGINE
// ------------------------------------------------------------------------
// A plain object rather than a pile of hooks: it outlives every render, its
// methods are stable, and the devices pass it around without re-rendering on
// its account. useSynthEngine is the thin React end of it.
class Engine {
  nodes = null;
  sound = null;
  starting = null; // the in-flight start, which ensure() waits on
  blockCheck = 0;
  onBlocked = () => {};
  held = new Map(); // live notes by midi: { down, started, at, velocity, token }
  pedal = false;
  bendCents = 0;
  last = null; // the last thing the synth played, as note events — what Audition replays
  lit = { subs: new Set(), events: [], sig: "", raf: 0 };

  // Audio starts on the first pointerdown or keydown anywhere on the page —
  // not on click. Safari 27 (under its default "Stop Media with Sound") grants
  // user activation at pointerdown and has withdrawn it by pointerup, so by
  // the time a click handler runs it no longer counts as a gesture: resume()
  // never settles and the context goes "interrupted". Key presses keep it
  // throughout, which is why keyboard-driven pages were unaffected. Capture
  // phase, so this runs before any handler on the way down can get in first.
  // Runs on every press, not just the first: it's how a context the browser
  // suspended between gestures gets started again.
  unlock = () => {
    if (!this.starting) {
      // the context is born here, inside the press. Tone makes one at import —
      // its deprecated top-level exports (Transport, Destination, Draw) each
      // call getContext() as the module loads — which nothing has used yet,
      // so it's disposed and replaced rather than resumed.
      Tone.setContext(new Tone.Context({ latencyHint: "interactive" }), true);
    }
    if (this.nodes && running()) return;
    // resume() is *called* here, synchronously inside the press — that's what
    // needs the gesture. The chain is built once it has actually resolved:
    // the filter LFO and the chorus's own LFOs start as they're built, and
    // starting a source on a suspended context gets Tone's "AudioContext is
    // suspended" warning — the same one that means audio is broken, so it
    // mustn't fire when audio is fine. Called again on a later press if this
    // one never resolves, which is how a blocked first attempt recovers.
    //
    // Did this press fail to start audio? Judged by what happened rather than
    // by which browser this is: a second later, the context either runs or it
    // doesn't. That catches Safari's "Never Auto-Play", and any other browser
    // or setting that refuses, and never fires when sound works.
    clearTimeout(this.blockCheck);
    this.blockCheck = setTimeout(() => {
      if (!running()) this.onBlocked(true);
    }, 1000);
    this.starting = Tone.start().then(() => {
      this.onBlocked(false); // a later press got through — say so by going away
      if (!this.nodes) {
        this.nodes = buildChain(this.sound);
        applySound(this.nodes, this.sound);
      }
    });
  };

  // Everything that plays goes through here, and none of it starts audio.
  // Before any press it answers null: the only callers that can get here
  // without a press are hover auditions, and a hover isn't a gesture, so audio
  // set up from one would be blocked and stay blocked. After a press it waits
  // on that press's start — a click handler runs moments after its own
  // pointerdown, usually before resume() has resolved. Bounded, because a
  // browser that refuses leaves resume() pending forever. Callers bail on null.
  ensure = async () => {
    if (!this.starting) return null;
    await settle(this.starting, 1500);
    return this.nodes;
  };

  apply = (sound) => {
    this.sound = sound;
    if (this.nodes) applySound(this.nodes, sound);
  };

  // --- sequenced notes: the explorer's chords ----------------------------

  // `events` from chordEvents — { midi, at, dur, velocity } — starting at `t`
  // on the audio clock. Note by note rather than one call with the whole
  // chord: per-note velocity is what keeps a block chord from being an organ.
  play = (events, t) => {
    const n = this.nodes;
    if (!n) return;
    for (const e of events) n.seq.triggerAttackRelease(noteOf(e.midi), e.dur, t + e.at, e.velocity);
    this.last = events;
    for (const e of events) this.lit.events.push({ midi: e.midi, on: t + e.at, off: t + e.at + e.dur });
    this.kick();
  };

  // Transport.stop() unschedules what hasn't played, but a note already
  // triggered rings out on its own envelope — this cuts it. The keys' pool is
  // left alone: Stop is the explorer's, and a held key is yours.
  release = () => {
    this.nodes?.seq.releaseAll();
    this.lit.events = [];
    this.kick();
  };

  // You can't design a sound you can't hear: letting go of a level replays
  // the last thing the synth played — the chord you just picked, the note you
  // just struck. Held back while the transport runs or a key is down, which
  // are already demonstrating the change as you make it.
  audition = async () => {
    if (!(await this.ensure())) return;
    if (Tone.getTransport().state === "started" || this.held.size) return;
    this.play(this.last ?? FIRST_AUDITION, Tone.now());
  };

  // --- live notes: the keyboard and MIDI in ------------------------------
  // At the audio clock's *current* time, not Tone.now(): that adds the
  // scheduling look-ahead, 100ms, which is fine for a sequence and far too
  // late for a key under your finger.

  noteOn = (midi, velocity = 0.8) => {
    const prev = this.held.get(midi);
    const note = { down: true, started: false, at: 0, velocity, pressed: performance.now(), heldFor: null };
    this.held.set(midi, note);
    this.kick();
    const start = (n) => {
      if (!n) return;
      const t = Tone.immediate();
      // Let go before audio came up. A first click on a cold page is usually
      // quicker than the audio starting — and it should still make a sound,
      // or the first thing the keyboard teaches you is that it's broken.
      if (note.heldFor != null) {
        const dur = Math.max(0.2, note.heldFor);
        n.keys.triggerAttackRelease(noteOf(midi), dur, t, velocity);
        this.last = [{ midi, at: 0, dur, velocity }];
        return;
      }
      if (this.held.get(midi) !== note) return; // struck again since
      // struck again while the pedal held it: one voice for the note, not two
      if (prev?.started) n.keys.triggerRelease(noteOf(midi), t);
      n.keys.triggerAttack(noteOf(midi), t, velocity);
      note.started = true;
      note.at = t;
    };
    if (this.nodes && running()) start(this.nodes);
    else this.ensure().then(start);
  };

  noteOff = (midi) => {
    const note = this.held.get(midi);
    if (!note) return;
    if (this.pedal) {
      note.down = false; // the pedal holds it until it comes up
      return;
    }
    this.held.delete(midi);
    this.stop(midi, note);
  };

  stop(midi, note) {
    // not sounding yet: noteOn's start plays it, as long as it was held
    if (!note.started) note.heldFor = (performance.now() - note.pressed) / 1000;
    else if (this.nodes) {
      const t = Tone.immediate();
      this.nodes.keys.triggerRelease(noteOf(midi), t);
      // remembered for Audition as the note it was, held about as long
      const dur = Math.min(2, Math.max(0.3, t - note.at));
      this.last = [{ midi, at: 0, dur, velocity: note.velocity }];
    }
    this.kick();
  }

  setPedal = (down) => {
    this.pedal = down;
    if (down) return;
    for (const [midi, note] of this.held) {
      if (note.down) continue;
      this.held.delete(midi);
      this.stop(midi, note);
    }
  };

  // pitch bend, in semitones, across both pools — it's one instrument
  bend = (semitones) => {
    const cents = Math.round(semitones * 100);
    if (cents === this.bendCents) return;
    this.bendCents = cents;
    this.nodes?.seq.set({ detune: cents });
    this.nodes?.keys.set({ detune: cents });
  };

  allNotesOff = () => {
    this.pedal = false;
    this.held.clear();
    this.nodes?.keys.releaseAll();
    this.kick();
  };

  // --- what's sounding, for the keyboard's lights -------------------------
  // A note is lit while it's held (a key, a MIDI key, the pedal) or while a
  // sequenced note is between its start and its end. Worked out on animation
  // frames against the audio clock, only while something is scheduled, and
  // passed on only when the set has changed.
  subscribe = (fn) => {
    this.lit.subs.add(fn);
    this.lit.sig = ""; // so the newcomer hears the current state
    this.kick();
    return () => this.lit.subs.delete(fn);
  };

  kick() {
    if (!this.lit.raf && typeof requestAnimationFrame === "function") {
      this.lit.raf = requestAnimationFrame(this.pump);
    }
  }

  pump = () => {
    const L = this.lit;
    L.raf = 0;
    const now = this.nodes ? Tone.immediate() : 0;
    L.events = L.events.filter((e) => e.off > now);
    const on = new Set(this.held.keys());
    for (const e of L.events) if (e.on <= now) on.add(e.midi);
    const sig = [...on].sort((a, b) => a - b).join();
    if (sig !== L.sig) {
      L.sig = sig;
      L.subs.forEach((fn) => fn(on));
    }
    if (L.events.length) this.kick();
  };

  // --- the display's taps -------------------------------------------------
  // Fills `buf` (see SCOPE_SIZE) with the latest audio either side of the
  // filter, and says where the filter is: the newest sounding voice's
  // envelope (0–1) and the LFO (−1 to 1), which cutoffAt turns into Hz, and
  // the lowest note sounding, which sets how much time a frame shows.
  readScope = (buf) => {
    const n = this.nodes;
    if (!n || !running()) return null;
    n.taps.dry.getFloatTimeDomainData(buf.dry);
    n.taps.wet.getFloatTimeDomainData(buf.wet);
    n.taps.dry.getFloatFrequencyData(buf.drySpec);
    n.taps.wet.getFloatFrequencyData(buf.wetSpec);
    n.taps.lfo.getFloatTimeDomainData(buf.lfo);
    const now = Tone.immediate();
    let lowest = Infinity;
    let newest = null;
    for (const v of n.bus.voices) {
      if (v.getLevelAtTime(now) < 1e-3) continue;
      lowest = Math.min(lowest, v.frequency.getValueAtTime(now));
      if (v.struck <= now && (!newest || v.struck > newest.struck)) newest = v;
    }
    return {
      env: newest ? newest.filterEnvelope.getValueAtTime(now) : 0,
      lfo: buf.lfo[buf.lfo.length - 1] || 0,
      lowestHz: Number.isFinite(lowest) ? lowest : 0,
      sampleRate: Tone.getContext().sampleRate,
    };
  };
}

// Buffers for readScope, sized to the taps
export const scopeBuffers = () => ({
  dry: new Float32Array(SCOPE_SIZE),
  wet: new Float32Array(SCOPE_SIZE),
  drySpec: new Float32Array(SCOPE_SIZE / 2),
  wetSpec: new Float32Array(SCOPE_SIZE / 2),
  lfo: new Float32Array(LFO_TAP),
});

// The engine for the page, plus whether the browser is refusing to make
// sound (see unlock). The engine is the same object for the life of the page.
export function useSynthEngine(sound) {
  const [engine] = useState(() => new Engine());
  const [blocked, setBlocked] = useState(false);
  // read inside unlock(), which runs outside React: the chain has to come up
  // with the settings in force at the first press, not the ones from mount
  engine.sound = sound;

  useEffect(() => {
    engine.onBlocked = setBlocked;
    window.addEventListener("pointerdown", engine.unlock, true);
    window.addEventListener("keydown", engine.unlock, true);
    return () => {
      window.removeEventListener("pointerdown", engine.unlock, true);
      window.removeEventListener("keydown", engine.unlock, true);
      clearTimeout(engine.blockCheck);
    };
  }, [engine]);

  // a level moved: retune what's playing rather than waiting for the next note
  useEffect(() => engine.apply(sound), [engine, sound]);

  return [engine, blocked];
}
