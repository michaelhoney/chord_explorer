import React, { useState, useMemo, useRef, useCallback, useEffect, useLayoutEffect } from "react";
import * as Tone from "tone";
import {
  nameOf,
  mod12,
  hueOf,
  chordNoteNames,
  rootPositionMidi,
  voiceLeadMidi,
  applyInversion,
  computeVoicings,
  midiToNotes,
  voicingDistance,
  voiceSteps,
  optionDistance,
  bassNote,
  bassLine,
  bassNameOf,
  resolveKey,
  suspensionsFor,
  suggestLoop,
  mutateLoop,
  decorateChain,
  optionsFrom,
} from "./harmony.js";
import {
  SYNTH_PARAMS,
  SYNTH_GROUPS,
  PRESETS,
  defaultSound,
  presetNameFor,
  paramToPos,
  paramFromPos,
  formatParam,
  packSynth,
  unpackSynth,
  isDefaultSound,
  oscType,
  lfoRange,
  chordEvents,
} from "./synth.js";

/* ------------------------------------------------------------------ *
 *  CHORD PATHS — a functional-harmony explorer
 *  Pick a chord, hear it, and see where it can go next — with every
 *  move tagged by what it *does* (root motion + harmonic function).
 *  Colour encodes function: home / build / tension / outside.
 * ------------------------------------------------------------------ */

