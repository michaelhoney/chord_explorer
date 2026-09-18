import React, { useState, useMemo, useRef, useCallback, useEffect, useLayoutEffect } from "react";
import * as Tone from "tone";
import {
  SHARP,
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
const HUE_LABEL = {
  home: "Home",
  build: "Build",
  tension: "Tension",
  outside: "Outside",
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
  const [soundOpen, setSoundOpen] = useState(false);
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

  return (
    <div className="ce-root">
      <style>{CSS}</style>

      <header className="ce-head">
        <div className="ce-topline">
          <div className="ce-brand">
            <span className="ce-mark" aria-hidden="true">↳</span>
            <div>
              <h1>Chord Paths</h1>
              <p className="ce-sub">
                Pick a chord, hear it, and follow where it wants to go.
              </p>
            </div>
          </div>

          {/* sharing is about the page, not about editing the progression, so it
              sits up here rather than in the transport */}
          <button
            className={"ce-share" + (copied ? " copied" : "")}
            onClick={share}
            disabled={!prog.length}
            aria-label={copied ? "Link copied" : "Copy a link to this progression"}
            title={copied ? "Link copied" : "Copy a link to this progression"}
          >
            {copied ? <Tick /> : <ShareIcon />}
          </button>
        </div>

        {/* the controls and the sound panel share a wrapper so the concertina
            can sit flush when it's closed — .ce-head's row gap would otherwise
            leave a permanent strip of dead space under the control row */}
        <div className="ce-console">
        <div className="ce-controls">
          {/* what chords there are to choose from, and one that picks for you */}
          <div className="ce-cgroup">
          <label className="ce-field">
            <span>Key</span>
            <select
              value={root}
              onChange={(e) => changeKey(Number(e.target.value), mode)}
            >
              {SHARP.map((_, i) => (
                <option key={i} value={i}>
                  {nameOf(i, i)}
                </option>
              ))}
            </select>
          </label>

          <div className="ce-seg" role="group" aria-label="Mode">
            {[["major", "major"], ["minor", "minor"], ["mixolydian", "mixo"]].map(([m, label]) => (
              <button
                key={m}
                className={mode === m ? "on" : ""}
                aria-pressed={mode === m}
                title={m}
                onClick={() => changeKey(root, m)}
              >
                {label}
              </button>
            ))}
          </div>

          <button
            className={"ce-toggle" + (add7 ? " on" : "")}
            aria-pressed={add7}
            onClick={() => setAdd7((v) => !v)}
            title="Add sevenths to the diatonic chords"
          >
            7ths
          </button>

          <button
            className={"ce-toggle" + (susOn ? " on" : "")}
            aria-pressed={susOn}
            onClick={() => setSusOn((v) => !v)}
            title="Offer suspended chords (sus2 / sus4) that resolve to their triad"
          >
            Sus
          </button>

          <span className="ce-suggest">
            <button
              className="ce-toggle"
              onClick={suggest}
              title={`Propose a ${bars}-bar loop — click again to re-roll. The one it replaces stays in the history; while playing, it waits for the loop to come round.`}
            >
              Suggest
            </button>
            <select
              value={bars}
              onChange={(e) => setBars(Number(e.target.value))}
              aria-label="Bars in a suggested loop"
              title="How many bars the suggestion should be"
            >
              {[2, 4, 8].map((b) => (
                <option key={b} value={b}>{b} bars</option>
              ))}
            </select>
          </span>

          <span className="ce-suggest">
            <button
              className="ce-toggle"
              onClick={mutate}
              disabled={prog.length < 2}
              title={`Change ${MUT_LEVELS[mutLevel - 1][1]}${mutLevel < 4 ? ", keeping bar 1 and your edits" : ""}. The original stays in the history; while playing, the change waits for the loop to come round.`}
            >
              Mutate
            </button>
            <select
              value={mutLevel}
              onChange={(e) => setMutLevel(Number(e.target.value))}
              aria-label="How much a mutation changes"
              title="How much Mutate changes — Evolve uses this too"
            >
              {MUT_LEVELS.map(([label], i) => (
                <option key={i} value={i + 1}>{label}</option>
              ))}
            </select>
          </span>
          </div>

          {/* how the progression sounds when it plays */}
          <div className="ce-cgroup">
          <button
            className={"ce-toggle" + (voiceLead ? " on" : "")}
            aria-pressed={voiceLead}
            onClick={() => setVoiceLead((v) => !v)}
            title="Use inversions to minimise the distance each voice moves between chords"
          >
            Voice-leading
          </button>

          <button
            className={"ce-toggle" + (bassOn ? " on" : "")}
            aria-pressed={bassOn}
            onClick={() => setBassOn((v) => !v)}
            title="Add a bass voice under each chord: the root, unless a tile's arrows pick another chord tone. It moves to the nearest octave, like a bass line"
          >
            Bass
          </button>

          {/* Arpeggio and what shapes it, kept together so they wrap as one.
              Provisional layout — this is due a design pass. */}
          <span className="ce-arp">
            <button
              className={"ce-toggle" + (arp ? " on" : "")}
              aria-pressed={arp}
              onClick={() => setArp((v) => !v)}
              title="Play each chord one note at a time, spread evenly across its slot"
            >
              Arpeggio
            </button>
            <button
              className={"ce-toggle" + (arpFour ? " on" : "")}
              aria-pressed={arpFour}
              disabled={!arp}
              onClick={() => setArpFour((v) => !v)}
              title="Four steps per chord: a three-note chord plays 1 3 5 3, so every chord keeps the same rhythm"
            >
              -4-
            </button>
            <span className="ce-seg" role="group" aria-label="Arpeggio order">
              {[["rise", "Low to high"], ["random", "A new random order each time the chord plays"]].map(([o, hint]) => (
                <button
                  key={o}
                  className={arpOrder === o ? "on" : ""}
                  aria-pressed={arpOrder === o}
                  disabled={!arp}
                  title={hint}
                  onClick={() => setArpOrder(o)}
                >
                  {o}
                </button>
              ))}
            </span>
            <button
              className={"ce-toggle" + (holdBass ? " on" : "")}
              aria-pressed={holdBass}
              disabled={!arp || !bassOn}
              onClick={() => setHoldBass((v) => !v)}
              title={bassOn
                ? "Hold the bass for the whole chord under the arpeggio, instead of playing it as the arpeggio's first step"
                : "Holds the bass under the arpeggio — turn Bass on to use it"}
            >
              hold bass
            </button>
          </span>

          <button
            className={"ce-toggle" + (loop ? " on" : "")}
            aria-pressed={loop}
            onClick={() => setLoop((v) => !v)}
            title="Repeat the progression until you press Stop"
          >
            Loop
          </button>

          <button
            className={"ce-toggle" + (evolve ? " on" : "")}
            aria-pressed={evolve}
            disabled={!loop}
            onClick={() => setEvolve((v) => !v)}
            title={loop
              ? "Mutate the progression every time the loop comes round, so it keeps changing while it plays. Every version stays in the history"
              : "Mutates the loop each time it comes round — turn Loop on to use it"}
          >
            Evolve
          </button>

          <label className="ce-field">
            <span>Output</span>
            {midi.status === "ready" ? (
              <select
                value={midi.portId}
                title="Send notes to an external instrument instead of the built-in synth"
                onChange={(e) => {
                  midiPanic(); // silence the port we're leaving, mid-note or not
                  midi.setPortId(e.target.value);
                }}
              >
                <option value="">Internal synth</option>
                {midi.outputs.length ? (
                  midi.outputs.map((o) => (
                    <option key={o.id} value={o.id}>{o.name}</option>
                  ))
                ) : (
                  <option disabled>No MIDI outputs found</option>
                )}
              </select>
            ) : (
              <button
                className="ce-toggle ce-midi"
                onClick={midi.enable}
                disabled={MIDI_STATUS[midi.status].dead}
                title={MIDI_STATUS[midi.status].hint}
              >
                {MIDI_STATUS[midi.status].label}
              </button>
            )}
          </label>

          <label className="ce-field ce-tempo">
            <span>Tempo {tempo}</span>
            <input
              type="range" min="60" max="140" value={tempo}
              onChange={(e) => setTempo(Number(e.target.value))}
            />
          </label>

          {/* opens the concertina below — a playback preference like the rest
              of this group, just one with sixteen knobs behind it */}
          <button
            className={"ce-toggle ce-sound-btn" + (soundOpen ? " on" : "")}
            aria-expanded={soundOpen}
            aria-controls="ce-sound-panel"
            onClick={() => setSoundOpen((v) => !v)}
            title="Shape the built-in synth — waveform, envelope, filter and its LFO, space"
          >
            Sound<span className="ce-chev" aria-hidden="true">▾</span>
          </button>
          </div>
          </div>

          <SoundPanel
            open={soundOpen}
            sound={sound}
            setSound={setSound}
            onAudition={auditionSound}
            midiActive={midiActive}
          />
        </div>
      </header>

      {/* progression + tension curve */}
      <section className="ce-track">
        <div className="ce-track-head">
          <span className="ce-eyebrow">
            Progression
            {prog.length > 1 && (
              <span className="ce-total-motion" title="Total semitones of voice movement across the progression — lower is smoother">
                {" · "}Δ{totalMotion} total
              </span>
            )}
          </span>
          <div className="ce-transport">
            <button
              onClick={playAll}
              disabled={!prog.length}
              className={playing ? "ce-playing" : ""}
            >
              {playing ? "■ Stop" : "▶ Play"}
            </button>
            <button onClick={undo} disabled={!prog.length}>Undo</button>
            <button onClick={clear} disabled={!prog.length}>Clear</button>
          </div>
        </div>

        {/* every progression this visit, oldest on the left; what's queued for
            when the loop comes round sits on the right, dashed */}
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
                    title={i === hist.cur
                      ? playing && queued ? "Stay on this one: drop what's waiting" : "Playing now"
                      : playing ? "Play this one when the loop comes round" : "Go back to this one"}
                  >
                    {waiting && <span className="ce-gen-tag">next</span>}
                    <GenNames prog={g} />
                  </button>
                </li>
              );
            })}
            {liveRef.current.next && queued.kind !== "goto" && (
              <li>
                <span
                  className="ce-gen ghost"
                  title={queued.auto ? "Evolve: plays when the loop comes round" : "Plays when the loop comes round"}
                >
                  <span className="ce-gen-tag">next</span>
                  <GenNames prog={nextProg} against={prog} />
                </span>
              </li>
            )}
          </ol>
        )}

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

        <div className="ce-stage">
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
              <p className="ce-empty">
                Pick a chord below — it plays, and the roll starts here.
              </p>
            )}
          </div>

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
        </div>
      </section>

      <footer className="ce-legend">
        {["home", "build", "tension", "outside"].map((h) => (
          <span key={h} className="ce-leg">
            <i style={{ background: HUE[h] }} />
            {HUE_LABEL[h]}
          </span>
        ))}
        <span className="ce-leg-note">Colour shows what a chord does to the harmony.</span>
      </footer>
    </div>
  );
}