// ------------------------------------------------------------------------
//  AUDIO
// ------------------------------------------------------------------------
// The signal chain the Sound panel drives:
//
//   PolySynth → Filter → Distortion → Chorus → Reverb → out
//                 ↑
//                LFO
//
// Everything after the synth is built once and left in place, wet at zero
// where that means "off" — rebuilding the chain when a slider moves would
// cut the sound you're trying to listen to. `applySound` retunes the nodes
// that already exist, which is the whole point of a knob.
function applySound(n, s) {
  n.synth.set({
    oscillator:
      s.spread > 0
        ? { type: oscType(s.wave, s.spread), count: 3, spread: s.spread }
        : { type: oscType(s.wave, 0) },
    envelope: {
      attack: s.attack, decay: s.decay, sustain: s.sustain, release: s.release,
    },
  });
  n.filter.Q.value = s.resonance;
  // the LFO owns the cutoff outright — see lfoRange
  const { min, max } = lfoRange(s.cutoff, s.lfoDepth);
  n.lfo.min = min;
  n.lfo.max = max;
  n.lfo.frequency.value = s.lfoRate;
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

// a promise that always settles, and never rejects: its own value, or
// `fallback` if it fails or is still pending after `ms` — for the audio calls
// Safari can leave pending forever
const settle = (p, ms, fallback) =>
  Promise.race([
    Promise.resolve(p).catch(() => fallback),
    new Promise((r) => setTimeout(() => r(fallback), ms)),
  ]);

// the chain itself
function buildChain(s) {
  const synth = new Tone.PolySynth(Tone.Synth);
  synth.volume.value = -11; // headroom: drive and resonance both add level
  const filter = new Tone.Filter({ type: "lowpass", rolloff: -24 });
  const lfo = new Tone.LFO({ frequency: s.lfoRate, min: s.cutoff, max: s.cutoff });
  lfo.connect(filter.frequency);
  lfo.start();
  const drive = new Tone.Distortion({ distortion: 0.3, wet: 0 });
  const chorus = new Tone.Chorus({ frequency: 1.1, delayTime: 3.5, depth: 0.7, wet: 0 }).start();
  const reverb = new Tone.Reverb({ decay: s.size, preDelay: 0.02, wet: 0 });
  synth.chain(filter, drive, chorus, reverb, Tone.getDestination());
  return { synth, filter, lfo, drive, chorus, reverb, size: s.size };
}

function useSynth(sound) {
  const ref = useRef(null);
  // read inside unlock(), which is built once: the chain has to come up with
  // the settings in force at the first press, not the ones from mount
  const live = useRef(sound);
  live.current = sound;

  // Audio starts on the first pointerdown or keydown anywhere on the page —
  // not on click. Safari 27 (under its default "Stop Media with Sound") grants
  // user activation at pointerdown and has withdrawn it by pointerup, so by
  // the time a click handler runs it no longer counts as a gesture: resume()
  // never settles and the context goes "interrupted". Key presses keep it
  // throughout, which is why keyboard-driven pages were unaffected. Capture
  // phase, so this runs before any handler on the way down can get in first.
  // Runs on every press, not just the first: it's how a context the browser
  // suspended between gestures gets started again.
  const starting = useRef(null); // the in-flight start, which ensure() waits on
  // Did the last press fail to start audio? Judged by what happened rather than
  // by which browser this is: a second after a press asked for it, the context
  // either runs or it doesn't. That catches Safari's "Never Auto-Play", and any
  // other browser or setting that refuses, and never fires when sound works.
  const [blocked, setBlocked] = useState(false);
  const blockCheck = useRef(null);
  const unlock = useCallback(() => {
    if (!starting.current) {
      // the context is born here, inside the press. Tone makes one at import —
      // its deprecated top-level exports (Transport, Destination, Draw) each
      // call getContext() as the module loads — which nothing has used yet,
      // so it's disposed and replaced rather than resumed.
      Tone.setContext(new Tone.Context({ latencyHint: "interactive" }), true);
    }
    if (ref.current && Tone.getContext().state === "running") return;
    // resume() is *called* here, synchronously inside the press — that's what
    // needs the gesture. The chain is built once it has actually resolved:
    // the filter LFO and the chorus's own LFOs start as they're built, and
    // starting a source on a suspended context gets Tone's "AudioContext is
    // suspended" warning — the same one that means audio is broken, so it
    // mustn't fire when audio is fine. Called again on a later press if this
    // one never resolves, which is how a blocked first attempt recovers.
    clearTimeout(blockCheck.current);
    blockCheck.current = setTimeout(() => {
      if (Tone.getContext().state !== "running") setBlocked(true);
    }, 1000);
    starting.current = Tone.start().then(() => {
      setBlocked(false); // a later press got through — say so by going away
      if (!ref.current) {
        ref.current = buildChain(live.current);
        applySound(ref.current, live.current);
      }
    });
  }, []);

  useEffect(() => {
    window.addEventListener("pointerdown", unlock, true);
    window.addEventListener("keydown", unlock, true);
    return () => {
      window.removeEventListener("pointerdown", unlock, true);
      window.removeEventListener("keydown", unlock, true);
    };
  }, [unlock]);

  // Everything that plays goes through here, and none of it starts audio.
  // Before any press it answers null: the only callers that can get here
  // without a press are hover auditions, and a hover isn't a gesture, so audio
  // set up from one would be blocked and stay blocked. After a press it waits
  // on that press's start — a click handler runs moments after its own
  // pointerdown, usually before resume() has resolved. Bounded, because a
  // browser that refuses leaves resume() pending forever.
  const ensure = useCallback(async () => {
    if (!starting.current) return null;
    await settle(starting.current, 1500);
    return ref.current?.synth ?? null;
  }, []);

  // a slider moved: retune what's playing rather than waiting for the next note
  useEffect(() => {
    if (ref.current) applySound(ref.current, sound);
  }, [sound]);

  // Transport.stop() unschedules what hasn't played, but a note already
  // triggered rings out on its own envelope — this cuts it
  const release = useCallback(() => ref.current?.synth.releaseAll(), []);
  useEffect(() => () => clearTimeout(blockCheck.current), []);
  return { ensure, release, blocked };
}

// ------------------------------------------------------------------------
//  MIDI OUT
// ------------------------------------------------------------------------
// Web MIDI is Chrome 43+ / Firefox 108+ only — Safari has never shipped it on
// macOS or iOS, and every iOS browser is WebKit underneath — and it needs a
// secure context (localhost counts). Both are detected up front and reported in
// the UI, rather than leaving a control that silently does nothing.
const MIDI_SUPPORTED = typeof navigator?.requestMIDIAccess === "function";
const CH = 0; // channel 1

function useMidiOut() {
  const [status, setStatus] = useState(() =>
    !MIDI_SUPPORTED ? "unsupported" : !window.isSecureContext ? "insecure" : "idle"
  );
  const [outputs, setOutputs] = useState([]);
  const [portId, setPortId] = useState("");
  const access = useRef(null);

  const enable = useCallback(async () => {
    if (!MIDI_SUPPORTED || !window.isSecureContext) return;
    setStatus("asking");
    try {
      // no sysex: notes don't need it, and asking for it prompts harder
      const a = await navigator.requestMIDIAccess();
      const read = () => [...a.outputs.values()].map((o) => ({ id: o.id, name: o.name }));
      const list = () => setOutputs(read());
      access.current = a;
      const found = read();
      setOutputs(found);
      // you didn't grant MIDI access to keep listening to the built-in synth:
      // land on a real port straight away. Only here, not on later statechanges —
      // a device appearing mid-session shouldn't reroute you without asking.
      if (found.length) setPortId(found[0].id);
      a.onstatechange = list; // ports appearing and going away
      setStatus("ready");
    } catch {
      setStatus("denied");
    }
  }, []);

  const port = access.current?.outputs.get(portId) || null;

  const send = useCallback(
    (events, at) => {
      if (!port) return;
      // Tone schedules on the audio clock; output.send wants a performance.now()
      // stamp, so rebase one onto the other. Both are ms-stable, which is all
      // chord playback needs.
      const t0 = performance.now() + (at - Tone.getContext().currentTime) * 1000;
      // the same events the built-in synth plays (see playVoiced) — so the
      // arpeggio, Dynamics and Humanise all travel out the port. Everything
      // else in the Sound panel is timbre, which belongs to whatever instrument
      // is on the other end.
      for (const e of events) {
        const vel = Math.max(1, Math.round(e.velocity * 127));
        port.send([0x90 | CH, e.midi, vel], t0 + e.at * 1000);
        port.send([0x80 | CH, e.midi, 0], t0 + (e.at + e.dur) * 1000);
      }
    },
    [port]
  );

  // hardware holds a note until told otherwise, so Stop has to be emphatic
  const panic = useCallback(() => {
    if (!port) return;
    port.clear?.(); // drop note-offs still queued, or they arrive after the reset
    port.send([0xb0 | CH, 123, 0]); // all notes off
  }, [port]);

  return { status, outputs, portId, setPortId, enable, send, panic, active: !!port };
}

// ------------------------------------------------------------------------
//  UI
// ------------------------------------------------------------------------
const HUE = {
  home: "var(--home)",
  build: "var(--build)",
  tension: "var(--tension)",
  outside: "var(--outside)",
};

// what the Output control says before a port can be picked
const MIDI_STATUS = {
  unsupported: {
    label: "No Web MIDI",
    dead: true,
    hint: "This browser has no Web MIDI. Safari has never shipped it, on macOS or iOS — Chrome or Firefox will work.",
  },
  insecure: {
    label: "No Web MIDI",
    dead: true,
    hint: "Web MIDI needs a secure context — serve the page over HTTPS, or from localhost.",
  },
  idle: { label: "Enable MIDI", dead: false, hint: "Look for connected MIDI instruments" },
  asking: { label: "Asking…", dead: true, hint: "Waiting on the browser's MIDI permission prompt" },
  denied: {
    label: "MIDI blocked",
    dead: false,
    hint: "The browser denied MIDI access. Allow it for this site, then click to retry.",
  },
};

// choreography timings — the futures clear out, then the new column assembles
const EXIT_MS = 170;
const SPAWN_MS = 340;

// stable identity for an option row (roman alone collides: minor has V and V7)
// A progression realised as what sounds: upper voices plus the bass voice, if on.
// The component memoises this for the current progression; playback also needs
// it for the one queued behind it, so it can swap the two on the beat.
function realise(prog, voiceLead, bassOn) {
  const v = computeVoicings(prog, voiceLead);
  const b = bassOn ? bassLine(prog) : null;
  return v.map((upper, i) => ({ upper, bass: b ? b[i] : null }));
}

// History: Suggest, Mutate and Evolve each add a generation; hand edits change
// the current one in place. An empty current generation is a blank page rather
// than history, so it's written over instead of kept.
const MAX_GENS = 24;

// Mutate's levels: that many quarters of the bars. Only "all" touches bar 1
const MUT_LEVELS = [
  ["1/4", "about a quarter of the bars"],
  ["1/2", "about half the bars"],
  ["3/4", "about three quarters of the bars"],
  ["all", "every bar, the first one too"],
];
function pushGen(h, prog) {
  if (!h.gens[h.cur].length) {
    const gens = [...h.gens];
    gens[h.cur] = prog;
    return { gens, cur: h.cur };
  }
  const gens = [...h.gens, prog].slice(-MAX_GENS);
  return { gens, cur: gens.length - 1 };
}

// a seeded PRNG (mulberry32): a queued mutation is re-derived from the current
// progression on every render until it lands, so edits made while it waits are
// carried into it — and the seed keeps it the same mutation throughout
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const newSeed = () => Math.floor(Math.random() * 2 ** 31);

const optKey = (o) => `${o.roman}:${o.rootPc}:${o.intervals.join("-")}`;

// --- filtering the futures ---
// Fold the display spellings down to what someone would actually type: "bvii"
// finds ♭VII, "bdim" finds B°, "f#" finds F♯. Matching runs over the chord name
// and the roman, which is how you'd name the chord you're hunting for.
const normQuery = (s) =>
  s
    .toLowerCase()
    .replace(/[♭b]/g, "b")
    .replace(/[♯#]/g, "#")
    .replace(/°/g, "dim")
    .replace(/\s+/g, "");
const matchesQuery = (o, q) =>
  normQuery(o.name).includes(q) || normQuery(o.roman).includes(q);

// --- shareable state via querystring ---
// A chord is identified by root + intervals; the reader rebuilds the key's chord
// pool and looks each one up, so links carry no derived data (voicings stay derived).
const chordToken = (c) => {
  const base = `${c.rootPc}.${c.intervals.join("-")}`;
  return c.inv ? `${base}~${c.inv}` : base; // trailing ~N carries the inversion shift
};

function encodeState(s) {
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
  if (s.loop) p.set("lp", "1");
  if (s.evolve) p.set("ev", "1");
  if (s.mutLevel !== 1) p.set("ml", s.mutLevel); // shapes what Evolve does, so it travels
  if (s.susOn) p.set("su", "1");
  if (s.tempo !== 96) p.set("t", s.tempo);
  // the sound travels with the link — a progression you designed a patch for
  // should arrive sounding like it. Only when it isn't the default, though:
  // no reason to hang 16 numbers off every share.
  if (!isDefaultSound(s.sound)) p.set("sy", packSynth(s.sound));
  if (s.prog.length) p.set("p", s.prog.map(chordToken).join("_"));
  return p.toString();
}

// replaceState can throw — Safari rate-limits it — and a URL that falls behind
// is not worth a crash
function writeUrl(path) {
  try {
    window.history.replaceState(null, "", path);
  } catch {
    // leave the address bar where it was; the next write will catch it up
  }
}

// A naked URL — no query string at all — opens somewhere rather than on an empty
// page: a random key, major or minor, with a 4-bar suggestion on the roll, ready
// for Play. Waiting rather than playing, since audio can't start before a press.
// A link with any state in it opens exactly as written (see decodeState).
function randomStart() {
  const root = Math.floor(Math.random() * 12);
  const mode = Math.random() < 0.5 ? "major" : "minor";
  const prog = suggestLoop(resolveKey(root, mode, false), { bars: 4 }).map((c, i) => ({ ...c, id: i + 1 }));
  return { root, mode, prog };
}

function decodeState(search) {
  const p = new URLSearchParams(search);
  if (![...p.keys()].length) return null;
  const clampNum = (v, def, lo, hi) => {
    if (v == null || v === "") return def; // absent param → default (Number(null) is 0!)
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : def;
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
  const loop = p.get("lp") === "1";
  const evolve = p.get("ev") === "1";
  const mutLevel = clampNum(p.get("ml"), 1, 1, 4);
  const susOn = p.get("su") === "1";
  const tempo = clampNum(p.get("t"), 96, 60, 140);
  const sound = unpackSynth(p.get("sy")); // clamps per parameter; absent → default
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
  return { root, mode, add7, voiceLead, bass, arp, arpFour, arpOrder, holdBass, loop, evolve, mutLevel, susOn, tempo, sound, prog: chain };
}

export default function ChordExplorer() {
  const boot = useMemo(() => decodeState(window.location.search) || randomStart(), []);
  const [root, setRoot] = useState(boot.root ?? 0);
  const [mode, setMode] = useState(boot.mode ?? "major");
  const [add7, setAdd7] = useState(boot.add7 ?? false);
  const [voiceLead, setVoiceLead] = useState(boot.voiceLead ?? true);
  const [bassOn, setBassOn] = useState(boot.bass ?? false);
  const [arp, setArp] = useState(boot.arp ?? false);
  const [arpFour, setArpFour] = useState(boot.arpFour ?? false);
  const [arpOrder, setArpOrder] = useState(boot.arpOrder ?? "rise");
  const [holdBass, setHoldBass] = useState(boot.holdBass ?? false);
  const [loop, setLoop] = useState(boot.loop ?? false);
  const [evolve, setEvolve] = useState(boot.evolve ?? false);
  // how much Mutate (and so Evolve) changes: that many quarters of the bars
  const [mutLevel, setMutLevel] = useState(boot.mutLevel ?? 1);
  const [susOn, setSusOn] = useState(boot.susOn ?? false);
  const [tempo, setTempo] = useState(boot.tempo ?? 96);
  const [sound, setSound] = useState(boot.sound ?? defaultSound());
  // the colour every light on the face burns, a new one each visit
  const [lamp, setLamp] = useState(() => LAMPS[Math.floor(Math.random() * LAMPS.length)]);
  // Progressions come in generations (see pushGen); `cur` is the one on the
  // roll. Per visit, not in the URL — a link carries only the current one.
  const [hist, setHist] = useState(() => ({ gens: [boot.prog ?? []], cur: 0 }));
  const prog = hist.gens[hist.cur];
  // hand edits: change the current generation in place
  const setProg = useCallback(
    (u) =>
      setHist((h) => {
        const p = h.gens[h.cur];
        const next = typeof u === "function" ? u(p) : u;
        if (next === p) return h;
        const gens = [...h.gens];
        gens[h.cur] = next;
        return { ...h, gens };
      }),
    []
  );
  const [playingIdx, setPlayingIdx] = useState(-1);
  const [playing, setPlaying] = useState(false);
  // the notes sounding right now in the playing column, by midi — each lit from
  // its own onset to its own release, so an arpeggio walks up the pills and a
  // held bass stays lit under it. Midi alone is enough to name a pill: the bass
  // lane (D2–F3) sits below anything the upper voices reach.
  const [lit, setLit] = useState(() => new Set());
  const light = useCallback((m, on) => {
    setLit((s) => {
      if (s.has(m) === on) return s;
      const n = new Set(s);
      if (on) n.add(m);
      else n.delete(m);
      return n;
    });
  }, []);
  const playingRef = useRef(false); // read inside scheduled callbacks and effects
  const loopRef = useRef(false);
  const [query, setQuery] = useState("");
  const [tensionDesc, setTensionDesc] = useState(false); // least tense first
  // in a ref as well as state so playVoiced doesn't take a new identity on
  // every frame of a slider drag — it only ever reads the current value
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const { ensure, release, blocked } = useSynth(sound);
  // dismissing is for this visit; not in the URL — it's about this browser
  const [noSoundDismissed, setNoSoundDismissed] = useState(false);
  const midi = useMidiOut();
  const { send: midiSend, panic: midiPanic, active: midiActive } = midi;
  const uid = useRef(boot.prog?.length ?? 0);

  // choosing is a short piece of choreography: the futures fade, the chosen one
  // flies left into the roll and bursts into note pills, then the next futures
  // assemble. `exiting` names the chord mid-flight; `spawn` tells the roll which
  // column just landed and where its pills should fly in from.
  const [exiting, setExiting] = useState(null);
  const [spawn, setSpawn] = useState(null);
  const colsRef = useRef(null);
  const rollRef = useRef(null);
  const futuresRef = useRef(null);
  const flight = useRef(null); // the chosen row's position, relative to the list
  const timers = useRef([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  // when add7 is on, restack diatonic chords with sevenths; always carry the
  // suspension palette (shown only when the Sus toggle is on)
  const key = useMemo(() => {
    const k = resolveKey(root, mode, add7);
    return { ...k, suspensions: suspensionsFor(k) };
  }, [root, mode, add7]);

  // Where this state lives, so any of it is bookmarkable and shareable. Worked
  // out every render, and it's what Share copies — so a share never lags the
  // page, however recently something changed.
  const path = useMemo(() => {
    const qs = encodeState({ root, mode, add7, voiceLead, bass: bassOn, arp, arpFour, arpOrder, holdBass, loop, evolve, mutLevel, susOn, tempo, sound, prog });
    return qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  }, [root, mode, add7, voiceLead, bassOn, arp, arpFour, arpOrder, holdBass, loop, evolve, mutLevel, susOn, tempo, sound, prog]);

  // Written to the address bar behind a short debounce, not on every change. A
  // slider drag changes state every frame, and Safari allows 100 replaceState
  // calls per 10 seconds — then *throws*, from inside an effect, which unmounts
  // the whole app to a white page. (Chrome throttles instead, with a warning.)
  // Trailing edge, so the bar lands where the drag stopped; flushed on pagehide
  // so a reload straight after a change keeps it. And guarded regardless: the
  // address bar falling behind is cosmetic, and must never take the app down.
  const pathRef = useRef(path);
  pathRef.current = path;
  useEffect(() => {
    const id = setTimeout(() => writeUrl(pathRef.current), 300);
    return () => clearTimeout(id);
  }, [path]);
  useEffect(() => {
    const flush = () => writeUrl(pathRef.current);
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, []);

  const current = prog.length ? prog[prog.length - 1] : null;
  const { inKey, colour, sus } = useMemo(() => optionsFrom(current, key), [current, key]);

  // every possible next chord as one flat list, ordered by tension. Sort is stable,
  // so within a tension band the engine's own ranking still shows through — in
  // either direction. Ascending is the default: the resolutions sit up top, which
  // is what you reach for most. Flip it to open on the outside chords instead.
  const futures = useMemo(
    () =>
      [...inKey, ...colour, ...(susOn ? sus : [])].sort((a, b) =>
        tensionDesc ? b.tension - a.tension : a.tension - b.tension
      ),
    [inKey, colour, sus, susOn, tensionDesc]
  );

  // the futures list is the whole vocabulary now, so it needs a way in
  const q = normQuery(query.trim());
  const shown = useMemo(
    () => (q ? futures.filter((o) => matchesQuery(o, q)) : futures),
    [futures, q]
  );

  // chords a toggle is currently hiding. Without this a search for "Fsus4" with
  // Sus off just fails, and the reason is a control on the other side of the page.
  const hiddenBy = useMemo(() => {
    if (!q) return [];
    const groups = [];
    if (!susOn) groups.push({ label: "Sus", turnOn: () => setSusOn(true), opts: sus });
    if (!add7) {
      // 7ths restacks the diatonic chords rather than adding to them — the extras
      // are the ones whose name isn't already on offer as a triad
      const here = new Set(futures.map((o) => o.name));
      const alt = optionsFrom(current, resolveKey(root, mode, true)).inKey;
      groups.push({
        label: "7ths",
        turnOn: () => setAdd7(true),
        opts: alt.filter((o) => !here.has(o.name)),
      });
    }
    return groups
      .map((g) => ({ ...g, hits: g.opts.filter((o) => matchesQuery(o, q)) }))
      .filter((g) => g.hits.length);
  }, [q, futures, sus, susOn, add7, root, mode, current]);

  // midi voicings for the whole progression, chained when voice-leading is on
  const voicings = useMemo(() => computeVoicings(prog, voiceLead), [prog, voiceLead]);

  // total voice movement across the whole progression — lower is smoother
  const totalMotion = useMemo(() => {
    let d = 0;
    for (let i = 1; i < voicings.length; i++) d += voicingDistance(voicings[i - 1], voicings[i]);
    return d;
  }, [voicings]);

  // the current chord's realised voicing — the "from" point for chooser distances
  const fromMidi = voicings.length ? voicings[voicings.length - 1] : null;

  // The bass voice, when it's on. Separate from `voicings` on purpose (see
  // bassLine): voicings stay the upper voices, which is what voice leading chains
  // from and what every Δ measures. What gets *played* is `{ upper, bass }` —
  // the bass named rather than folded in as the lowest note, because it isn't
  // always the lowest (an inversion can roll an upper voice below it), and
  // "hold bass" needs to know which note it is.
  const bass = useMemo(() => (bassOn ? bassLine(prog) : null), [bassOn, prog]);
  const played = useMemo(
    () => voicings.map((v, i) => ({ upper: v, bass: bass ? bass[i] : null })),
    [bass, voicings]
  );
  // What plays when the loop next comes round, instead of this: a mutation, a
  // suggestion, or a generation picked from the history. A mutation is derived
  // from the current progression right up until it lands (same seed, so the
  // same mutation), which is what carries edits made while it waits into it.
  const [queued, setQueued] = useState(null);
  const nextProg = useMemo(() => {
    if (!queued) return null;
    if (queued.kind === "mutate") {
      // the generation before this one, so a mutation doesn't just undo the last
      const previous = hist.cur > 0 ? hist.gens[hist.cur - 1] : null;
      // the level read live too, so changing it while a mutation waits applies
      return mutateLoop(prog, key, { rand: seededRandom(queued.seed), level: mutLevel, previous });
    }
    if (queued.kind === "suggest") return queued.prog;
    return hist.gens[queued.idx] ?? null;
  }, [queued, prog, key, hist.gens, hist.cur, mutLevel]);
  const nextPlayed = useMemo(
    () => (nextProg ? realise(nextProg, voiceLead, bassOn) : null),
    [nextProg, voiceLead, bassOn]
  );
  // what the playback tick reads: assigned during render, so it is never a
  // passive effect behind the state (the tick swaps it itself on arrival)
  const liveRef = useRef(null);
  liveRef.current = {
    played,
    next: nextProg && nextProg.length ? { queued, prog: nextProg, played: nextPlayed } : null,
  };

  // make a queued progression the current one: a history pick just moves the
  // cursor; anything new becomes a generation, fresh chords getting ids
  const land = useCallback((q, p) => {
    if (q.kind === "goto") return setHist((h) => ({ ...h, cur: q.idx }));
    const withIds = p.map((c) => (c.id != null ? c : { ...c, id: ++uid.current }));
    setHist((h) => pushGen(h, withIds));
  }, []);

  // a chord about to be added (preview, choose) gets the bass it would have
  const withBass = useCallback(
    (midi, rootPc) => ({
      upper: midi,
      bass: bassOn ? bassNote(rootPc, bass && bass.length ? bass[bass.length - 1] : null) : null,
    }),
    [bassOn, bass]
  );

  const playVoiced = useCallback(
    // `chord` is `{ upper, bass }` (bass null when the bass voice is off). `span`
    // is the time an arpeggio spreads over: the chord's whole slot during
    // playback, so the last step runs straight into the next chord. Defaults to
    // `dur` for one-off plays. `onLight(midi, on)`, if given, is called on the
    // audio clock as each note starts and ends — playback uses it to light pills.
    async (chord, dur = 1.1, when, span = dur, onLight) => {
      // ensure() even when routing to MIDI: the Transport and the clock that
      // timestamps the messages both need a running audio context
      const synth = await ensure();
      if (!synth) return; // no gesture yet: a hover, before any click
      const t = when ?? Tone.now();
      // one list of note events for the synth and the MIDI port alike — block
      // chord or arpeggio, bass held or in the arp, velocity and humanise all
      // decided in one pure function (see chordEvents)
      const events = chordEvents(chord.upper, chord.bass, {
        arp, four: arpFour, order: arpOrder, holdBass, dur, span, sound: soundRef.current,
      });
      if (onLight) {
        // from the same events that sound, so the lights can't drift from the notes
        const draw = Tone.getDraw();
        for (const e of events) {
          draw.schedule(() => onLight(e.midi, true), t + e.at);
          draw.schedule(() => onLight(e.midi, false), t + e.at + e.dur);
        }
      }
      if (midiActive) {
        midiSend(events, t);
        return; // the port replaces the built-in synth rather than doubling it
      }
      // note by note rather than one call with the whole chord: a block chord
      // with every voice at the same velocity is the organ sound, and per-note
      // velocity is the difference
      for (const e of events) {
        synth.triggerAttackRelease(midiToNotes([e.midi])[0], e.dur, t + e.at, e.velocity);
      }
    },
    [ensure, arp, arpFour, arpOrder, holdBass, midiActive, midiSend]
  );

  const preview = useCallback(
    (opt) => {
      // taste the chord without committing it — same voicing choose would use
      const prevMidi = voiceLead && voicings.length ? voicings[voicings.length - 1] : null;
      const midi = voiceLead ? voiceLeadMidi(prevMidi, opt) : rootPositionMidi(opt);
      playVoiced(withBass(midi, opt.rootPc), 0.8);
    },
    [voiceLead, voicings, playVoiced, withBass]
  );

  // you can't design a sound you can't hear: releasing a slider plays the chord
  // you're on, or the key's tonic if there's no progression yet. Held back while
  // playback runs, which is already demonstrating the change as you make it.
  const auditionSound = useCallback(() => {
    if (playingRef.current) return;
    const tonic = key.diatonic[0];
    playVoiced(
      played.length ? played[played.length - 1] : withBass(rootPositionMidi(tonic), tonic.rootPc),
      1.5
    );
  }, [played, key, playVoiced, withBass]);

  const choose = useCallback(
    async (opt, rowEl) => {
      if (exiting) return; // one flight at a time
      // realise the new chord from the current chain end so it matches the recompute
      const prevMidi = voiceLead && voicings.length ? voicings[voicings.length - 1] : null;
      const midi = voiceLead ? voiceLeadMidi(prevMidi, opt) : rootPositionMidi(opt);
      const idx = prog.length;
      // remember where the row sat *within the list* — adding a column reflows the
      // stage, so an absolute rect taken now would be stale by the time it lands
      const list = futuresRef.current;
      if (rowEl && list) {
        const r = rowEl.getBoundingClientRect();
        const f = list.getBoundingClientRect();
        flight.current = { x: r.left - f.left + 12, y: r.top + r.height / 2 - f.top };
      } else {
        flight.current = null;
      }
      setExiting(optKey(opt));
      playVoiced(withBass(midi, opt.rootPc)); // sound lands on the click, not after the animation
      timers.current.push(
        setTimeout(() => {
          setProg((p) => [...p, { ...opt, id: ++uid.current }]);
          // clear the search only once the chord lands — clearing on click would
          // repopulate the list mid-exit and undo the fade
          setQuery("");
          setSpawn({ idx });
          setExiting(null);
        }, EXIT_MS)
      );
      timers.current.push(setTimeout(() => setSpawn(null), EXIT_MS + SPAWN_MS + 400));
    },
    [exiting, voiceLead, voicings, playVoiced, prog.length, withBass, setProg]
  );

  const gensRef = useRef(null);
  useEffect(() => {
    const el = gensRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [hist.gens.length, nextProg]);

  // keep the newest column parked against the futures list as the roll grows
  useEffect(() => {
    const el = rollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [prog.length]);

  // FLIP: once the new column is laid out, measure each pill's landing spot and
  // hand it the vector back to the row it came from. The CSS keyframe plays it
  // in reverse, so the pills look like they were flung out of the chosen future.
  useLayoutEffect(() => {
    if (!spawn) return;
    const roll = rollRef.current;
    if (roll) roll.scrollLeft = roll.scrollWidth; // park before measuring
    const col = colsRef.current?.children[spawn.idx];
    const list = futuresRef.current;
    if (!col || !list || !flight.current) return;
    const f = list.getBoundingClientRect();
    const ox = f.left + flight.current.x;
    const oy = f.top + flight.current.y;
    col.querySelectorAll(".ce-roll-note").forEach((pill) => {
      const r = pill.getBoundingClientRect();
      pill.style.setProperty("--dx", `${ox - (r.left + r.width / 2)}px`);
      pill.style.setProperty("--dy", `${oy - (r.top + r.height / 2)}px`);
    });
  }, [spawn]);

  // Playback runs on Tone's Transport as one repeating tick per chord slot, and
  // each tick reads the progression *live* (liveRef) at a cursor. So an edit made
  // while it plays — an inversion, a reorder, a chord added or removed — is just
  // heard on the next slot, and the loop never breaks pace. The one place the
  // progression is swapped is the end of a cycle: a queued suggestion, mutation
  // or history pick lands there, on the beat. Transport time (beats) means the
  // tempo slider rescales a run in flight; Transport.cancel() is what makes a
  // Stop land now.
  const STEP = 2; // one chord = a half note = two beats
  const atBeat = (n) => `0:${n}:0`;
  const cursor = useRef(0);

  const stopPlayback = useCallback(() => {
    const t = Tone.getTransport();
    t.stop();
    t.cancel();
    t.position = 0;
    t.loop = false;
    release();
    midiPanic();
    playingRef.current = false;
    setPlaying(false);
    setPlayingIdx(-1);
    Tone.getDraw().cancel(); // lights queued for notes that will now never sound
    setLit(new Set());
    // something you asked for lands now rather than being lost; an Evolve
    // mutation was only ever for the next time round, so it goes
    const n = liveRef.current.next;
    if (n && !n.queued.auto) land(n.queued, n.prog);
    setQueued(null);
  }, [release, midiPanic, land]);

  const playAll = useCallback(async () => {
    if (playingRef.current) return stopPlayback(); // the button is Play/Stop
    if (!prog.length) return;
    if (!(await ensure())) return;
    const t = Tone.getTransport();
    t.cancel();
    t.loop = false;
    t.bpm.value = tempo;
    cursor.current = 0;
    t.scheduleRepeat((time) => {
      const live = liveRef.current;
      let i = cursor.current;
      if (i >= live.played.length) {
        // the end of a cycle. Loop's flag is read here, live, so turning it off
        // mid-cycle ends the run at this cycle's end
        if (!loopRef.current || !live.played.length) {
          Tone.getDraw().schedule(() => stopRef.current(), time);
          return;
        }
        if (live.next) {
          // swap now, in the callback — Tone runs it ~100ms ahead of the audio,
          // and waiting on React would play bar 1 of the old progression
          const { queued: q, prog: p, played: pl } = live.next;
          live.played = pl;
          live.next = null;
          land(q, p);
          setQueued(null);
        }
        i = 0;
      }
      // duration read at fire time, so a tempo change lands on the next chord;
      // through a ref, so a MIDI port or Arpeggio change reaches a run in flight
      const slot = Tone.Time(atBeat(STEP)).toSeconds();
      playVoicedRef.current(live.played[i], slot * 0.92, time, slot, light);
      Tone.getDraw().schedule(() => setPlayingIdx(i), time); // visuals on the audio clock
      cursor.current = i + 1;
    }, atBeat(STEP), 0);
    t.position = 0;
    playingRef.current = true;
    setPlaying(true);
    t.start();
  }, [prog.length, tempo, ensure, stopPlayback, land, light]);

  // the toggles reach into a run already in progress
  useEffect(() => { Tone.getTransport().bpm.value = tempo; }, [tempo]);
  useEffect(() => { loopRef.current = loop; }, [loop]);

  // Evolve: whenever a run is looping with nothing queued, queue a mutation for
  // next time round. It lands, the queue empties, and this queues the next one.
  useEffect(() => {
    if (evolve && loop && playing && !queued && prog.length > 1) {
      setQueued({ kind: "mutate", seed: newSeed(), auto: true });
    } else if (queued?.auto && !(evolve && loop)) {
      setQueued(null); // Evolve or Loop turned off: stay on this one
    }
  }, [evolve, loop, playing, queued, prog.length]);

  // Held in a ref so neither effect below lists stopPlayback as a dependency:
  // its identity changes with the chosen MIDI port, which would otherwise fire
  // the cleanup — i.e. silently stop playback, and panic twice — every time you
  // switched output. Switching output mid-run should just move the sound across.
  const stopRef = useRef(stopPlayback);
  const playVoicedRef = useRef(playVoiced);
  useEffect(() => {
    stopRef.current = stopPlayback;
    playVoicedRef.current = playVoiced;
  });

  // a new key empties the progression and the history with it — the one change
  // that stops a run rather than being heard on the next slot
  useEffect(() => {
    if (playingRef.current) stopRef.current();
  }, [root, mode]);
  useEffect(() => () => stopRef.current(), []); // and stop on unmount, only

  // --- reordering and removing chords -------------------------------------
  // Pointer-based rather than HTML5 drag-and-drop: the columns are a uniform
  // grid, so the target index is just arithmetic on clientX, and reordering
  // `prog` live means you watch the voice leading re-solve as you drag.
  const [dragIdx, setDragIdx] = useState(-1);
  const drag = useRef(null);
  // separate from `drag`, which is cleared on pointerup — the click that ends a
  // drag fires *after* that, and would otherwise play the chord you just moved
  const clickBlocked = useRef(false);
  const dragMoved = useCallback(() => clickBlocked.current, []);

  const moveChord = useCallback((from, to) => {
    setProg((p) => {
      if (to < 0 || to >= p.length || from === to) return p;
      const next = [...p];
      next.splice(to, 0, ...next.splice(from, 1));
      return next;
    });
  }, [setProg]);

  const removeChord = useCallback((i) => setProg((p) => p.filter((_, j) => j !== i)), [setProg]);

  const onDragStart = useCallback((i, e) => {
    if (e.button !== 0) return;
    drag.current = { idx: i, startX: e.clientX, moved: false };
    setDragIdx(i);
    // deliberately no setPointerCapture: reordering moves the captured node in
    // the DOM, which implicitly releases the capture, so it can't be relied on
    // to deliver pointerup. The window listeners below do that job instead.
  }, []);

  const onDragMove = useCallback(
    (e) => {
      const d = drag.current;
      if (!d) return;
      // pointermove also fires on a plain hover. If the button is no longer
      // down, a previous drag failed to end — close it out rather than treating
      // mouse-overs as a drag and shuffling the progression under the cursor.
      if (e.buttons === 0) return endDragRef.current();
      // a few px of slop, so a click that wobbles still plays the chord
      if (!d.moved && Math.abs(e.clientX - d.startX) < 4) return;
      d.moved = true;
      clickBlocked.current = true; // suppress the click this drag will end with
      const base = colsRef.current?.getBoundingClientRect();
      if (!base) return;
      const span = ROLL.COL + ROLL.GAP;
      const to = Math.max(0, Math.min(prog.length - 1, Math.floor((e.clientX - base.left) / span)));
      if (to !== d.idx) {
        moveChord(d.idx, to);
        d.idx = to;
        setDragIdx(to);
      }
    },
    [prog.length, moveChord]
  );

  const onDragEnd = useCallback(() => {
    setDragIdx(-1);
    const d = drag.current;
    drag.current = null;
    // the click lands in the same task as pointerup, so the flag has to outlive
    // this handler — release it on the next tick, once that click has passed
    if (d?.moved) setTimeout(() => { clickBlocked.current = false; }, 0);
    else clickBlocked.current = false;
  }, []);

  // The drag is driven from the window, not the tile: release the button over a
  // gap, over the note pills, or outside the roll entirely and the tile's own
  // pointerup never fires, leaving the drag live — after which every hover
  // reorders the progression.
  const endDragRef = useRef(onDragEnd);
  useEffect(() => { endDragRef.current = onDragEnd; });
  const dragging = dragIdx >= 0;
  useEffect(() => {
    if (!dragging) return;
    const move = (e) => onDragMove(e);
    const end = () => endDragRef.current();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", end); // released outside the window
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", end);
    };
  }, [dragging, onDragMove]);

  // drag is mouse-only, so the same moves live on the keyboard
  const onTileKey = useCallback(
    (i, e) => {
      if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        moveChord(i, i + (e.key === "ArrowLeft" ? -1 : 1));
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        removeChord(i);
      }
    },
    [moveChord, removeChord]
  );

  // walk the transition graph for a loop that comes round again
  const [bars, setBars] = useState(4);
  // While playing, Suggest and Mutate queue their result for when the loop comes
  // round rather than cutting in; pressing again re-rolls what's queued.
  const suggest = useCallback(() => {
    const p = suggestLoop(key, { bars }).map((c) => ({ ...c, id: ++uid.current }));
    setQuery("");
    if (playingRef.current) setQueued({ kind: "suggest", prog: p });
    else setHist((h) => pushGen(h, p));
  }, [key, bars]);
  const mutate = useCallback(() => {
    if (prog.length < 2) return;
    if (playingRef.current) setQueued({ kind: "mutate", seed: newSeed() });
    else land({ kind: "mutate" }, mutateLoop(prog, key, { level: mutLevel, previous: hist.gens[hist.cur - 1] }));
  }, [prog, key, land, hist, mutLevel]);
  // back (or forward) through the history — queued too, while playing; the one
  // already playing un-queues whatever was waiting
  const goto = useCallback(
    (idx) => {
      if (!playingRef.current) return setHist((h) => ({ ...h, cur: idx }));
      setQueued(idx === hist.cur ? null : { kind: "goto", idx });
    },
    [hist.cur]
  );

  const undo = () => setProg((p) => p.slice(0, -1));
  // a fresh page, keeping the old one in the history
  const clear = () => setHist((h) => pushGen(h, []));

  // inversion scrolling: nudge one chord's register by an octave at its extreme,
  // and play the result so the change is audible
  const invert = useCallback(
    (i, dir) => {
      setProg((p) =>
        p.map((c, j) => (j === i ? { ...c, inv: (c.inv || 0) + dir } : c))
      );
      if (voicings[i]) {
        const upper = applyInversion(voicings[i], dir);
        if (!bassOn) return playVoiced({ upper, bass: null }, 0.8);
        // the arrows walk the bass through the chord tones too (see bassPcOf);
        // its octave depends on the chord before, so read it off the new line
        const edited = prog.map((c, j) => (j === i ? { ...c, inv: (c.inv || 0) + dir } : c));
        playVoiced({ upper, bass: bassLine(edited)[i] }, 0.8);
      }
    },
    [voicings, bassOn, prog, playVoiced, setProg]
  );
  const changeKey = (r, m) => {
    // the key is a row of lit keys now, and pressing the lit one again
    // shouldn't wipe the progression
    if (r === root && m === mode) return;
    setRoot(r);
    setMode(m);
    setHist({ gens: [[]], cur: 0 }); // other keys' progressions would read wrong here
    setQueued(null);
    setQuery("");
  };

  const [copied, setCopied] = useState(false);
  const share = useCallback(async () => {
    // the computed URL, not location.href — the address bar trails by up to 300ms
    const href = window.location.origin + path;
    try {
      await navigator.clipboard.writeText(href);
    } catch {
      // clipboard blocked (insecure context / permissions) — select-and-copy fallback
      const el = document.createElement("textarea");
      el.value = href;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      el.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }, [path]);

  const keyName = nameOf(root, root);
  // Output is a two-key group, Int / MIDI. MIDI is the key that asks for access
  // when there isn't any yet; once granted, useMidiOut lands on the first port.
  const routeMidi = midi.portId !== "";
  const midiDead = midi.status !== "ready" && MIDI_STATUS[midi.status].dead;
  const pickOutput = (v) => {
    if (v === "int") {
      midiPanic(); // silence the port we're leaving, mid-note or not
      return midi.setPortId("");
    }
    if (midi.status !== "ready") return midi.enable();
    if (!routeMidi && midi.outputs.length) midi.setPortId(midi.outputs[0].id);
  };
  // one row of keys for what was Arpeggio plus its order: block, rising, random
  const arpMode = arp ? arpOrder : "off";
  const setArpMode = (v) => {
    setArp(v !== "off");
    if (v !== "off") setArpOrder(v);
  };
  const genNames = (p) => (p.length ? p.map((c) => c.name).join(" ") : "empty");

  return (
    <div className="ce-root" style={{ "--lamp": lamp }}>
      <style>{CSS}</style>

      {/* the colour the lights burn, a new one each visit — not in the URL,
          since it's about this visit rather than the progression */}
      <div className="ce-lamps" role="radiogroup" aria-label="Lamp colour">
        {LAMPS.map((c) => (
          <button
            key={c}
            role="radio"
            aria-checked={lamp === c}
            aria-label={`Lamp colour ${c}`}
            style={{ "--sw": c }}
            onClick={() => setLamp(c)}
          />
        ))}
      </div>

      <div className="ce-chassis">
        <header className="ce-mod ce-plate">
          <h1>chord paths</h1>
          <div className="ce-leds" aria-hidden="true">
            <span className={"ce-led" + (playing ? " on" : "")}><i />Play</span>
            <span className={"ce-led" + (loop ? " on" : "")}><i />Loop</span>
            <span className={"ce-led" + (midiActive ? " on" : "")}><i />MIDI</span>
          </div>
          <div className="ce-grille" aria-hidden="true" />
          {/* sharing is about the page, not the progression, so it's up here
              rather than in any of the modules */}
          <button
            className={"ce-share" + (copied ? " copied" : "")}
            onClick={share}
            disabled={!prog.length}
            aria-label={copied ? "Link copied" : "Copy a link to this progression"}
            title={copied ? "Link copied" : "Copy a link to this progression"}
          >
            {copied ? <Tick /> : <ShareIcon />}
          </button>
        </header>

        {/* 01–02: what chords there are, and something that picks for you */}
        <section className="ce-mod ce-m-key" aria-labelledby="ce-h-key">
          <ModHead n="01" id="ce-h-key">Key</ModHead>
          <div className="ce-stack">
            <Field label="Root">
              <RootKeys root={root} onPick={(r) => changeKey(r, mode)} />
            </Field>
            <div className="ce-row">
              <Field label="Mode">
                <Keys
                  label="Mode"
                  value={mode}
                  onChange={(m) => changeKey(root, m)}
                  options={[
                    { v: "major", label: "Maj", title: "Major" },
                    { v: "minor", label: "Min", title: "Minor — natural, with the harmonic-minor dominant as a colour chord" },
                    { v: "mixolydian", label: "Mix", title: "Mixolydian — major with a flat seventh" },
                  ]}
                />
              </Field>
              <Field label="Chords">
                <div className="ce-bg">
                  <Toggle on={add7} onClick={() => setAdd7((v) => !v)} title="Add sevenths to the diatonic chords">
                    7
                  </Toggle>
                  <Toggle
                    on={susOn}
                    onClick={() => setSusOn((v) => !v)}
                    title="Offer suspended chords (sus2 / sus4) that resolve to their triad"
                  >
                    Sus
                  </Toggle>
                </div>
              </Field>
            </div>
          </div>
        </section>

        <section className="ce-mod ce-m-gen" aria-labelledby="ce-h-gen">
          <ModHead n="02" id="ce-h-gen">Generate</ModHead>
          <div className="ce-stack">
            <div className="ce-row">
              <Field label="Suggest">
                <button
                  className="ce-key"
                  onClick={suggest}
                  title={`Propose a ${bars}-bar loop — press again to re-roll. The one it replaces stays in the history; while playing, it waits for the loop to come round.`}
                >
                  {SYM.suggest}New loop
                </button>
              </Field>
              <Field label="Bars">
                <Keys
                  label="Bars in a suggested loop"
                  value={bars}
                  onChange={setBars}
                  options={[2, 4, 8].map((b) => ({ v: b, label: String(b), title: `Suggest ${b}-bar loops` }))}
                />
              </Field>
            </div>
            <div className="ce-row">
              <Field label="Mutate">
                <button
                  className="ce-key"
                  onClick={mutate}
                  disabled={prog.length < 2}
                  title={`Change ${MUT_LEVELS[mutLevel - 1][1]}${mutLevel < 4 ? ", keeping bar 1 and your edits" : ""}. The original stays in the history; while playing, the change waits for the loop to come round.`}
                >
                  {SYM.mutate}Once
                </button>
              </Field>
              <Field label="Amount">
                <Steps value={mutLevel} onChange={setMutLevel} />
              </Field>
            </div>
            <Field label="Evolve each loop">
              <Keys
                label="Evolve"
                value={evolve}
                disabled={!loop}
                onChange={setEvolve}
                options={[
                  { v: false, label: "Off", title: "Keep the loop as it is" },
                  {
                    v: true,
                    label: "Evo",
                    title: loop
                      ? "Mutate the progression every time the loop comes round, so it keeps changing while it plays. Every version stays in the history"
                      : "Mutates the loop each time it comes round — turn Loop on to use it",
                  },
                ]}
              />
            </Field>
          </div>
        </section>

        {/* 03–04: how the progression sounds when it plays, and where it goes */}
        <section className="ce-mod ce-m-play" aria-labelledby="ce-h-play">
          <ModHead n="03" id="ce-h-play">Playback</ModHead>
          <div className="ce-stack">
            <div className="ce-row">
              <Field label="Voicing">
                <Keys
                  label="Voicing"
                  value={voiceLead}
                  onChange={setVoiceLead}
                  options={[
                    { v: false, label: SYM.rootPos, aria: "Root position", title: "Root position: every chord stacked up from its own root" },
                    { v: true, label: SYM.voiceLed, aria: "Voice-leading", title: "Voice-leading: inversions that move each voice as little as possible between chords" },
                  ]}
                />
              </Field>
              <Field label="Bass">
                <div className="ce-bg">
                  <Toggle
                    on={bassOn}
                    onClick={() => setBassOn((v) => !v)}
                    aria-label="Bass voice"
                    title="Add a bass voice under each chord: the root, unless a tile's arrows pick another chord tone. It moves to the nearest octave, like a bass line"
                  >
                    B
                  </Toggle>
                  <Toggle
                    on={holdBass}
                    disabled={!arp || !bassOn}
                    onClick={() => setHoldBass((v) => !v)}
                    aria-label="Hold the bass"
                    title={bassOn && arp
                      ? "Hold the bass for the whole chord under the arpeggio, instead of playing it as the arpeggio's first step"
                      : "Holds the bass under an arpeggio — needs Bass on and an arpeggio"}
                  >
                    {SYM.hold}
                  </Toggle>
                </div>
              </Field>
              <Field label="Loop">
                <div className="ce-bg">
                  <Toggle
                    on={loop}
                    onClick={() => setLoop((v) => !v)}
                    aria-label="Loop"
                    title="Repeat the progression until you press Stop"
                  >
                    {SYM.loop}
                  </Toggle>
                </div>
              </Field>
            </div>
            <div className="ce-row">
              <Field label="Arpeggio">
                <Keys
                  label="Arpeggio"
                  value={arpMode}
                  onChange={setArpMode}
                  options={[
                    { v: "off", label: SYM.block, aria: "Block chord", title: "Play each chord as a block" },
                    { v: "rise", label: SYM.rise, aria: "Arpeggio, rising", title: "Arpeggio: one note at a time, low to high, spread across the chord's slot" },
                    { v: "random", label: SYM.random, aria: "Arpeggio, random order", title: "Arpeggio in a new random order each time the chord plays" },
                  ]}
                />
              </Field>
              <Field label="Steps">
                <Keys
                  label="Arpeggio steps"
                  value={arpFour}
                  disabled={!arp}
                  onChange={setArpFour}
                  options={[
                    { v: false, label: "n", title: "As many steps as the chord has notes" },
                    { v: true, label: "-4-", title: "Four steps per chord: a three-note chord plays 1 3 5 3, so every chord keeps the same rhythm" },
                  ]}
                />
              </Field>
            </div>
            {/* 80 bars for 60–140: one bar is one beat per minute */}
            <Level
              wide
              label="Tempo"
              n={80}
              pos={(tempo - 60) / 80}
              text={String(tempo)}
              title="Beats per minute — each chord lasts two beats"
              onPos={(p) => setTempo(Math.round(60 + p * 80))}
              onStep={(d) => setTempo((t) => Math.min(140, Math.max(60, t + d)))}
            />
          </div>
        </section>

        <section className="ce-mod ce-m-out" aria-labelledby="ce-h-out">
          <ModHead n="04" id="ce-h-out">Out</ModHead>
          <div className="ce-stack">
            <Field label="Route">
              <Keys
                label="Output"
                value={routeMidi ? "midi" : "int"}
                onChange={pickOutput}
                options={[
                  { v: "int", label: "Int", title: "The built-in synth" },
                  {
                    v: "midi",
                    label: "MIDI",
                    disabled: midiDead,
                    title: midi.status === "ready"
                      ? "Send notes to an external instrument instead of the built-in synth"
                      : MIDI_STATUS[midi.status].hint,
                  },
                ]}
              />
            </Field>
            <Field label="Port">
              {midi.status !== "ready" ? (
                <p className="ce-print" title={MIDI_STATUS[midi.status].hint}>
                  {MIDI_STATUS[midi.status].label}
                </p>
              ) : midi.outputs.length ? (
                <Keys
                  column
                  label="MIDI port"
                  value={midi.portId}
                  onChange={(id) => {
                    midiPanic();
                    midi.setPortId(id);
                  }}
                  options={midi.outputs.map((o, i) => ({ v: o.id, label: `${i + 1} · ${o.name}`, title: o.name }))}
                />
              ) : (
                <p className="ce-print">No MIDI outputs found</p>
              )}
            </Field>
          </div>
        </section>

        {/* the progression, on its e-ink panel, with the transport beside it */}
        <section className="ce-mod ce-m-disp" aria-label="Progression">
          <div className="ce-screen">
            <div className="ce-scr-top">
              <span><b>{keyName}</b> {mode}</span>
              {prog.length > 0 && <span>{prog.length} bar{prog.length === 1 ? "" : "s"}</span>}
              <span>{tempo} bpm</span>
              {prog.length > 1 && (
                <span title="Total semitones of voice movement across the progression — lower is smoother">
                  Δ <b>{totalMotion}</b>
                </span>
              )}
              {playing && playingIdx >= 0 && (
                <span>bar <b>{playingIdx + 1}</b>/{prog.length}</span>
              )}
              {/* every progression this visit, oldest first; what's queued for
                  when the loop comes round sits last, dashed */}
              {(hist.gens.length > 1 || liveRef.current.next) && (
                <ol className="ce-gens" ref={gensRef} aria-label="Progression history">
                  {hist.gens.map((g, i) => {
                    const waiting = queued?.kind === "goto" && queued.idx === i;
                    return (
                      <li key={i}>
                        <button
                          className={"ce-gen" + (i === hist.cur ? " on" : "") + (waiting ? " next" : "")}
                          aria-current={i === hist.cur ? "true" : undefined}
                          onClick={() => goto(i)}
                          title={`${genNames(g)}\n` + (i === hist.cur
                            ? playing && queued ? "Stay on this one: drop what's waiting" : "Playing now"
                            : playing ? "Play this one when the loop comes round" : "Go back to this one")}
                        >
                          {i + 1}
                        </button>
                      </li>
                    );
                  })}
                  {liveRef.current.next && queued.kind !== "goto" && (
                    <li>
                      <span
                        className="ce-gen ghost"
                        title={`${genNames(nextProg)}\n` + (queued.auto ? "Evolve: plays when the loop comes round" : "Plays when the loop comes round")}
                      >
                        +
                      </span>
                    </li>
                  )}
                </ol>
              )}
            </div>

            {blocked && !noSoundDismissed && (
              <div className="ce-nosound" role="status">
                <p>
                  <b>No sound?</b> Your browser is blocking audio on this page. In Safari:
                  Safari menu → <i>Settings for {window.location.hostname}…</i> → Auto-Play →{" "}
                  <i>Allow All Auto-Play</i>, then reload. In other browsers, look for a sound
                  or autoplay permission under the icon at the left of the address bar.
                </p>
                <button
                  className="ce-nosound-x"
                  onClick={() => setNoSoundDismissed(true)}
                  aria-label="Dismiss"
                  title="Dismiss"
                >
                  ×
                </button>
              </div>
            )}

            <div className="ce-roll" ref={rollRef}>
              {prog.length ? (
                <PianoRoll
                  prog={prog}
                  voicings={voicings}
                  bass={bass}
                  playingIdx={playingIdx}
                  lit={lit}
                  keyRoot={key.root}
                  spawn={spawn}
                  colsRef={colsRef}
                  dragIdx={dragIdx}
                  dragMoved={dragMoved}
                  onPlay={(i) => playVoiced(played[i])}
                  onPlayNote={(m) => playVoiced({ upper: [m], bass: null })}
                  onInvert={invert}
                  onRemove={removeChord}
                  onDragStart={onDragStart}
                  onTileKey={onTileKey}
                />
              ) : (
                <p className="ce-empty">Pick a chord below — it plays, and the roll starts here.</p>
              )}
            </div>
          </div>

          <div className="ce-transport">
            <span className="ce-lbl">Transport</span>
            <button
              className={"ce-key big" + (playing ? " live" : "")}
              onClick={() => { if (!playing) playAll(); }}
              disabled={!prog.length}
              aria-label="Play"
              title={playing ? "Playing" : "Play the progression"}
            >
              {SYM.play}
            </button>
            <button className="ce-key big" onClick={stopPlayback} disabled={!playing} aria-label="Stop" title="Stop">
              {SYM.stop}
            </button>
            <span className="ce-lbl">Delete</span>
            <button
              className="ce-key big"
              onClick={undo}
              disabled={!prog.length}
              aria-label="Delete the last chord"
              title="Delete the last chord"
            >
              {SYM.x}
            </button>
            <button
              className="ce-key big word"
              onClick={clear}
              disabled={!prog.length}
              aria-label="Delete every chord"
              title="Delete every chord — the progression stays in the history"
            >
              All
            </button>
          </div>
        </section>

        <section className="ce-mod ce-m-fut">
          <FutureList
            listRef={futuresRef}
            options={shown}
            total={futures.length}
            current={current}
            keyRoot={key.root}
            fromMidi={fromMidi}
            voiceLead={voiceLead}
            exiting={exiting}
            listKey={`${prog.length}|${root}|${mode}|${add7}|${susOn}|${voiceLead}|${tensionDesc}`}
            tensionDesc={tensionDesc}
            onFlipSort={() => setTensionDesc((v) => !v)}
            query={query}
            onQuery={setQuery}
            hiddenBy={hiddenBy}
            onPick={choose}
            onPreview={preview}
          />
        </section>

        <section className="ce-mod ce-m-snd" aria-labelledby="ce-h-snd">
          <SoundModule
            sound={sound}
            setSound={setSound}
            onAudition={auditionSound}
            midiActive={midiActive}
          />
        </section>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------
//  PANEL PARTS — the few kinds of control the whole face is built from
// ------------------------------------------------------------------------
// A module's printed heading: its number, its name, a hairline to the edge.
const ModHead = ({ n, id, children }) => (
  <h2 className="ce-mod-h" id={id}>
    <b>{n}</b>
    {children}
  </h2>
);

// a printed label over a control
const Field = ({ label, title, children }) => (
  <div className="ce-f" title={title}>
    <span className="ce-lbl">{label}</span>
    {children}
  </div>
);

// A row of keys with cut-out legends, the chosen one lit from behind. This is
// what every dropdown became: the choices are always in view.
function Keys({ label, value, options, onChange, disabled, column }) {
  return (
    <div className={"ce-bg" + (column ? " col" : "")} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.v)}
          role="radio"
          aria-checked={value === o.v}
          aria-label={o.aria}
          className={value === o.v ? "on" : undefined}
          disabled={disabled || o.disabled}
          title={o.title}
          onClick={() => onChange(o.v)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// a key that stays lit while it's on — sits in a .ce-bg, alone or with others
const Toggle = ({ on, children, ...rest }) => (
  <button className={on ? "on" : undefined} aria-pressed={on} {...rest}>
    {children}
  </button>
);

// The key selector, laid out as the octave it is: naturals along the bottom,
// the sharps and flats above them, half a key over.
const NATURALS = [0, 2, 4, 5, 7, 9, 11];
function RootKeys({ root, onPick }) {
  return (
    <div className="ce-keys" role="radiogroup" aria-label="Key">
      {Array.from({ length: 12 }, (_, pc) => {
        const n = NATURALS.indexOf(pc);
        const acc = n < 0;
        const col = acc ? NATURALS.indexOf(pc - 1) * 2 + 2 : n * 2 + 1;
        return (
          <button
            key={pc}
            role="radio"
            aria-checked={root === pc}
            className={(acc ? "acc" : "") + (root === pc ? " on" : "")}
            style={{ gridRow: acc ? 1 : 2, gridColumn: `${col} / span 2` }}
            onClick={() => onPick(pc)}
          >
            {nameOf(pc, pc)}
          </button>
        );
      })}
    </div>
  );
}

// Mutate's amount: four lines, lit up to the one you press
function Steps({ value, onChange }) {
  return (
    <div className="ce-steps-wrap">
      <div className="ce-steps" role="radiogroup" aria-label="How much a mutation changes">
        {MUT_LEVELS.map(([label, hint], i) => (
          <button
            key={label}
            role="radio"
            aria-checked={value === i + 1}
            aria-label={label}
            title={`Change ${hint} — Evolve uses this too`}
            className={i < value ? "lit" : undefined}
            onClick={() => onChange(i + 1)}
          />
        ))}
      </div>
      <span className="ce-steps-val">{MUT_LEVELS[value - 1][0]}</span>
    </div>
  );
}

// A level: a row of thin bars lit from behind up to the value, the rest dark.
// It stands in for a range input, so it carries the slider role and its keys —
// arrows step, Shift+arrows step ten times as far, Home and End go to the ends.
// `pos` is 0–1; the caller maps it onto whatever the level controls. `onStep`,
// if given, owns the arrow keys (tempo steps a whole BPM); otherwise they move
// a hundredth of the travel. Dragging is driven from the window, the same
// lesson as the roll's reordering: release anywhere and it still lets go.
function Level({ label, pos, text, onPos, onStep, onCommit, n = 36, wide, title }) {
  const bar = useRef(null);
  const clamp = (t) => Math.min(1, Math.max(0, t));
  const lit = Math.round(clamp(pos) * n);
  const fromX = (x) => {
    const r = bar.current.getBoundingClientRect();
    return clamp((x - r.left) / r.width);
  };
  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection; focus by hand instead
    bar.current.focus();
    onPos(fromX(e.clientX));
    function move(m) {
      if (!m.buttons) return up();
      onPos(fromX(m.clientX));
    }
    function up() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      onCommit?.();
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  const STEP_KEYS = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 };
  const onKeyDown = (e) => {
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      return onPos(e.key === "Home" ? 0 : 1);
    }
    const d = STEP_KEYS[e.key];
    if (!d) return;
    e.preventDefault();
    const by = d * (e.shiftKey ? 10 : 1);
    if (onStep) onStep(by);
    else onPos(clamp(pos + by / 100));
  };
  const onKeyUp = (e) => {
    if (e.key in STEP_KEYS || e.key === "Home" || e.key === "End") onCommit?.();
  };
  return (
    <div className={"ce-lvl" + (wide ? " wide" : "")} title={title}>
      <div className="ce-lvl-top">
        <span className="ce-lbl">{label}</span>
        <span className="ce-lvl-val">{text}</span>
      </div>
      <div
        ref={bar}
        className="ce-lvl-bar"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clamp(pos) * 100)}
        aria-valuetext={text}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
      >
        {Array.from({ length: n }, (_, i) => (
          <i key={i} className={i < lit ? "lit" : undefined} />
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------
//  SOUND — the synth, with the lid off
// ------------------------------------------------------------------------
// One control per parameter, read straight off SYNTH_PARAMS, so adding a knob
// is a line in the table rather than a line of markup. Every level runs 0–1000
// underneath whatever it controls (see paramToPos) — meaningless to read aloud,
// hence aria-valuetext carrying the formatted value instead.
function Knob({ k, value, onChange, onCommit }) {
  const p = SYNTH_PARAMS[k];
  if (p.kind === "enum") {
    return (
      <Field label={p.label} title={p.hint}>
        <Keys
          label={p.label}
          value={value}
          onChange={onChange}
          options={p.options.map((o) => ({ v: o, label: WAVE_SYM[o] ?? o, aria: o, title: o }))}
        />
      </Field>
    );
  }
  return (
    <Level
      label={p.label}
      title={p.hint}
      pos={paramToPos(k, value) / 1000}
      text={formatParam(k, value)}
      onPos={(t) => onChange(paramFromPos(k, Math.round(t * 1000)))}
      // audition on release, not on every frame of the drag
      onCommit={onCommit}
    />
  );
}

// Module 06, always open at the foot of the face: the sound is part of the
// same instrument as the key and the tempo. Presets are keys like everything
// else, and the last one, —, lights when the levels match none of them.
function SoundModule({ sound, setSound, onAudition, midiActive }) {
  const preset = presetNameFor(sound);
  const set = (k) => (v) => setSound((s) => ({ ...s, [k]: v }));
  return (
    <>
      <ModHead n="06" id="ce-h-snd">Sound</ModHead>
      <div className="ce-snd-top">
        <Field label="Preset" title="A starting point — every level below is still yours afterwards">
          <Keys
            label="Preset"
            value={preset ?? "custom"}
            onChange={(name) => { if (name !== "custom") setSound({ ...PRESETS[name] }); }}
            options={[
              ...Object.keys(PRESETS).map((name) => ({ v: name, label: name })),
              { v: "custom", label: "—", aria: "Custom", title: "Custom: the levels match none of the presets" },
            ]}
          />
        </Field>
        <p className="ce-print ce-snd-note">
          {midiActive
            ? "Routed to MIDI — Dynamics and Humanise still go out the port; the rest shapes the built-in synth."
            : "Drag a level and let go to hear the chord you're on."}
        </p>
      </div>
      <div className="ce-snd-cols">
        {SYNTH_GROUPS.map((g) => (
          <div className="ce-snd-col" key={g.name}>
            <h3 className="ce-snd-h">{g.name}</h3>
            <div className="ce-stack">
              {g.keys.map((k) => (
                <Knob key={k} k={k} value={sound[k]} onChange={set(k)} onCommit={onAudition} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// ------------------------------------------------------------------------
//  FUTURES — every chord that could come next, one line each
// ------------------------------------------------------------------------
const MAX_TENSION = 4.5; // the top of the tension meter, matching the engine's range
const METER = 8; // squares in a tension meter

function FutureList({
  options, total, current, keyRoot, fromMidi, voiceLead, exiting, listKey, listRef,
  query, onQuery, hiddenBy, tensionDesc, onFlipSort, onPick, onPreview,
}) {
  const filtering = query.trim() !== "";
  // Enter commits the top match, so "fsus4 ⏎" plays the chord you came for. The
  // row element is what the flight animation measures from, hence the lookup.
  const onKeyDown = (e) => {
    if (e.key === "Escape") { onQuery(""); e.currentTarget.blur(); }
    if (e.key === "Enter" && options.length) {
      onPick(options[0], listRef.current?.querySelector(".ce-future"));
    }
  };
  return (
    <div className="ce-futures">
      <div className="ce-fut-head">
        <ModHead n="05">{current ? `From ${current.name} — next` : "Start on any chord"}</ModHead>
        <label className="ce-filter">
          <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.1">
            <circle cx="5" cy="5" r="3.8" />
            <path d="M8 8l3 3" />
          </svg>
          <input
            type="search"
            value={query}
            placeholder="filter — bvii, f#, sus"
            aria-label="Filter the chords by name or roman numeral"
            title="Filter by name or roman numeral — “sus”, “♭VII”, “F♯”. Enter picks the top match."
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {filtering && <span className="ce-futures-count">{options.length}/{total}</span>}
        </label>
      </div>
      <div className="ce-future head">
        <button
          type="button"
          className="ce-futures-axis"
          onClick={onFlipSort}
          aria-label={`Sorted by tension, ${tensionDesc ? "most tense first" : "least tense first"}. Flip the order.`}
          title={(tensionDesc ? "Most tense first" : "Least tense first") + " — click to flip the order"}
        >
          Tension {tensionDesc ? "↓" : "↑"}
        </button>
        <span>Chord</span>
        <span className="ce-fu-roman">Degree</span>
        <span className="ce-fu-notes">Notes</span>
        <span className="ce-fu-dist">Δ</span>
        <span className="ce-fu-move">What it does</span>
      </div>
      {/* keyed on the whole option set so the assemble animation replays */}
      <div className="ce-futures-list" key={listKey} ref={listRef}>
        {options.map((o, i) => (
          <FutureRow
            key={optKey(o)}
            i={i}
            opt={o}
            keyRoot={keyRoot}
            dist={optionDistance(fromMidi, o, voiceLead)}
            state={exiting ? (exiting === optKey(o) ? "chosen" : "leaving") : ""}
            onPick={onPick}
            onPreview={onPreview}
          />
        ))}
      </div>
      {filtering && (!options.length || hiddenBy.length > 0) && (
        <p className="ce-futures-note" role="status">
          {!options.length && <span>Nothing here matches “{query.trim()}”.</span>}
          {hiddenBy.map((g) => (
            <button key={g.label} type="button" className="ce-futures-hint" onClick={g.turnOn}>
              +{g.hits.length} more with {g.label} on
            </button>
          ))}
        </p>
      )}
    </div>
  );
}

function FutureRow({ opt, i, keyRoot, dist, state, onPick, onPreview }) {
  const ref = useRef(null);
  const notes = chordNoteNames(opt, keyRoot).join(" ");
  // at least one square, so the calmest chord still reads as a meter
  const lit = Math.max(1, Math.round((Math.min(opt.tension, MAX_TENSION) / MAX_TENSION) * METER));
  return (
    <button
      ref={ref}
      type="button"
      className={"ce-future" + (opt.resolution ? " resolve" : "") + (state ? " " + state : "")}
      style={{ "--i": i }}
      onClick={() => onPick(opt, ref.current)}
      title={
        `${opt.name} — ${notes} · ${opt.func}` +
        (opt.motion ? ` · root ${opt.motion}` : "") +
        `\n${opt.move}`
      }
    >
      {/* what the chord does and how hard it pulls, in one block: the function
          printed small over a meter of squares lit to its tension */}
      <span className="ce-fu-tension" aria-hidden="true">
        <span className="ce-fu-func">{opt.func}</span>
        <span className="ce-fu-meter">
          {Array.from({ length: METER }, (_, j) => (
            <i key={j} className={j < lit ? "lit" : undefined} />
          ))}
        </span>
      </span>
      {/* hovering auditions the chord — the name alone, so reading a row is silent */}
      <span className="ce-fu-name" onMouseEnter={() => onPreview(opt)}>{opt.name}</span>
      <span className="ce-fu-roman">{opt.roman}</span>
      <span className="ce-fu-notes">{notes}</span>
      <span className="ce-fu-dist">
        {dist != null && (
          <span title={`${dist} semitone${dist === 1 ? "" : "s"} of voice movement from the current chord`}>
            Δ{dist}
          </span>
        )}
      </span>
      <span className="ce-fu-move">
        {opt.move}
        {opt.resolution && <span className="ce-fu-res">Resolves</span>}
      </span>
    </button>
  );
}
// piano-roll progression: each voice sits at its pitch height, so common tones
// line up across columns and the voice leading is visible. Right-angled ink
// connectors trace each voice from one chord to the next — the way a panel
// draws — and the chord tile sits underneath.
const ROLL = { ROW: 13, CELL: 26, COL: 128, GAP: 44, LANE: 36 }; // px per semitone, pill, column, gap, gap above the bass lane

// semitone step as a sequencer would read it: +2, -3, 0 for a held voice
const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "·");
const stepTitle = (n) =>
  n === 0
    ? "this voice holds"
    : `this voice moves ${n > 0 ? "+" : "−"}${Math.abs(n)} semitone${Math.abs(n) === 1 ? "" : "s"}`;
const octaveOf = (m) => Math.floor(m / 12) - 1; // C4 is 60

const ShareIcon = () => (
  <svg viewBox="0 0 14 14" aria-hidden="true" focusable="false"
       fill="none" stroke="currentColor" strokeWidth="1.2">
    <path d="M7 1v8M3.5 4.5 7 1l3.5 3.5M2 8v4.5h10V8" />
  </svg>
);

const Tick = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"
       fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 8.4 L6.4 11.8 L13 5.2" />
  </svg>
);

const Chevron = ({ up }) => (
  <svg viewBox="0 0 12 8" width="11" height="7" aria-hidden="true" focusable="false">
    <path
      d={up ? "M1.5 6 L6 1.5 L10.5 6" : "M1.5 2 L6 6.5 L10.5 2"}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

// The legends: small line drawings in place of words, where a word would be
// longer than the thing it names. Cryptic on purpose — each key has a tooltip.
const Sym = ({ box = "0 0 22 12", children }) => (
  <svg viewBox={box} aria-hidden="true" focusable="false"
       fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
    {children}
  </svg>
);
const Dot = ({ x, y }) => <circle cx={x} cy={y} r="1.4" fill="currentColor" stroke="none" />;
const WAVE_SYM = {
  sine: <Sym><path d="M1 6C3.8-1.5 8.2-1.5 11 6S18.2 13.5 21 6" /></Sym>,
  triangle: <Sym><path d="M1 10L6 2L11 10L16 2L21 10" /></Sym>,
  sawtooth: <Sym><path d="M1 10L10 2V10L19 2V10" /></Sym>,
  square: <Sym><path d="M1 10V2H6V10H11V2H16V10H21" /></Sym>,
};
const SYM = {
  // voicing: three stacked lines jumping between chords, or stepping smoothly
  rootPos: <Sym><path d="M1 10h5M1 6h5M1 2h5M16 11h5M16 7h5M16 3h5" /></Sym>,
  voiceLed: <Sym><path d="M1 10h20M1 6h9l2 1h9M1 2h9l2 -1h9" /></Sym>,
  // arpeggio: the chord's notes as dots in time — together, rising, scattered
  block: <Sym><Dot x={11} y={2} /><Dot x={11} y={6} /><Dot x={11} y={10} /></Sym>,
  rise: <Sym><Dot x={3} y={10} /><Dot x={11} y={6} /><Dot x={19} y={2} /></Sym>,
  random: <Sym><Dot x={3} y={6} /><Dot x={11} y={10} /><Dot x={19} y={2} /></Sym>,
  // hold bass: an arpeggio over a line that doesn't stop
  hold: <Sym><path d="M1 11h20" /><Dot x={5} y={6} /><Dot x={11} y={3} /><Dot x={17} y={6} /></Sym>,
  loop: <Sym><path d="M7 2h8a4 4 0 0 1 0 8H7a4 4 0 0 1 0-8z" /><path d="M13 0l2 2-2 2" /></Sym>,
  suggest: <Sym box="0 0 12 12"><path d="M1 9h2l3-6h2l3 6" /></Sym>,
  mutate: <Sym box="0 0 12 12"><path d="M2 3h5l-2-2M10 9H5l2 2" /></Sym>,
  play: <Sym box="0 0 14 14"><path d="M3 1.5v11L12 7z" fill="currentColor" stroke="none" /></Sym>,
  stop: <Sym box="0 0 14 14"><rect x="2.5" y="2.5" width="9" height="9" fill="currentColor" stroke="none" /></Sym>,
  x: <Sym box="0 0 14 14"><path d="M3 3l8 8M11 3l-8 8" /></Sym>,
};

// what the lights burn — one picked at random on each visit
const LAMPS = ["#FF5F1F", "#ED67B4", "#58B4B9", "#FFB000", "#2FD37A", "#FF2E3F", "#2E8BFF"];

function PianoRoll({
  prog, voicings, bass, playingIdx, lit, keyRoot, spawn, colsRef, dragIdx, dragMoved,
  onPlay, onPlayNote, onInvert, onRemove, onDragStart, onTileKey,
}) {
  const { ROW, CELL, COL, GAP } = ROLL;
  const all = voicings.flat();
  if (!all.length) return null;
  const max = Math.max(...all);
  const min = Math.min(...all);
  const bandH = (max - min) * ROW + CELL;
  const width = prog.length * COL + Math.max(0, prog.length - 1) * GAP;
  const topOf = (m) => (max - m) * ROW; // pill top
  const cy = (m) => topOf(m) + CELL / 2; // pill centre

  // The bass voice gets its own lane under the chords rather than its true
  // height: it sits an octave or two below them, and drawing that honestly would
  // put a tall band of empty rows between the two. Pitch is still to scale
  // *within* each lane; the dashed rule marks where the scale breaks.
  const hasBass = !!(bass && bass.length);
  const bMax = hasBass ? Math.max(...bass) : 0;
  const bMin = hasBass ? Math.min(...bass) : 0;
  const laneTop = bandH + ROLL.LANE;
  const bassTop = (m) => laneTop + (bMax - m) * ROW;
  const rollH = hasBass ? laneTop + (bMax - bMin) * ROW + CELL : bandH;

  // connectors: pair voices by ascending pitch order across adjacent chords,
  // from the right edge of one pill to the left edge of the next — along, down
  // (or up) at the midpoint, along again
  const links = [];
  const link = (i, y1, y2) => {
    const x1 = i * (COL + GAP) + COL;
    const x2 = (i + 1) * (COL + GAP);
    const mid = (x1 + x2) / 2;
    links.push(y1 === y2 ? `M${x1} ${y1}H${x2}` : `M${x1} ${y1}H${mid}V${y2}H${x2}`);
  };
  for (let i = 0; i < voicings.length - 1; i++) {
    const a = [...voicings[i]].sort((p, q) => p - q);
    const b = [...voicings[i + 1]].sort((p, q) => p - q);
    for (let v = 0; v < Math.min(a.length, b.length); v++) link(i, cy(a[v]), cy(b[v]));
    if (hasBass) link(i, bassTop(bass[i]) + CELL / 2, bassTop(bass[i + 1]) + CELL / 2);
  }

  return (
    <div className="ce-roll-inner" style={{ width }}>
      <svg className="ce-roll-links" width={width} height={rollH} aria-hidden="true">
        {hasBass && (
          <line
            className="ce-roll-lane"
            x1={0} x2={width} y1={bandH + ROLL.LANE / 2} y2={bandH + ROLL.LANE / 2}
          />
        )}
        {links.map((d, k) => <path key={k} d={d} className="ce-roll-link" />)}
      </svg>
      <div className="ce-roll-cols" ref={colsRef}>
        {prog.map((c, i) => {
          const midi = voicings[i];
          // the column that just landed: its pills fly in from the future row
          const born = spawn && spawn.idx === i;
          const prevSet = i > 0 ? new Set(voicings[i - 1]) : null;
          const rootName = nameOf(c.rootPc, keyRoot);
          // the slash names the lowest note you hear: the bass voice when it's on
          // (the root, unless the arrows have walked it to another chord tone),
          // otherwise the bottom of the voicing
          const bassName = hasBass ? nameOf(mod12(bass[i]), keyRoot) : bassNameOf(midi, keyRoot);
          const inverted = bassName !== rootName;
          const notes = chordNoteNames(c, keyRoot);
          // semitone travel from the previous chord (the connectors' total length)
          const dist = i > 0 ? voicingDistance(voicings[i - 1], midi) : null;
          // per-voice steps, for dialling the move into a chromatic sequencer
          const steps = i > 0 ? voiceSteps(voicings[i - 1], midi) : null;
          const pill = (m, { step, held, isBass, delay }) => (
            <button
              key={isBass ? "bass" : m}
              type="button"
              className={
                "ce-roll-note" +
                (isBass ? " bass" : "") +
                (held ? " held" : "") +
                (i === playingIdx && lit.has(m) ? " lit" : "") +
                (born ? " spawn" : "")
              }
              // --dx / --dy are measured after layout, in the parent
              style={{
                top: isBass ? bassTop(m) : topOf(m),
                ...(born ? { animationDelay: `${delay}ms` } : null),
              }}
              onClick={() => onPlayNote(m)}
              title={
                `Play ${Tone.Frequency(m, "midi").toNote()}` +
                (isBass ? " · bass" : "") +
                (step == null ? "" : ` · ${stepTitle(step)}`)
              }
            >
              <span>{nameOf(mod12(m), keyRoot)}{octaveOf(m)}</span>
              {step != null && <em className="ce-roll-step">{signed(step)}</em>}
            </button>
          );
          return (
            <div
              key={c.id}
              className={
                "ce-roll-col" +
                (i === playingIdx ? " playing" : "") +
                (i === dragIdx ? " dragging" : "")
              }
              style={{ width: COL }}
            >
              <span className="ce-roll-notes" style={{ height: rollH }}>
                {[...midi].sort((a, b) => a - b).map((m, v) =>
                  pill(m, {
                    step: steps ? steps.get(m) : undefined,
                    held: prevSet && prevSet.has(m),
                    // the bass lands first, so the chord builds upward
                    delay: (v + (hasBass ? 1 : 0)) * 52,
                  })
                )}
                {hasBass &&
                  pill(bass[i], {
                    step: i > 0 ? bass[i] - bass[i - 1] : null,
                    held: i > 0 && bass[i - 1] === bass[i],
                    isBass: true,
                    delay: 0,
                  })}
              </span>
              <div className={"ce-roll-tilewrap" + (born ? " spawn" : "")}>
                <button
                  type="button"
                  className="ce-roll-tile"
                  onPointerDown={(e) => onDragStart(i, e)}
                  onClick={() => { if (!dragMoved()) onPlay(i); }}
                  onKeyDown={(e) => onTileKey(i, e)}
                  aria-label={`${c.name}, chord ${i + 1} of ${prog.length}. Alt with the arrow keys reorders, Delete removes.`}
                  title={`${c.name}${inverted ? "/" + bassName : ""} · ${notes.join(" ")} · ${c.move}\nDrag to reorder · Alt+← / Alt+→ · Delete to remove`}
                >
                  <span className="ce-chip-name">
                    {c.name}
                    {inverted && <span className="ce-chip-slash">/{bassName}</span>}
                  </span>
                  <span className="ce-chip-roman">
                    {c.roman}
                    {/* the first chord has nothing to measure from */}
                    {dist != null && (
                      <span
                        className="ce-chip-dist"
                        title={`${dist} semitone${dist === 1 ? "" : "s"} of voice movement from the previous chord`}
                      >
                        Δ{dist}
                      </span>
                    )}
                  </span>
                </button>
                <button
                  type="button"
                  className="ce-roll-del"
                  onClick={() => onRemove(i)}
                  aria-label={`Remove ${c.name} from the progression`}
                  title={`Remove ${c.name}`}
                >
                  ×
                </button>
                <span className="ce-roll-invert">
                  <button
                    type="button"
                    className="ce-inv-btn"
                    onClick={() => onInvert(i, +1)}
                    aria-label={hasBass ? "Move the bass up a chord tone" : "Raise the lowest note an octave"}
                    title={hasBass
                      ? "Move the bass up a chord tone, and raise the lowest upper note an octave"
                      : "Raise the lowest note an octave"}
                  >
                    <Chevron up />
                  </button>
                  <button
                    type="button"
                    className="ce-inv-btn"
                    onClick={() => onInvert(i, -1)}
                    aria-label={hasBass ? "Move the bass down a chord tone" : "Lower the highest note an octave"}
                    title={hasBass
                      ? "Move the bass down a chord tone, and lower the highest upper note an octave"
                      : "Lower the highest note an octave"}
                  >
                    <Chevron />
                  </button>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Kept, not dead: the tension curve is out of the progression view for now but
// the concept it draws — distance from home over time — is the thing the whole
// app is about, and it will come back. Deliberately unused, so silence the rule
// rather than deleting the component to appease it.
// eslint-disable-next-line no-unused-vars
function TensionCurve({ prog, playingIdx }) {
  const W = 100, H = 34, pad = 4;
  const max = 4.5;
  const n = prog.length;
  const x = (i) => (n === 1 ? W / 2 : pad + (i * (W - pad * 2)) / (n - 1));
  const y = (t) => H - pad - (Math.min(t, max) / max) * (H - pad * 2);
  const pts = prog.map((c, i) => `${x(i)},${y(c.tension)}`).join(" ");
  return (
    <svg className="ce-curve" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" y1={H - pad} x2={W} y2={H - pad} className="ce-curve-base" />
      {n > 1 && <polyline points={pts} className="ce-curve-line" />}
      {prog.map((c, i) => (
        <circle
          key={c.id}
          cx={x(i)}
          cy={y(c.tension)}
          r={i === playingIdx ? 2.4 : 1.6}
          style={{ fill: HUE[hueOf(c.func)] }}
        />
      ))}
    </svg>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&family=Barlow+Semi+Condensed:wght@500;600&display=swap');

/* A piece of hardware: one white chassis, modules set into it with hairline
   seams, lit keys instead of dropdowns, levels lit from behind, and a mono
   e-ink panel for the progression. One lamp colour for every light on it. */
body{margin:0; background:#F3F3F0;}
.ce-root{
  --page:#F3F3F0; --face:#FCFCFA; --seam:#E3E3DE; --hi:#FFFFFF;
  --ink:#1C1C1A; --print:#8A8A84; --print2:#B4B4AE; --unlit:#D9D9D3; --key:#FAFAF8;
  --lamp:#FF5F1F; --lamp-glow:color-mix(in srgb, var(--lamp) 50%, transparent);
  --paper:#F7F6F3; --paper-ink:#1E1E1C; --paper-dim:#9A9990; --paper-rule:rgba(30,30,28,.12);
  /* function hues: no longer painted on the face (function is printed in the
     futures' tension block) — kept for TensionCurve, which is parked */
  --home:#3D9A80; --build:#D69A38; --tension:#D6553F; --outside:#7C6BC4;
  --din:'Barlow',system-ui,sans-serif;
  --cond:'Barlow Semi Condensed','Barlow',system-ui,sans-serif;
  background:var(--page); color:var(--ink); font-family:var(--din);
  font-feature-settings:"tnum" 1; -webkit-font-smoothing:antialiased;
  max-width:1640px; margin:0 auto; padding:24px 16px 64px;
}
.ce-root *{box-sizing:border-box;}
.ce-root button{font:inherit; color:inherit; background:none; border:0; padding:0; cursor:pointer;}
.ce-root button:focus-visible, .ce-lvl-bar:focus-visible{outline:2px solid var(--lamp); outline-offset:3px;}

/* the lamp picker, above the device */
.ce-lamps{display:flex; justify-content:flex-end; gap:10px; margin:0 0 16px;}
.ce-lamps button{width:16px; height:16px; border-radius:50%; background:var(--sw);}
.ce-root .ce-lamps button{background:var(--sw);}
.ce-lamps button[aria-checked=true]{box-shadow:0 0 0 2.5px var(--page), 0 0 0 4px var(--sw);}

/* --- chassis & modules ---------------------------------------------------
   The seams are the chassis showing through a 2px gap between modules. */
.ce-chassis{
  background:var(--seam); border-radius:24px; overflow:hidden;
  display:grid; gap:2px;
  box-shadow:0 1px 0 rgba(0,0,0,.04), 0 30px 80px -40px rgba(0,0,0,.25);
  grid-template-columns:1.2fr 1fr 1.45fr .75fr;
  grid-template-areas:
    "plate plate plate plate"
    "key   gen   play  out"
    "disp  disp  disp  disp"
    "fut   fut   fut   fut"
    "snd   snd   snd   snd";
}
.ce-mod{
  background:var(--face); box-shadow:inset 0 1px 0 var(--hi), inset 1px 0 0 var(--hi);
  padding:24px 30px 30px; min-width:0;
}
.ce-plate{grid-area:plate;} .ce-m-key{grid-area:key;} .ce-m-gen{grid-area:gen;}
.ce-m-play{grid-area:play;} .ce-m-out{grid-area:out;} .ce-m-disp{grid-area:disp;}
.ce-m-fut{grid-area:fut;} .ce-m-snd{grid-area:snd;}

.ce-mod-h{
  display:flex; align-items:baseline; gap:14px; margin:0 0 24px;
  font:600 20px var(--cond); letter-spacing:.16em; text-transform:uppercase; color:var(--print);
}
.ce-mod-h b{font-weight:600; color:var(--print2);}
.ce-mod-h::after{content:""; flex:1; height:1.5px; background:var(--seam); transform:translateY(-6px);}

.ce-lbl{
  display:block; font:500 18px var(--cond); letter-spacing:.14em; text-transform:uppercase;
  color:var(--print); margin:0 0 10px;
}
.ce-print{margin:0; font:500 18px var(--cond); letter-spacing:.06em; color:var(--print); line-height:1.35;}
.ce-row{display:flex; flex-wrap:wrap; gap:24px 30px; align-items:flex-end;}
.ce-stack > * + *{margin-top:24px;}

/* --- nameplate ------------------------------------------------------------ */
.ce-plate{display:flex; align-items:center; gap:36px; padding:22px 34px;}
.ce-plate h1{margin:0; font:700 38px var(--din); letter-spacing:-.015em; white-space:nowrap;}
.ce-leds{display:flex; gap:28px; margin-left:auto;}
.ce-led{display:flex; align-items:center; gap:10px; font:500 18px var(--cond); letter-spacing:.14em; text-transform:uppercase; color:var(--print);}
.ce-led i{width:10px; height:10px; border-radius:50%; background:var(--unlit); transition:background .15s, box-shadow .15s;}
.ce-led.on i{background:var(--lamp); box-shadow:0 0 8px var(--lamp-glow);}
/* a speaker grille: 9px dot pitch, so the height has to be a multiple of 9 or
   the bottom row is cut in half */
.ce-grille{width:180px; height:36px; background-image:radial-gradient(circle, #CFCFC9 1.6px, transparent 2px); background-size:9px 9px;}
.ce-root .ce-share{width:44px; height:44px; display:grid; place-items:center; color:var(--print); border-radius:50%;}
.ce-share svg{width:24px; height:24px;}
.ce-share:hover:not(:disabled){color:var(--ink);}
.ce-share:disabled{opacity:.35; cursor:default;}
.ce-share.copied{color:var(--lamp);}

/* --- key groups: cut-out legends, the chosen one lit from behind --------- */
.ce-bg{
  display:inline-flex; background:var(--seam); gap:1.5px; border-radius:8px; padding:1.5px;
  box-shadow:inset 0 1px 3px rgba(0,0,0,.06); max-width:100%;
}
.ce-bg.col{display:flex; flex-direction:column;}
.ce-bg > button, .ce-keys > button{
  min-width:52px; height:48px; padding:0 16px;
  background:var(--key); display:grid; place-items:center;
  font:600 20px var(--cond); letter-spacing:.08em; text-transform:uppercase;
  color:var(--unlit); transition:color .12s, text-shadow .12s, background .12s;
}
.ce-root .ce-bg > button, .ce-root .ce-keys > button{background:var(--key);}
.ce-bg > button:first-child{border-radius:6.5px 0 0 6.5px;}
.ce-bg > button:last-child{border-radius:0 6.5px 6.5px 0;}
.ce-bg > button:only-child{border-radius:6.5px;}
.ce-bg.col > button{justify-items:start; text-transform:none; letter-spacing:.04em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
.ce-bg.col > button:first-child{border-radius:6.5px 6.5px 0 0;}
.ce-bg.col > button:last-child{border-radius:0 0 6.5px 6.5px;}
.ce-bg.col > button:only-child{border-radius:6.5px;}
.ce-bg > button:hover:not(:disabled), .ce-keys > button:hover{color:var(--print);}
.ce-root .ce-bg > button.on, .ce-root .ce-keys > button.on{
  color:var(--lamp); background:#FFFDFB; text-shadow:0 0 8px var(--lamp-glow);
}
.ce-bg > button svg{width:36px; height:20px; overflow:visible;}
.ce-bg > button.on svg{filter:drop-shadow(0 0 4px var(--lamp-glow));}
.ce-bg > button:disabled{color:#E9E9E4; cursor:default; text-shadow:none;}
.ce-bg > button.on:disabled{color:color-mix(in srgb, var(--lamp) 30%, #E9E9E4);}
.ce-bg > button.on:disabled svg{filter:none;}

/* the key selector, laid out as a keyboard. The gaps in the top row show the
   face rather than the seam, so they read as the spaces between black keys. */
.ce-keys{
  display:grid; grid-template-columns:repeat(14, 24px); grid-template-rows:46px 46px; gap:1.5px;
  background:var(--seam); padding:1.5px; border-radius:8px; width:max-content;
  background-image:linear-gradient(var(--face), var(--face)); background-size:100% 47.5px; background-repeat:no-repeat;
}
.ce-root .ce-keys > button{min-width:0; padding:0; height:auto; letter-spacing:.02em;}
.ce-root .ce-keys > button.acc{background:#F1F1EE;}
.ce-root .ce-keys > button.acc.on{background:#FFF9F4;}
.ce-keys > button:nth-child(1){border-top-left-radius:0;}

/* Mutate's amount: four lines, press one to light up to it */
.ce-steps-wrap{display:flex; align-items:center; gap:16px;}
.ce-steps{display:flex; gap:8px; height:48px; align-items:stretch; padding:0 4px;}
.ce-root .ce-steps button{width:8px; border-radius:1.5px; background:var(--unlit); transition:background .12s, box-shadow .12s;}
.ce-root .ce-steps button:hover{background:#C6C6BF;}
.ce-root .ce-steps button.lit{background:var(--lamp); box-shadow:0 0 5px var(--lamp-glow);}
.ce-steps-val{font:500 20px var(--din); min-width:2.2em;}

/* --- momentary keys: do something, hold no state ------------------------- */
.ce-root .ce-key{
  height:56px; min-width:56px; padding:0 20px; border-radius:8px; background:var(--key);
  box-shadow:0 0 0 1.5px var(--seam), 0 2.5px 0 var(--seam), inset 0 1px 0 #fff;
  font:600 20px var(--cond); letter-spacing:.1em; text-transform:uppercase; color:var(--ink);
  display:inline-grid; place-items:center; grid-auto-flow:column; gap:12px;
  transition:transform .06s, box-shadow .06s, color .12s;
}
.ce-root .ce-key:active:not(:disabled){transform:translateY(2.5px); box-shadow:0 0 0 1.5px var(--seam), 0 0 0 var(--seam), inset 0 1px 3px rgba(0,0,0,.06);}
.ce-root .ce-key:disabled{color:var(--unlit); cursor:default;}
.ce-key svg{width:20px; height:20px;}
.ce-root .ce-key.big{height:76px; width:76px; padding:0;}
.ce-key.big svg{width:24px; height:24px;}
.ce-root .ce-key.live{color:var(--lamp);}
.ce-key.live svg{filter:drop-shadow(0 0 5px var(--lamp-glow));}

/* --- levels: thin bars, ink up to the value ------------------------------ */
.ce-lvl{display:block; min-width:0;}
.ce-lvl-top{display:flex; justify-content:space-between; align-items:baseline; margin-bottom:8px; gap:10px;}
.ce-lvl-top .ce-lbl{margin:0;}
.ce-lvl-val{font:500 20px var(--din); color:var(--ink); white-space:nowrap;}
.ce-lvl-bar{
  display:flex; justify-content:space-between; align-items:flex-end;
  height:26px; cursor:ew-resize; touch-action:none; user-select:none; border-radius:2px;
}
.ce-lvl-bar i{width:3px; height:100%; background:var(--unlit); border-radius:.75px; flex:none;}
.ce-lvl-bar i.lit{background:var(--ink);}
.ce-lvl.wide{max-width:520px;}
.ce-lvl.wide .ce-lvl-bar{height:36px;}
.ce-lvl.wide .ce-lvl-val{font-size:38px; letter-spacing:-.01em;}

/* --- the display: a white e-ink panel, ink and nothing else -------------- */
.ce-m-disp{display:grid; grid-template-columns:minmax(0,1fr) auto; gap:34px;}
.ce-screen{
  background:var(--paper); color:var(--paper-ink); min-width:0;
  border-radius:10px; padding:24px 30px 20px; position:relative;
  box-shadow:inset 0 0 0 1px rgba(0,0,0,.07), inset 0 2px 6px rgba(0,0,0,.07), 0 0 0 7px #F5F5F2, 0 0 0 8.5px var(--seam);
  /* the panel's paper tooth */
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 .025 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
}
.ce-scr-top{
  display:flex; flex-wrap:wrap; gap:10px 32px; align-items:center;
  font:500 20px var(--cond); letter-spacing:.14em; text-transform:uppercase; color:var(--paper-dim);
  margin-bottom:22px;
}
.ce-scr-top b{color:var(--paper-ink); font-weight:600;}
.ce-gens{margin:0 0 0 auto; padding:0; list-style:none; display:flex; flex-wrap:wrap; gap:6px; max-width:100%;}
.ce-root .ce-gen{
  width:28px; height:28px; display:grid; place-items:center;
  border:1.5px solid var(--paper-dim); border-radius:3px;
  font:600 15px var(--cond); letter-spacing:0; color:var(--paper-dim);
}
.ce-root .ce-gen:hover{border-color:var(--paper-ink); color:var(--paper-ink);}
.ce-root .ce-gen.on{background:var(--paper-ink); border-color:var(--paper-ink); color:var(--paper);}
.ce-root .ce-gen.next, .ce-gen.ghost{border-style:dashed; border-color:var(--paper-ink); color:var(--paper-ink);}
.ce-gen.ghost{cursor:default;}

.ce-nosound{
  display:flex; gap:16px; align-items:flex-start; margin:0 0 20px; padding:14px 18px;
  border:2px solid var(--paper-ink); border-radius:6px;
}
.ce-nosound p{margin:0; font-size:18px; line-height:1.45; flex:1; max-width:78ch;}
.ce-nosound i{font-style:normal; font-weight:600;}
.ce-root .ce-nosound-x{flex:0 0 auto; width:32px; height:32px; border-radius:4px; font-size:24px; line-height:1; color:var(--paper-dim);}
.ce-root .ce-nosound-x:hover{color:var(--paper-ink);}

.ce-empty{font-size:22px; color:var(--paper-dim); line-height:1.5; margin:24px 0; max-width:60ch;}

.ce-roll{width:100%; min-width:0; overflow-x:auto; padding:2px 0 8px;}
.ce-roll-inner{position:relative;}
.ce-roll-links{position:absolute; top:0; left:0; z-index:0; overflow:visible; pointer-events:none;}
.ce-roll-link{fill:none; stroke:var(--paper-ink); stroke-width:1.5; stroke-linejoin:miter;}
.ce-roll-lane{stroke:var(--paper-rule); stroke-width:1.5; stroke-dasharray:4 5;}
.ce-roll-cols{position:relative; z-index:1; display:flex; gap:44px; align-items:flex-start;}
.ce-roll-col{flex:0 0 auto; display:flex; flex-direction:column; gap:16px;}
.ce-roll-notes{position:relative; display:block; width:100%;}
.ce-root .ce-roll-note{
  position:absolute; left:0; right:0; height:26px; padding:0 10px;
  display:flex; align-items:center; justify-content:space-between;
  font:600 17px var(--cond); letter-spacing:.04em; color:var(--paper-ink);
  background:var(--paper); border:2px solid var(--paper-ink); border-radius:5px;
  /* top is inline-styled from the pitch band; easing it means the whole roll
     glides when a new chord widens the band instead of jumping */
  transition:background .1s ease, color .1s ease, transform .1s ease, top .3s cubic-bezier(.3,.8,.35,1);
}
.ce-roll-step{font-style:normal; font-weight:500; color:var(--paper-dim);}
/* a voice held over from the chord before */
.ce-root .ce-roll-note.held{border-style:dashed; background:transparent;}
.ce-root .ce-roll-note:hover{background:color-mix(in srgb, var(--paper-ink) 8%, var(--paper));}
.ce-root .ce-roll-note:active{transform:scale(.95);}
.ce-root .ce-roll-note:focus-visible{outline:2px solid var(--paper-ink); outline-offset:2px;}
/* lit per note, from its onset to its release — a block chord inks in together,
   an arpeggio walks up the column */
.ce-root .ce-roll-note.lit{background:var(--paper-ink); color:var(--paper); border-style:solid;}
.ce-roll-note.lit .ce-roll-step{color:color-mix(in srgb, var(--paper) 65%, transparent);}

/* a freshly chosen chord: its pills fly in from the future row that spawned them */
@keyframes ce-spawn{
  from{transform:translate(var(--dx), var(--dy)) scale(.5); opacity:0;}
  55%{opacity:1;}
  to{transform:none; opacity:1;}
}
.ce-root .ce-roll-note.spawn{animation:ce-spawn .34s cubic-bezier(.2,.85,.3,1) backwards; transition:none;}
@keyframes ce-settle{from{opacity:0; transform:translateY(-5px);} to{opacity:1; transform:none;}}
.ce-roll-tilewrap.spawn{animation:ce-settle .26s ease .19s backwards;}

.ce-roll-tilewrap{position:relative; display:flex; align-items:stretch; gap:4px;}
.ce-root .ce-roll-tile{
  flex:1 1 auto; min-width:0; position:relative;
  display:flex; flex-direction:column; align-items:center; gap:2px;
  padding:6px 4px 12px; border-radius:6px;
  cursor:grab; touch-action:none; user-select:none; transition:background .11s ease;
}
.ce-root .ce-roll-tile:hover{background:color-mix(in srgb, var(--paper-ink) 5%, transparent);}
.ce-root .ce-roll-tile:focus-visible{outline:2px solid var(--paper-ink); outline-offset:2px;}
/* the chord that's sounding gets a cursor under it */
.ce-roll-col.playing .ce-roll-tile::after{
  content:""; position:absolute; bottom:2px; left:50%; width:28px; margin-left:-14px; height:4px;
  background:var(--paper-ink); border-radius:1px;
}
.ce-chip-name{font:600 30px var(--din); letter-spacing:-.01em; white-space:nowrap;}
.ce-chip-slash{font-weight:500; color:var(--paper-dim);}
.ce-chip-roman{font:500 18px var(--cond); letter-spacing:.12em; color:var(--paper-dim); display:flex; gap:10px;}
.ce-chip-dist{letter-spacing:.02em;}

.ce-roll-col.dragging{z-index:3;}
.ce-roll-col.dragging .ce-roll-tile{cursor:grabbing; background:color-mix(in srgb, var(--paper-ink) 8%, transparent);}
.ce-root .ce-roll-col.dragging .ce-roll-note{border-width:3px;}

/* remove: quiet until you go looking for it, but always reachable by keyboard */
.ce-root .ce-roll-del{
  position:absolute; top:-6px; right:26px; z-index:2;
  width:24px; height:24px; line-height:1; font-size:18px;
  display:flex; align-items:center; justify-content:center;
  border:1.5px solid var(--paper-dim); border-radius:50%;
  background:var(--paper); color:var(--paper-dim);
  opacity:0; transition:opacity .12s ease, background .12s ease, color .12s ease;
}
.ce-roll-col:hover .ce-roll-del, .ce-roll-col:focus-within .ce-roll-del{opacity:1;}
.ce-root .ce-roll-del:hover{background:var(--paper-ink); border-color:var(--paper-ink); color:var(--paper);}
.ce-root .ce-roll-del:focus-visible{opacity:1;}
@media (hover:none){.ce-root .ce-roll-del{opacity:1;}}
.ce-roll-invert{display:flex; flex-direction:column; gap:4px; flex:0 0 auto;}
.ce-root .ce-inv-btn{
  display:flex; align-items:center; justify-content:center; flex:1 1 0; width:22px;
  border:1.5px solid var(--paper-rule); border-radius:5px; color:var(--paper-dim);
  transition:color .1s ease, border-color .1s ease;
}
.ce-root .ce-inv-btn:hover{color:var(--paper-ink); border-color:var(--paper-ink);}
.ce-root .ce-inv-btn:active{transform:scale(.9);}

/* transport: two short vertical banks beside the panel */
.ce-transport{display:flex; flex-direction:column; gap:12px; align-items:center;}
.ce-transport .ce-lbl{margin:0 0 -2px; text-align:center;}
.ce-transport .ce-lbl ~ .ce-lbl{margin-top:18px;}

/* --- futures -------------------------------------------------------------- */
.ce-futures{display:flex; flex-direction:column;}
.ce-fut-head{display:flex; align-items:center; gap:24px; margin-bottom:14px;}
.ce-fut-head .ce-mod-h{flex:1; margin:0; min-width:0;}
.ce-filter{
  display:flex; align-items:center; gap:12px; width:340px; flex:0 1 auto;
  border-bottom:1.5px solid var(--seam); padding:4px 2px 6px;
  font:500 22px var(--din); color:var(--print);
}
.ce-filter:focus-within{border-color:var(--ink);}
.ce-filter svg{width:20px; height:20px; flex:none;}
.ce-filter input{border:0; background:none; font:inherit; color:var(--ink); width:100%; min-width:0; outline:none; -webkit-appearance:none; appearance:none;}
.ce-filter input::placeholder{color:var(--print2);}
.ce-filter input::-webkit-search-cancel-button{cursor:pointer;}
.ce-futures-count{font:500 18px var(--cond); color:var(--print); letter-spacing:.04em; white-space:nowrap;}

.ce-futures-note{display:flex; flex-wrap:wrap; align-items:center; gap:12px; margin:12px 0 0; padding:0 14px; font-size:18px; color:var(--print);}
.ce-root .ce-futures-hint{
  font:600 17px var(--cond); letter-spacing:.06em; color:var(--ink);
  padding:6px 12px; border-radius:6px; border:1.5px dashed var(--seam);
}
.ce-root .ce-futures-hint:hover{border-color:var(--ink); border-style:solid;}
.ce-futures-list{display:flex; flex-direction:column;}

.ce-root .ce-future{
  display:grid; grid-template-columns:130px 110px 100px 190px 60px minmax(0,1fr);
  gap:24px; align-items:center; width:100%; text-align:left;
  padding:12px 14px; border-radius:6px; font:500 22px var(--din); color:var(--ink);
  transition:background .1s ease, transform .1s ease;
}
.ce-futures-list .ce-future + .ce-future{box-shadow:0 -1.5px 0 #EFEFEA;}
.ce-root .ce-future:hover{background:#F6F6F2;}
.ce-root .ce-future.head{font:500 18px var(--cond); letter-spacing:.14em; text-transform:uppercase; color:var(--print); cursor:default; padding-top:0;}
.ce-root .ce-future.head:hover{background:none;}
.ce-future.head > span{font:inherit;}
.ce-root .ce-futures-axis{font:inherit; letter-spacing:inherit; text-transform:inherit; color:inherit; justify-self:start;}
.ce-root .ce-futures-axis:hover{color:var(--ink);}

/* what the chord does and how hard it pulls, in one block */
.ce-fu-tension{display:flex; flex-direction:column; gap:5px;}
.ce-fu-func{font:600 12.5px var(--cond); letter-spacing:.16em; text-transform:uppercase; color:var(--print); line-height:1;}
.ce-fu-meter{display:flex; gap:3px;}
.ce-fu-meter i{width:8px; height:8px; background:var(--unlit); border-radius:1px;}
.ce-fu-meter i.lit{background:var(--lamp); box-shadow:0 0 4px var(--lamp-glow);}
/* the name is the audition target — give it a hit area and say so on hover */
.ce-fu-name{
  font-weight:600; font-size:28px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  justify-self:start; max-width:100%; padding:0 6px; margin:0 -6px; border-radius:5px;
  transition:color .12s ease;
}
.ce-fu-name:hover{color:var(--lamp);}
.ce-fu-roman{font-family:var(--cond); color:var(--print); letter-spacing:.04em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
.ce-fu-notes{font-family:var(--cond); color:var(--print); letter-spacing:.06em; font-size:21px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
.ce-fu-dist{font-family:var(--cond); color:var(--print); font-size:21px; white-space:nowrap;}
.ce-fu-move{color:#4A4A45; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
.ce-future:hover .ce-fu-notes, .ce-future:hover .ce-fu-move{color:var(--ink);}
.ce-fu-res{font:600 16px var(--cond); letter-spacing:.14em; text-transform:uppercase; color:var(--lamp); margin-left:12px;}

/* choosing: the rest of the futures clear out, the chosen one flies to the roll */
@keyframes ce-assemble{from{opacity:0; transform:translateY(5px);} to{opacity:1; transform:none;}}
.ce-futures-list .ce-future{animation:ce-assemble .24s ease backwards; animation-delay:calc(var(--i) * 15ms);}
@keyframes ce-fu-leave{to{opacity:0; transform:translateX(14px);}}
@keyframes ce-fu-chosen{
  30%{transform:translateX(-4px) scale(1.02);}
  to{opacity:0; transform:translateX(-26px) scale(.94);}
}
.ce-root .ce-future.leaving{animation:ce-fu-leave .17s ease forwards; pointer-events:none;}
.ce-root .ce-future.chosen{animation:ce-fu-chosen .17s ease forwards; pointer-events:none; background:#F6F6F2;}

/* --- sound ---------------------------------------------------------------- */
.ce-snd-top{display:flex; flex-wrap:wrap; gap:18px 36px; align-items:flex-end; margin-bottom:30px;}
.ce-snd-note{flex:1 1 280px; max-width:60ch; padding-bottom:12px;}
.ce-snd-cols{display:grid; grid-template-columns:repeat(5, minmax(0,1fr));}
.ce-snd-col{padding:0 30px; min-width:0;}
.ce-snd-col + .ce-snd-col{box-shadow:-1.5px 0 0 var(--seam);}
.ce-snd-col:first-child{padding-left:0;}
.ce-snd-col:last-child{padding-right:0;}
.ce-snd-h{margin:0 0 20px; font:600 20px var(--cond); letter-spacing:.16em; text-transform:uppercase; color:var(--print2);}
.ce-snd-col .ce-bg{display:flex;}
.ce-root .ce-snd-col .ce-bg > button{min-width:0; flex:1; padding:0;}

/* TensionCurve, parked (see the component) */
.ce-curve{width:100%; height:46px; display:block; margin:2px 0 12px;}
.ce-curve-base{stroke:var(--seam); stroke-width:.5; stroke-dasharray:1.5 1.5;}
.ce-curve-line{fill:none; stroke:var(--ink); stroke-width:1; opacity:.55; vector-effect:non-scaling-stroke;}

/* --- narrower: two columns, then one ------------------------------------- */
@media (max-width:1400px){
  .ce-chassis{grid-template-columns:1fr 1fr; grid-template-areas:
    "plate plate" "key gen" "play out" "disp disp" "fut fut" "snd snd";}
  .ce-snd-cols{grid-template-columns:repeat(2, minmax(0,1fr)); row-gap:36px;}
  .ce-snd-col{padding:0 20px;}
  .ce-snd-col:nth-child(odd){padding-left:0; box-shadow:none;}
  .ce-root .ce-future{grid-template-columns:130px 110px 100px 190px 60px;}
  .ce-fu-move{display:none;}
}
@media (max-width:900px){
  .ce-chassis{grid-template-columns:1fr; grid-template-areas:
    "plate" "key" "gen" "play" "out" "disp" "fut" "snd";}
  .ce-mod{padding:20px 20px 24px;}
  .ce-plate{gap:20px; padding:18px 20px;}
  .ce-grille, .ce-leds{display:none;}
  /* the keyboard fills the module rather than running off its edge */
  .ce-keys{width:100%; grid-template-columns:repeat(14, minmax(0,1fr));}
  .ce-root .ce-keys > button{font-size:17px;}
  .ce-plate h1{margin-right:auto;}
  .ce-m-disp{grid-template-columns:minmax(0,1fr);}
  .ce-screen{padding:18px;}
  .ce-transport{flex-direction:row; flex-wrap:wrap; align-items:center;}
  .ce-transport .ce-lbl, .ce-transport .ce-lbl ~ .ce-lbl{margin:0;}
  /* the notes and the degree are the droppable columns — the name stays whole */
  .ce-fu-notes, .ce-fu-roman{display:none;}
  .ce-root .ce-future{grid-template-columns:130px minmax(0,1fr) 60px; gap:16px; padding:10px 6px;}
  .ce-fut-head{flex-wrap:wrap;}
  .ce-filter{width:100%;}
  .ce-snd-cols{grid-template-columns:minmax(0,1fr);}
  .ce-root .ce-snd-col{padding:0; box-shadow:none;}
  .ce-snd-col + .ce-snd-col{margin-top:30px;}
}
@media (prefers-reduced-motion:reduce){
  .ce-root .ce-future{transition:none;}
  .ce-futures-list .ce-future,
  .ce-root .ce-future.leaving, .ce-root .ce-future.chosen,
  .ce-root .ce-roll-note.spawn, .ce-roll-tilewrap.spawn{animation:none;}
  .ce-root .ce-roll-note{transition:none;}
}
`;