// ------------------------------------------------------------------------
//  SOUND — the synth, with the lid off
// ------------------------------------------------------------------------
// One control per parameter, read straight off SYNTH_PARAMS, so adding a knob
// is a line in the table rather than a line of markup. Every slider runs
// 0–1000 whatever it controls (see paramToPos) — which is meaningless to read
// aloud, hence aria-valuetext carrying the formatted value instead.
function Knob({ k, value, onChange, onCommit }) {
  const p = SYNTH_PARAMS[k];
  if (p.kind === "enum") {
    return (
      <label className="ce-knob ce-knob-enum" title={p.hint}>
        <span className="ce-knob-top"><em>{p.label}</em></span>
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {p.options.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label className="ce-knob" title={p.hint}>
      <span className="ce-knob-top">
        <em>{p.label}</em>
        <b>{formatParam(k, value)}</b>
      </span>
      <input
        type="range" min="0" max="1000" step="1"
        value={paramToPos(k, value)}
        aria-label={p.label}
        aria-valuetext={formatParam(k, value)}
        onChange={(e) => onChange(paramFromPos(k, Number(e.target.value)))}
        // audition on release, not on every frame of the drag
        onPointerUp={onCommit}
        onKeyUp={onCommit}
      />
    </label>
  );
}

// A concertina rather than a popover or a separate page: the sound is part of
// the same instrument as the key and the tempo, and opening it should push the
// page down rather than float over the progression you're listening to. The
// 0fr→1fr grid transition is what makes that animate without a measured height.
function SoundPanel({ open, sound, setSound, onAudition, midiActive }) {
  const preset = presetNameFor(sound);
  const set = (k) => (v) => setSound((s) => ({ ...s, [k]: v }));
  return (
    <div className={"ce-sound" + (open ? " open" : "")} id="ce-sound-panel">
      <div className="ce-sound-clip">
        {/* inert, not just hidden: a collapsed panel shouldn't collect tab stops */}
        <div className="ce-sound-inner" inert={!open}>
          <div className="ce-sound-head">
            <label className="ce-field">
              <span>Preset</span>
              <select
                value={preset ?? "custom"}
                title="A starting point — every slider below is still yours afterwards"
                onChange={(e) => setSound({ ...PRESETS[e.target.value] })}
              >
                {Object.keys(PRESETS).map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
                {/* only offered as a readout of where you are; picking it is a no-op */}
                {!preset && <option value="custom" disabled>Custom</option>}
              </select>
            </label>
            <p className="ce-sound-note">
              {midiActive
                ? "Routed to MIDI — Dynamics and Humanise still go out the port; the rest shapes the built-in synth."
                : "Shapes the built-in synth. Drag a slider and release it to hear the chord you're on."}
            </p>
          </div>

          <div className="ce-sound-grid">
            {SYNTH_GROUPS.map((g) => (
              <div className="ce-sgroup" key={g.name}>
                <h4 className="ce-eyebrow">{g.name}</h4>
                {g.keys.map((k) => (
                  <Knob
                    key={k}
                    k={k}
                    value={sound[k]}
                    onChange={set(k)}
                    onCommit={onAudition}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------
//  FUTURES — every chord that could come next, one line each, most tense first
// ------------------------------------------------------------------------
const MAX_TENSION = 4.5; // the top of the tension meter, matching the engine's range

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
      <div className="ce-futures-head">
        <span className="ce-eyebrow">
          {current ? `Where to next from ${current.name}?` : "Start on any chord"}
        </span>
        <span className="ce-futures-tools">
          <input
            className="ce-filter"
            type="search"
            value={query}
            placeholder="Filter…"
            aria-label="Filter the chords by name or roman numeral"
            title="Filter by name or roman numeral — “sus”, “♭VII”, “F♯”. Enter picks the top match."
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {filtering && (
            <span className="ce-futures-count">{options.length}/{total}</span>
          )}
          <button
            type="button"
            className="ce-futures-axis"
            onClick={onFlipSort}
            aria-label={`Sorted by tension, ${tensionDesc ? "most tense first" : "least tense first"}. Flip the order.`}
            title={
              (tensionDesc ? "Most tense first" : "Least tense first") +
              " — click to flip the order"
            }
          >
            tension {tensionDesc ? "↓" : "↑"}
          </button>
        </span>
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
          {!options.length && (
            <span>Nothing here matches “{query.trim()}”.</span>
          )}
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
  return (
    <button
      ref={ref}
      type="button"
      className={
        "ce-future" + (opt.resolution ? " resolve" : "") + (state ? " " + state : "")
      }
      style={{ "--c": HUE[hueOf(opt.func)], "--i": i, "--t": opt.tension / MAX_TENSION }}
      onClick={() => onPick(opt, ref.current)}
      title={
        `${opt.name} — ${notes}` +
        (opt.motion ? ` · root ${opt.motion}` : "") +
        `\n${opt.move}`
      }
    >
      <span className="ce-fu-tension" aria-hidden="true"><i /></span>
      {/* hovering auditions the chord — the name alone, so reading a row is silent */}
      <span className="ce-fu-name" onMouseEnter={() => onPreview(opt)}>{opt.name}</span>
      <span className="ce-fu-roman">{opt.roman}</span>
      <span className="ce-fu-notes">{notes}</span>
      <span className="ce-fu-dist">
        {dist != null && (
          <span
            className={"ce-chip-dist" + (dist <= 2 ? " smooth" : dist >= 7 ? " far" : "")}
            title={`${dist} semitone${dist === 1 ? "" : "s"} of voice movement from the current chord`}
          >
            Δ{dist}
          </span>
        )}
      </span>
      <span className="ce-fu-move">{opt.move}</span>
    </button>
  );
}

// piano-roll progression: each voice sits at its pitch height, so common tones
// line up across columns and the voice leading is visible. Faint connectors trace
// each voice from one chord to the next; the chord tile sits underneath.
const ROLL = { ROW: 11, CELL: 18, COL: 84, GAP: 10, LANE: 16 }; // px per semitone, pill, column, gap, gap above the bass lane

// semitone step as a sequencer would read it: +2, -3, 0 for a held voice
const signed = (n) => (n > 0 ? `+${n}` : `${n}`);
const stepTitle = (n) =>
  n === 0
    ? "this voice holds"
    : `this voice moves ${signed(n)} semitone${Math.abs(n) === 1 ? "" : "s"}`;

const ShareIcon = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false"
       fill="none" stroke="currentColor" strokeWidth="1.5"
       strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="3.6" r="2.1" />
    <circle cx="4" cy="8" r="2.1" />
    <circle cx="12" cy="12.4" r="2.1" />
    <path d="M5.9 6.9 L10.1 4.7 M5.9 9.1 L10.1 11.3" />
  </svg>
);

const Tick = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false"
       fill="none" stroke="currentColor" strokeWidth="1.9"
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

// a generation as a strip of chord names, each underlined in its function's
// colour; against another progression, the bars that differ are marked
function GenNames({ prog, against }) {
  if (!prog.length) return <span className="ce-gen-empty">empty</span>;
  return prog.map((c, i) => (
    <span
      key={i}
      className={"ce-gen-chord" + (against && against[i]?.name !== c.name ? " changed" : "")}
      style={{ "--c": HUE[hueOf(c.func)] }}
    >
      {c.name}
    </span>
  ));
}

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
  const cx = (i) => i * (COL + GAP) + COL / 2; // column centre
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

  // connectors: pair voices by ascending pitch order across adjacent chords
  const links = [];
  for (let i = 0; i < voicings.length - 1; i++) {
    const a = [...voicings[i]].sort((p, q) => p - q);
    const b = [...voicings[i + 1]].sort((p, q) => p - q);
    for (let v = 0; v < Math.min(a.length, b.length); v++) {
      links.push({
        x1: cx(i), y1: cy(a[v]), x2: cx(i + 1), y2: cy(b[v]), held: a[v] === b[v],
      });
    }
    if (hasBass) {
      links.push({
        x1: cx(i), y1: bassTop(bass[i]) + CELL / 2,
        x2: cx(i + 1), y2: bassTop(bass[i + 1]) + CELL / 2,
        held: bass[i] === bass[i + 1],
      });
    }
  }

  return (
    <div className="ce-roll-scroll">
      <div className="ce-roll-inner" style={{ width }}>
        <svg className="ce-roll-links" width={width} height={rollH} aria-hidden="true">
          {hasBass && (
            <line
              className="ce-roll-lane"
              x1={0} x2={width} y1={bandH + ROLL.LANE / 2} y2={bandH + ROLL.LANE / 2}
            />
          )}
          {links.map((l, k) => (
            <line
              key={k}
              x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
              className={"ce-roll-link" + (l.held ? " held" : "")}
            />
          ))}
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
            return (
              <div
                key={c.id}
                className={
                  "ce-roll-col" +
                  (i === playingIdx ? " playing" : "") +
                  (i === dragIdx ? " dragging" : "")
                }
                style={{ "--c": HUE[hueOf(c.func)], width: COL }}
              >
                <span className="ce-roll-notes" style={{ height: rollH }}>
                  {[...midi].sort((a, b) => a - b).map((m, v) => {
                    const step = steps ? steps.get(m) : undefined;
                    return (
                      <button
                        key={m}
                        type="button"
                        className={
                          "ce-roll-note" +
                          (prevSet && prevSet.has(m) ? " held" : "") +
                          (i === playingIdx && lit.has(m) ? " lit" : "") +
                          (born ? " spawn" : "")
                        }
                        // --dx / --dy are measured after layout, in the parent
                        style={{
                          top: topOf(m),
                          // the bass lands first, so the chord builds upward
                          ...(born ? { animationDelay: `${(v + (hasBass ? 1 : 0)) * 52}ms` } : null),
                        }}
                        onClick={() => onPlayNote(m)}
                        title={
                          `Play ${Tone.Frequency(m, "midi").toNote()}` +
                          (step == null ? "" : ` · ${stepTitle(step)}`)
                        }
                      >
                        {nameOf(mod12(m), keyRoot)}
                        {step != null && <span className="ce-roll-step">{signed(step)}</span>}
                      </button>
                    );
                  })}
                  {hasBass && (() => {
                    const m = bass[i];
                    const step = i > 0 ? m - bass[i - 1] : null;
                    return (
                      <button
                        type="button"
                        className={
                          "ce-roll-note bass" +
                          (i > 0 && bass[i - 1] === m ? " held" : "") +
                          (i === playingIdx && lit.has(m) ? " lit" : "") +
                          (born ? " spawn" : "")
                        }
                        style={{ top: bassTop(m) }}
                        onClick={() => onPlayNote(m)}
                        title={
                          `Play ${Tone.Frequency(m, "midi").toNote()} · bass` +
                          (step == null ? "" : ` · ${stepTitle(step)}`)
                        }
                      >
                        {nameOf(mod12(m), keyRoot)}
                        {step != null && <span className="ce-roll-step">{signed(step)}</span>}
                      </button>
                    );
                  })()}
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
                    <span className="ce-chip-roman">{c.roman}</span>
                    {/* the first chord has nothing to measure from — hold the slot
                        open with a ghost so every tile is the same height */}
                    {dist != null ? (
                      <span
                        className={"ce-chip-dist" + (dist <= 2 ? " smooth" : dist >= 7 ? " far" : "")}
                        title={`${dist} semitone${dist === 1 ? "" : "s"} of voice movement from the previous chord`}
                      >
                        Δ{dist}
                      </span>
                    ) : (
                      <span className="ce-chip-dist ce-chip-ghost" aria-hidden="true">Δ0</span>
                    )}
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
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap');

.ce-root{
  --bg:#E7E1D4; --panel:#F3EEE4; --ink:#221E18; --muted:#6E665A;
  --line:rgba(34,30,24,.12); --line2:rgba(34,30,24,.07);
  --home:#3D9A80; --build:#D69A38; --tension:#D6553F; --outside:#7C6BC4;
  --disp:'Space Grotesk',system-ui,sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,Menlo,monospace;
  background:var(--bg); color:var(--ink); font-family:var(--disp);
  padding:20px; border-radius:16px; max-width:1180px; margin:0 auto;
  -webkit-font-smoothing:antialiased;
}
.ce-root *{box-sizing:border-box;}
.ce-root h1{font-size:22px; font-weight:700; letter-spacing:-.02em; margin:0;}
.ce-sub{margin:2px 0 0; font-size:12.5px; color:var(--muted); max-width:46ch; line-height:1.4;}

/* Three zones, reading down: who this is (and the share action for the page),
   then what chords there are, then how they sound. The transport — play and
   edit what's already there — lives with the progression itself. */
.ce-head{display:flex; flex-direction:column; gap:16px;}
.ce-topline{display:flex; gap:16px; justify-content:space-between; align-items:flex-start;}
.ce-brand{display:flex; gap:12px; align-items:flex-start;}

.ce-share{
  flex:0 0 auto; display:inline-flex; align-items:center; justify-content:center;
  width:32px; height:32px; padding:0; border-radius:9px;
  border:1px solid var(--line); background:var(--panel); color:var(--muted);
  cursor:pointer; transition:background .12s ease, color .12s ease, border-color .12s ease;
}
.ce-share:hover:not(:disabled){background:var(--bg); color:var(--ink); border-color:var(--ink);}
.ce-share:focus-visible{outline:2px solid var(--ink); outline-offset:2px;}
.ce-share:disabled{opacity:.35; cursor:default;}
.ce-share.copied:not(:disabled){background:var(--home); border-color:var(--home); color:var(--panel);}
.ce-mark{font-size:26px; line-height:1; color:var(--tension); transform:translateY(2px);}

/* chord population on the left, playback preferences pushed right */
.ce-controls{display:flex; flex-wrap:wrap; gap:14px 24px; align-items:flex-end;}
.ce-cgroup{display:flex; flex-wrap:wrap; gap:10px; align-items:flex-end;}
/* margin, not justify-content:space-between — when the two groups wrap onto
   separate rows, space-between leaves the playback group stranded left */
.ce-cgroup + .ce-cgroup{margin-left:auto;}
.ce-field{display:flex; flex-direction:column; gap:4px;}
.ce-field>span{font-family:var(--mono); font-size:10px; text-transform:uppercase; letter-spacing:.09em; color:var(--muted);}
.ce-field select{
  font-family:var(--mono); font-size:14px; padding:7px 10px; border-radius:9px;
  border:1px solid var(--line); background:var(--panel); color:var(--ink); cursor:pointer;
}
.ce-tempo input{width:118px; accent-color:var(--ink); cursor:pointer;}

.ce-seg{display:inline-flex; background:var(--panel); border:1px solid var(--line); border-radius:9px; overflow:hidden;}
.ce-seg button{
  font-family:var(--mono); font-size:12px; text-transform:capitalize;
  padding:8px 12px; border:0; background:transparent; color:var(--muted); cursor:pointer;
}
.ce-seg button.on{background:var(--ink); color:var(--panel);}
.ce-toggle{
  font-family:var(--mono); font-size:12px; padding:8px 13px; border-radius:9px;
  border:1px solid var(--line); background:var(--panel); color:var(--muted); cursor:pointer; align-self:flex-end;
}
.ce-toggle.on{background:var(--ink); color:var(--panel); border-color:var(--ink);}
.ce-midi{align-self:auto;} /* sits under a field label, not flush with the toggle row */
.ce-arp{display:inline-flex; gap:6px; align-items:stretch; align-self:flex-end;}
.ce-arp .ce-toggle{align-self:auto;}
.ce-arp button:disabled{opacity:.4; cursor:default;}
.ce-midi:disabled{opacity:.5; cursor:default;}

/* --- the sound concertina -------------------------------------------------
   Opening it pushes the page down rather than floating over the progression,
   so it stays in normal flow. Animating to height:auto isn't a thing, but a
   grid row animating 0fr -> 1fr is, and it needs no measured height — so the
   panel can grow or shrink with its own content and still slide. All the
   padding and the border live on the inner element: anything on the outer
   would refuse to collapse to nothing when closed. */
.ce-console{display:flex; flex-direction:column;}
.ce-sound{
  display:grid; grid-template-rows:0fr;
  transition:grid-template-rows .3s cubic-bezier(.3,.8,.35,1);
}
.ce-sound.open{grid-template-rows:1fr;}
/* contain:layout is for WebKit — without it the last frame of the transition
   can flicker on a retina display. It changes nothing elsewhere: overflow
   already made this a containing block. */
.ce-sound-clip{overflow:hidden; min-height:0; contain:layout;}
.ce-sound-inner{
  margin-top:16px; padding:14px 16px; border-radius:13px;
  background:var(--panel); border:1px solid var(--line);
  opacity:0; transition:opacity .18s ease .05s;
}
.ce-sound.open .ce-sound-inner{opacity:1;}
.ce-sound-btn{display:inline-flex; align-items:center; gap:6px;}
.ce-chev{font-size:9px; line-height:1; transition:transform .25s ease;}
.ce-sound-btn.on .ce-chev{transform:rotate(180deg);}

.ce-sound-head{display:flex; flex-wrap:wrap; gap:8px 18px; align-items:flex-end; margin-bottom:14px;}
.ce-sound-note{margin:0; font-size:11.5px; color:var(--muted); line-height:1.45; max-width:58ch; flex:1 1 260px;}

/* auto-fit rather than a fixed column count: the five groups sit in one row on
   a wide screen and reflow to two or one without a breakpoint each */
.ce-sound-grid{display:grid; grid-template-columns:repeat(auto-fit, minmax(178px, 1fr)); gap:16px 22px;}
.ce-sgroup{display:flex; flex-direction:column; gap:8px; min-width:0;}
.ce-sgroup h4{margin:0 0 1px; font-weight:500;}
.ce-knob{display:flex; flex-direction:column; gap:3px; cursor:pointer;}
.ce-knob-top{display:flex; justify-content:space-between; align-items:baseline; gap:8px; font-family:var(--mono); font-size:10.5px;}
.ce-knob-top em{font-style:normal; color:var(--muted); letter-spacing:.04em;}
/* tabular figures so a value counting up doesn't jiggle the label beside it */
.ce-knob-top b{font-weight:500; color:var(--ink); font-variant-numeric:tabular-nums;}
.ce-knob input[type=range]{width:100%; margin:0; accent-color:var(--ink); cursor:pointer;}
.ce-knob-enum select{
  font-family:var(--mono); font-size:12px; padding:5px 8px; border-radius:8px;
  border:1px solid var(--line); background:var(--bg); color:var(--ink); cursor:pointer; width:100%;
}

@media (prefers-reduced-motion: reduce){
  .ce-sound, .ce-sound-inner, .ce-chev{transition:none;}
}

.ce-eyebrow{font-family:var(--mono); font-size:10px; text-transform:uppercase; letter-spacing:.12em; color:var(--muted);}

.ce-track{margin-top:20px; background:var(--panel); border:1px solid var(--line); border-radius:13px; padding:14px 16px;}
.ce-track-head{display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;}
.ce-total-motion{font-family:var(--mono); font-size:10px; color:var(--muted); letter-spacing:0; text-transform:none; font-weight:600;}
.ce-transport{display:flex; gap:6px;}
.ce-transport button{
  font-family:var(--mono); font-size:12px; padding:6px 11px; border-radius:8px;
  border:1px solid var(--line); background:var(--bg); color:var(--ink); cursor:pointer;
}
.ce-transport button:disabled{opacity:.4; cursor:default;}
.ce-suggest{display:inline-flex; align-items:stretch; align-self:flex-end;}
.ce-suggest .ce-toggle{align-self:auto; border-radius:9px 0 0 9px;}
.ce-suggest select{
  font-family:var(--mono); font-size:11px; padding:0 6px 0 7px; cursor:pointer;
  border:1px solid var(--line); border-left:0; border-radius:0 9px 9px 0;
  background:var(--panel); color:var(--muted);
}
.ce-suggest .ce-toggle:hover, .ce-suggest select:hover{color:var(--ink);}
.ce-transport button:first-child{background:var(--ink); color:var(--panel); border-color:var(--ink);}
.ce-transport button:first-child:disabled{background:var(--bg); color:var(--ink);}
/* the history strip: one chip per generation, newest (and what's queued) on the right */
.ce-gens{display:flex; gap:6px; list-style:none; margin:0 0 10px; padding:0 0 2px; overflow-x:auto;}
.ce-gens li{flex:0 0 auto;}
.ce-gen{
  display:inline-flex; align-items:baseline; gap:6px; padding:5px 9px; border-radius:8px;
  font-family:var(--mono); font-size:11px; color:var(--muted);
  border:1px solid var(--line); background:var(--bg); cursor:pointer; opacity:.75;
}
.ce-gen:hover{opacity:1; color:var(--ink);}
.ce-gen.on{opacity:1; color:var(--ink); background:var(--panel); border-color:var(--ink);}
.ce-gen.next, .ce-gen.ghost{opacity:1; border-style:dashed; border-color:var(--ink); color:var(--ink);}
.ce-gen.ghost{cursor:default; background:transparent;}
.ce-gen-chord{border-bottom:2px solid var(--c); padding-bottom:1px;}
.ce-gen-chord.changed{font-weight:600;}
.ce-gen-tag{font-size:9px; text-transform:uppercase; letter-spacing:.1em; color:var(--muted);}
.ce-gen-empty{font-style:italic;}
button.ce-toggle:disabled{opacity:.4; cursor:default;}
.ce-transport button.ce-playing{background:var(--tension); border-color:var(--tension); color:var(--panel);}
.ce-share.copied:not(:disabled){background:var(--ink); color:var(--panel); border-color:var(--ink);}

/* the tension hue, because something is being withheld — not an error colour */
.ce-nosound{
  display:flex; gap:12px; align-items:flex-start; margin:0 0 12px; padding:10px 12px;
  border-radius:10px; border:1px solid color-mix(in srgb, var(--tension) 40%, transparent);
  background:color-mix(in srgb, var(--tension) 10%, var(--panel));
}
.ce-nosound p{margin:0; font-size:12.5px; line-height:1.5; color:var(--ink); flex:1; max-width:78ch;}
.ce-nosound i{font-style:normal; font-family:var(--mono); font-size:11.5px;}
.ce-nosound-x{
  flex:0 0 auto; width:24px; height:24px; padding:0; border-radius:6px; cursor:pointer;
  border:1px solid transparent; background:transparent; color:var(--muted); font-size:16px; line-height:1;
}
.ce-nosound-x:hover{color:var(--ink); border-color:var(--line);}

.ce-empty{font-size:13px; color:var(--muted); line-height:1.5; margin:4px 0; max-width:60ch;}

.ce-curve{width:100%; height:46px; display:block; margin:2px 0 12px;}
.ce-curve-base{stroke:var(--line); stroke-width:.5; stroke-dasharray:1.5 1.5;}
.ce-curve-line{fill:none; stroke:var(--ink); stroke-width:1; opacity:.55; vector-effect:non-scaling-stroke;}

/* stage: the roll on the left, the futures fanning out on the right */
/* Stacked, not side by side: sharing the width capped the roll at about five
   chords before it had to scroll, and the roll is the thing you're reading. Full
   width buys roughly eleven, and the futures get the whole width underneath. */
.ce-stage{display:flex; flex-direction:column; align-items:stretch; gap:16px;}
.ce-roll{width:100%; min-width:0; overflow-x:auto; padding:2px 0 4px;}
.ce-roll-inner{position:relative;}
.ce-roll-links{position:absolute; top:0; left:0; z-index:0; overflow:visible; pointer-events:none;}
.ce-roll-link{stroke:var(--ink); stroke-width:1; opacity:.13;}
.ce-roll-link.held{opacity:.24;}
.ce-roll-lane{stroke:var(--ink); stroke-width:1; opacity:.18; stroke-dasharray:2 4;}
/* the bass voice: same pill, heavier outline, so it reads as the floor under the chord */
.ce-roll-note.bass{border-width:1.5px; border-color:color-mix(in srgb, var(--c) 70%, transparent); font-weight:600;}
.ce-roll-cols{position:relative; z-index:1; display:flex; gap:10px; align-items:flex-start;}
.ce-roll-col{--c:var(--home); flex:0 0 auto; display:flex; flex-direction:column; gap:9px;}
.ce-roll-notes{position:relative; display:block; width:100%;}
.ce-roll-note{
  position:absolute; left:0; right:0; height:18px; padding:0;
  display:flex; align-items:center; justify-content:center; cursor:pointer;
  font-family:var(--mono); font-size:11px; font-weight:500; color:var(--ink); letter-spacing:.02em;
  background:color-mix(in srgb, var(--c) 14%, var(--panel));
  border:1px solid color-mix(in srgb, var(--c) 45%, transparent); border-radius:5px;
  /* top is inline-styled from the pitch band; easing it means the whole roll
     glides when a new chord widens the band instead of jumping */
  transition:background .1s ease, transform .1s ease, top .3s cubic-bezier(.3,.8,.35,1);
}
/* a freshly chosen chord: its pills fly in from the future row that spawned them */
@keyframes ce-spawn{
  from{transform:translate(var(--dx), var(--dy)) scale(.5); opacity:0;}
  55%{opacity:1;}
  to{transform:none; opacity:1;}
}
.ce-roll-note.spawn{animation:ce-spawn .34s cubic-bezier(.2,.85,.3,1) backwards; transition:none;}
@keyframes ce-settle{from{opacity:0; transform:translateY(-5px);} to{opacity:1; transform:none;}}
.ce-roll-tilewrap.spawn{animation:ce-settle .26s ease .19s backwards;}
.ce-roll-step{
  position:absolute; right:3px; /* absolute, so the note name stays optically centred */
  font-size:9px; font-weight:400; color:var(--muted); letter-spacing:0;
}
.ce-roll-note:hover .ce-roll-step, .ce-roll-note.lit .ce-roll-step{color:var(--ink);}
.ce-roll-note.held{
  background:color-mix(in srgb, var(--c) 30%, var(--panel));
  border-color:var(--c);
}
.ce-roll-note:hover{background:color-mix(in srgb, var(--c) 42%, var(--panel)); border-color:var(--c);}
.ce-roll-note:active{transform:scale(.94);}
.ce-roll-note:focus-visible{outline:2px solid var(--ink); outline-offset:1px;}
/* lit per note, from its onset to its release — a block chord lights together,
   an arpeggio walks up the column */
.ce-roll-note.lit{background:color-mix(in srgb, var(--c) 55%, var(--panel)); border-color:var(--c); color:var(--ink);}

.ce-roll-tile{
  position:relative; display:flex; flex-direction:column; align-items:flex-start; text-align:left; gap:3px;
  padding:6px 8px 7px 12px; border-radius:9px; border:1px solid var(--line);
  background:var(--bg); overflow:hidden; cursor:pointer; transition:background .11s ease;
}
.ce-roll-tile::before{content:""; position:absolute; left:0; top:0; bottom:0; width:4px; background:var(--c);}
.ce-roll-tile:hover{background:var(--panel);}
.ce-roll-tile:focus-visible{outline:2px solid var(--ink); outline-offset:2px;}
.ce-roll-col.playing .ce-roll-tile{background:var(--panel); box-shadow:0 0 0 2px var(--c) inset;}
.ce-chip-name{font-size:15px; font-weight:600; letter-spacing:-.01em;}
.ce-chip-slash{font-weight:500; color:var(--muted);}
.ce-chip-roman{font-family:var(--mono); font-size:10px; color:var(--muted);}
.ce-chip-dist{
  align-self:flex-start; margin-top:1px; font-family:var(--mono); font-size:9.5px; font-weight:600; line-height:1;
  padding:2px 4px; border-radius:5px; color:var(--muted);
  background:color-mix(in srgb, var(--muted) 12%, transparent);
}
.ce-chip-dist.smooth{
  color:#2f7d5b; background:color-mix(in srgb, #2f7d5b 15%, transparent);
}
.ce-chip-dist.far{
  color:#b0642a; background:color-mix(in srgb, #b0642a 15%, transparent);
}

/* holds the Δ slot open on the first tile, which has nothing to measure from */
.ce-chip-ghost{visibility:hidden;}

.ce-roll-tilewrap{position:relative; display:flex; align-items:stretch; gap:4px;}
.ce-roll-tile{cursor:grab; touch-action:none; user-select:none;}
.ce-roll-col.dragging{z-index:3;}
.ce-roll-col.dragging .ce-roll-tile{
  cursor:grabbing; background:var(--panel);
  box-shadow:0 8px 20px -12px rgba(34,30,24,.7), 0 0 0 1px var(--c) inset;
}
.ce-roll-col.dragging .ce-roll-note{border-color:var(--c);}

/* remove: quiet until you go looking for it, but always reachable by keyboard */
.ce-roll-del{
  position:absolute; top:-7px; right:-7px; z-index:2;
  width:18px; height:18px; padding:0; line-height:1; font-size:13px;
  display:flex; align-items:center; justify-content:center;
  border:1px solid var(--line); border-radius:50%;
  background:var(--bg); color:var(--muted); cursor:pointer;
  opacity:0; transition:opacity .12s ease, background .12s ease, color .12s ease;
}
.ce-roll-col:hover .ce-roll-del,
.ce-roll-col:focus-within .ce-roll-del{opacity:1;}
.ce-roll-del:hover{background:var(--tension); border-color:var(--tension); color:var(--panel);}
.ce-roll-del:focus-visible{opacity:1; outline:2px solid var(--ink); outline-offset:1px;}
@media (hover:none){.ce-roll-del{opacity:1;}} /* no hover on touch — just show it */
.ce-roll-tilewrap .ce-roll-tile{flex:1 1 auto; min-width:0;}
.ce-roll-invert{display:flex; flex-direction:column; gap:3px; flex:0 0 auto;}
.ce-inv-btn{
  display:flex; align-items:center; justify-content:center; flex:1 1 0; width:19px; padding:0;
  border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--muted);
  cursor:pointer; transition:background .1s ease, color .1s ease, border-color .1s ease;
}
.ce-inv-btn:hover{background:var(--panel); color:var(--ink); border-color:var(--c);}
.ce-inv-btn:active{transform:scale(.9);}
.ce-inv-btn:focus-visible{outline:2px solid var(--ink); outline-offset:1px;}

/* futures: every chord that could come next, one line each, most tense on top */
.ce-futures{
  width:100%; display:flex; flex-direction:column; gap:7px;
  padding-top:14px; border-top:1px solid var(--line2); /* the seam the roll sits above */
}
.ce-futures-head{display:flex; align-items:center; justify-content:space-between; gap:10px;}
.ce-futures-tools{display:flex; align-items:center; gap:9px; flex:0 0 auto;}
.ce-futures-axis{
  font-family:var(--mono); font-size:10px; color:var(--muted); letter-spacing:.06em;
  min-width:6.2em; text-align:right; cursor:pointer;
  padding:3px 5px; margin:-3px -5px; border:0; border-radius:6px; background:transparent;
  transition:background .1s ease, color .1s ease;
}
.ce-futures-axis:hover{background:var(--bg); color:var(--ink);}
.ce-futures-axis:focus-visible{outline:2px solid var(--ink); outline-offset:1px;}
.ce-futures-count{
  font-family:var(--mono); font-size:10px; color:var(--muted); letter-spacing:.04em;
}
.ce-filter{
  width:120px; font-family:var(--mono); font-size:11px; color:var(--ink);
  padding:4px 8px; border:1px solid var(--line); border-radius:7px; background:var(--bg);
  transition:border-color .12s ease, background .12s ease;
}
.ce-filter::placeholder{color:var(--muted); opacity:.85;}
.ce-filter:focus{outline:none; border-color:var(--ink); background:var(--panel);}
.ce-filter::-webkit-search-cancel-button{cursor:pointer;}

.ce-futures-note{
  display:flex; flex-wrap:wrap; align-items:center; gap:8px;
  margin:4px 0 0; padding:0 4px; font-size:11.5px; color:var(--muted);
}
.ce-futures-hint{
  font-family:var(--mono); font-size:10.5px; color:var(--ink); cursor:pointer;
  padding:3px 8px; border-radius:6px; border:1px dashed var(--line);
  background:transparent; transition:background .1s ease, border-color .1s ease;
}
.ce-futures-hint:hover{background:var(--bg); border-color:var(--ink); border-style:solid;}
.ce-futures-hint:focus-visible{outline:2px solid var(--ink); outline-offset:1px;}
.ce-futures-list{display:flex; flex-direction:column; gap:2px;}

.ce-future{
  --c:var(--home); --t:0;
  /* em here resolves against the button's own font-size (the UA default ~13.3px),
     not the 16px root. The notes track fits the widest spelling a chord can have:
     four flat names — E♭m7 is ii7 in D♭ major, and spells "E♭ G♭ B♭ D♭". */
  display:grid; grid-template-columns:14px 5.4em 4.4em 9.6em 2.9em minmax(0,1fr);
  align-items:center; gap:8px; width:100%; text-align:left;
  padding:3px 8px 3px 4px; border:1px solid transparent; border-radius:7px;
  background:transparent; color:var(--ink); cursor:pointer;
  transition:background .1s ease, border-color .1s ease, transform .1s ease;
}
.ce-future:hover{background:var(--bg); border-color:var(--line2); transform:translateX(2px);}
.ce-future:focus-visible{outline:2px solid var(--ink); outline-offset:1px;}
.ce-future.resolve{background:color-mix(in srgb, var(--c) 9%, transparent); border-color:color-mix(in srgb, var(--c) 35%, transparent);}

/* the tension meter doubles as the function swatch — height reads as tension */
.ce-fu-tension{display:flex; align-items:center; justify-content:center; height:16px;}
.ce-fu-tension i{
  display:block; width:5px; border-radius:3px; background:var(--c);
  height:calc(4px + var(--t) * 12px);
}
/* the name is the audition target — give it a hit area and say so on hover */
.ce-fu-name{
  font-size:14.5px; font-weight:600; letter-spacing:-.01em;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  justify-self:start; max-width:100%;
  padding:1px 4px; margin:-1px -4px; border-radius:5px;
  transition:background .12s ease, color .12s ease;
}
.ce-fu-name:hover{background:color-mix(in srgb, var(--c) 20%, transparent); color:var(--c);}
.ce-fu-roman{font-family:var(--mono); font-size:10.5px; color:var(--c); font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
.ce-fu-notes{
  font-family:var(--mono); font-size:10.5px; letter-spacing:.06em; color:var(--muted);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.ce-future:hover .ce-fu-notes{color:var(--ink);}
.ce-fu-dist{display:flex; justify-content:flex-end;}
.ce-fu-dist .ce-chip-dist{margin-top:0;}
.ce-fu-move{
  font-size:11.5px; line-height:1.35; color:var(--muted);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.ce-future:hover .ce-fu-move{color:var(--ink);}

/* choosing: the rest of the futures clear out, the chosen one flies to the roll */
@keyframes ce-assemble{from{opacity:0; transform:translateY(5px);} to{opacity:1; transform:none;}}
.ce-futures-list .ce-future{animation:ce-assemble .24s ease backwards; animation-delay:calc(var(--i) * 15ms);}
@keyframes ce-fu-leave{to{opacity:0; transform:translateX(14px);}}
@keyframes ce-fu-chosen{
  30%{transform:translateX(-4px) scale(1.02);}
  to{opacity:0; transform:translateX(-26px) scale(.94);}
}
.ce-future.leaving{animation:ce-fu-leave .17s ease forwards; pointer-events:none;}
.ce-future.chosen{
  animation:ce-fu-chosen .17s ease forwards; pointer-events:none;
  background:color-mix(in srgb, var(--c) 20%, transparent); border-color:var(--c);
}

.ce-legend{display:flex; flex-wrap:wrap; align-items:center; gap:16px; margin-top:24px; padding-top:14px; border-top:1px solid var(--line);}
.ce-leg{display:inline-flex; align-items:center; gap:6px; font-family:var(--mono); font-size:11px; color:var(--muted);}
.ce-leg i{width:11px; height:11px; border-radius:3px; display:inline-block;}
.ce-leg-note{font-size:11px; color:var(--muted); font-style:italic; margin-left:auto;}

@media (max-width:560px){
  .ce-controls{width:100%;}
  /* the notes are the droppable column here — the name has to stay whole */
  .ce-fu-notes{display:none;}
  .ce-future{grid-template-columns:12px 5em 4.2em 2.7em minmax(0,1fr); gap:6px;}
  .ce-fu-move{font-size:11px;}
}
@media (prefers-reduced-motion:reduce){
  .ce-future{transition:none;}
  .ce-future:hover{transform:none;}
  .ce-futures-list .ce-future,
  .ce-future.leaving, .ce-future.chosen,
  .ce-roll-note.spawn, .ce-roll-tilewrap.spawn{animation:none;}
  .ce-roll-note{transition:none;}
}
`;
