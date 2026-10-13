import { useState, useMemo, useRef, useCallback, useEffect, useLayoutEffect } from "react";
import * as Tone from "tone";
import {
  nameOf,
  rootPositionMidi,
  voiceLeadMidi,
  applyInversion,
  computeVoicings,
  voicingDistance,
  bassNote,
  bassLine,
  resolveKey,
  suspensionsFor,
  suggestLoop,
  mutateLoop,
  optionsFrom,
} from "./harmony.js";
import { FEEL, defaultFeel, chordEvents } from "./perform.js";
import { encodeState, EVOLVE_EVERY, DEFAULT_TEMPO } from "./state.js";
import { optKey, normQuery, matchesQuery } from "./futures.js";
import { ROLL } from "./roll.js";
import PianoRoll from "./PianoRoll.jsx";
import FutureList from "./FutureList.jsx";
import { ModHead, Field, Keys, Toggle, Level, Led, NoSound, ShareIcon, Tick } from "../panel/parts.jsx";
import { SYM } from "../panel/symbols.jsx";
import { MIDI_STATUS } from "../midi/access.js";
import { useMidiOut } from "../midi/out.js";
import { useUrlSlice, currentPath } from "../url.js";
import "./chords.css";

/* ------------------------------------------------------------------ *
 *  CHORD PATHS — a functional-harmony explorer
 *  Pick a chord, hear it, and see where it can go next — with every
 *  move tagged by what it *does* (root motion + harmonic function).
 *
 *  A sequencer, not an instrument: it decides which notes and how they're
 *  struck (harmony.js, perform.js), and hands the resulting note events to
 *  the synth's engine or a MIDI port. It builds no audio nodes; Tone is
 *  only its clock.
 * ------------------------------------------------------------------ */

// choreography timings — the futures clear out, then the new column assembles
const EXIT_MS = 170;
const SPAWN_MS = 340;

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

// Mutate's levels: that many quarters of the bars, never bar 1. (The engine's
// level 4, every bar, isn't offered: it's a new loop, which is Suggest's job.)
const MUT_LEVELS = [
  ["1/4", "about a quarter of the bars"],
  ["1/2", "about half the bars"],
  ["3/4", "about three quarters of the bars"],
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

// `engine` is the synth's (see useSynthEngine): `ensure`, `play` and `release`
// are all the explorer asks of it. `midiAccess` is the page's shared one.
export default function ChordExplorer({ boot, engine, midiAccess, noSound, onDismissNoSound }) {
  const [root, setRoot] = useState(boot.root ?? 0);
  const [mode, setMode] = useState(boot.mode ?? "major");
  const [add7, setAdd7] = useState(boot.add7 ?? false);
  const [voiceLead, setVoiceLead] = useState(boot.voiceLead ?? true);
  const [bassOn, setBassOn] = useState(boot.bass ?? false);
  const [arp, setArp] = useState(boot.arp ?? false);
  const [arpFour, setArpFour] = useState(boot.arpFour ?? false);
  const [arpOrder, setArpOrder] = useState(boot.arpOrder ?? "rise");
  const [holdBass, setHoldBass] = useState(boot.holdBass ?? false);
  const [loop, setLoop] = useState(boot.loop ?? true);
  const [evolve, setEvolve] = useState(boot.evolve ?? false);
  // Evolve lands its mutation after this many times round, not every time
  const [evolveEvery, setEvolveEvery] = useState(boot.evolveEvery ?? 1);
  // Off / Loop / Evolve are one row of keys: Evolve only means anything looping
  const repeat = !loop ? "off" : evolve ? "evolve" : "loop";
  const repeatStatusTitle = !loop
    ? "Plays the progression once and stops"
    : !evolve
      ? "Loops until you press Stop"
      : evolveEvery === 1
        ? "Loops, mutating the progression every time round"
        : `Loops, mutating the progression every ${evolveEvery} times round`;
  const setRepeat = (v) => {
    setLoop(v !== "off");
    setEvolve(v === "evolve");
  };
  // how much Mutate (and so Evolve) changes: that many quarters of the bars
  const [mutLevel, setMutLevel] = useState(boot.mutLevel ?? 1);
  const [susOn, setSusOn] = useState(boot.susOn ?? false);
  const [tempo, setTempo] = useState(boot.tempo ?? DEFAULT_TEMPO);
  // how the chords are struck: Dynamics and Humanise (see perform.js)
  const [feel, setFeel] = useState(boot.feel ?? defaultFeel());
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
  // every frame of a level drag — it only ever reads the current value
  const feelRef = useRef(feel);
  feelRef.current = feel;
  const midi = useMidiOut(midiAccess);
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

  // the explorer's part of the address bar (the synth writes its own)
  useUrlSlice(
    "chords",
    useMemo(
      () => encodeState({ root, mode, add7, voiceLead, bass: bassOn, arp, arpFour, arpOrder, holdBass, loop, evolve, evolveEvery, mutLevel, susOn, tempo, feel, prog }),
      [root, mode, add7, voiceLead, bassOn, arp, arpFour, arpOrder, holdBass, loop, evolve, evolveEvery, mutLevel, susOn, tempo, feel, prog]
    )
  );

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
      if (!(await engine.ensure())) return; // no gesture yet: a hover, before any click
      const t = when ?? Tone.now();
      // one list of note events for the synth and the MIDI port alike — block
      // chord or arpeggio, bass held or in the arp, velocity and humanise all
      // decided in one pure function (see chordEvents)
      const events = chordEvents(chord.upper, chord.bass, {
        arp, four: arpFour, order: arpOrder, holdBass, dur, span, feel: feelRef.current,
      });
      if (onLight) {
        // from the same events that sound, so the lights can't drift from the notes
        const draw = Tone.getDraw();
        for (const e of events) {
          draw.schedule(() => onLight(e.midi, true), t + e.at);
          draw.schedule(() => onLight(e.midi, false), t + e.at + e.dur);
        }
      }
      // the port replaces the built-in synth rather than doubling it
      if (midiActive) midiSend(events, t);
      else engine.play(events, t);
    },
    [engine, arp, arpFour, arpOrder, holdBass, midiActive, midiSend]
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
  // tempo level rescales a run in flight; Transport.cancel() is what makes a
  // Stop land now.
  const STEP = 2; // one chord = a half note = two beats
  const atBeat = (n) => `0:${n}:0`;
  const cursor = useRef(0);
  // times round since the progression last changed, for Evolve's pace
  const rounds = useRef(0);
  const [round, setRound] = useState(0); // the same count, for the display
  const evolveEveryRef = useRef(1);

  const stopPlayback = useCallback(() => {
    const t = Tone.getTransport();
    t.stop();
    t.cancel();
    t.position = 0;
    t.loop = false;
    engine.release();
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
  }, [engine, midiPanic, land]);

  const playAll = useCallback(async () => {
    if (playingRef.current) return stopPlayback(); // the button is Play/Stop
    if (!prog.length) return;
    if (!(await engine.ensure())) return;
    const t = Tone.getTransport();
    t.cancel();
    t.loop = false;
    t.bpm.value = tempo;
    cursor.current = 0;
    rounds.current = 0;
    setRound(0);
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
        rounds.current += 1;
        // an Evolve mutation waits out its rounds; anything you asked for lands now
        if (live.next && (!live.next.queued.auto || rounds.current >= evolveEveryRef.current)) {
          rounds.current = 0;
          // swap now, in the callback — Tone runs it ~100ms ahead of the audio,
          // and waiting on React would play bar 1 of the old progression
          const { queued: q, prog: p, played: pl } = live.next;
          live.played = pl;
          live.next = null;
          land(q, p);
          setQueued(null);
        }
        const r = rounds.current;
        Tone.getDraw().schedule(() => setRound(r), time);
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
  }, [prog.length, tempo, engine, stopPlayback, land, light]);

  // the toggles reach into a run already in progress
  useEffect(() => { Tone.getTransport().bpm.value = tempo; }, [tempo]);
  useEffect(() => { loopRef.current = loop; }, [loop]);
  useEffect(() => { evolveEveryRef.current = evolveEvery; }, [evolveEvery]);

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
  const playAllRef = useRef(playAll);
  useEffect(() => {
    stopRef.current = stopPlayback;
    playVoicedRef.current = playVoiced;
    playAllRef.current = playAll;
  });

  // Space plays and stops, from anywhere on the page but a text field. It
  // starts audio fine from cold: a key press is a gesture that keeps its user
  // activation (see the engine's unlock). The catch is focus — clicking any key
  // on the face leaves it focused, and Space presses the focused button on keyup,
  // so Space would also toggle Loop or clear the progression. Both halves of the
  // press are swallowed, so Space only ever means the transport; Enter still
  // presses a focused key. Registered once, reading everything through refs.
  useEffect(() => {
    const typing = (el) =>
      !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
    const isSpace = (e) => e.code === "Space" || e.key === " ";
    const down = (e) => {
      if (!isSpace(e) || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      e.preventDefault(); // no scroll, no button press
      if (!e.repeat) playAllRef.current(); // Play when stopped, Stop when playing
    };
    const up = (e) => {
      if (isSpace(e) && !typing(e.target)) e.preventDefault();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

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
    // the composed path, not location.href — the address bar trails by up to
    // 300ms, and carries the synth's patch alongside the progression
    const href = window.location.origin + currentPath();
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
  }, []);

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
    <div className="ce-chassis ce-explorer">
      <header className="ce-mod ce-plate">
        <h1>chord paths</h1>
        <div className="ce-leds" aria-hidden="true">
          <Led on={playing}>Play</Led>
          <Led on={loop}>Loop</Led>
          <Led on={midiActive}>MIDI</Led>
        </div>
        <div className="ce-grille" aria-hidden="true" />
        {/* sharing is about the page, not the progression, so it's up here
            rather than in any of the modules */}
        <button
          className={"ce-share" + (copied ? " copied" : "")}
          onClick={share}
          disabled={!prog.length}
          aria-label={copied ? "Link copied" : "Copy a link to this progression and sound"}
          title={copied ? "Link copied" : "Copy a link to this progression and sound"}
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
          {/* how much, then go: the two lines share columns, so the buttons match */}
          <div className="ce-go">
            <Field label="Bars">
              <Keys
                label="Bars in a suggested loop"
                value={bars}
                onChange={setBars}
                options={[2, 4, 8].map((b) => ({ v: b, label: String(b), title: `Suggest ${b}-bar loops` }))}
              />
            </Field>
            <button
              className="ce-key"
              onClick={suggest}
              title={`Propose a ${bars}-bar loop — press again to re-roll. The one it replaces stays in the history; while playing, it waits for the loop to come round.`}
            >
              {SYM.suggest}Suggest
            </button>
            <Field label="Amount">
              <Keys
                label="How much a mutation changes"
                value={mutLevel}
                onChange={setMutLevel}
                options={MUT_LEVELS.map(([, hint], i) => ({
                  v: i + 1,
                  label: String(i + 1),
                  title: `Change ${hint} — Evolve uses this too`,
                }))}
              />
            </Field>
            <button
              className="ce-key"
              onClick={mutate}
              disabled={prog.length < 2}
              title={`Change ${MUT_LEVELS[mutLevel - 1][1]}, keeping bar 1 and your edits. The original stays in the history; while playing, the change waits for the loop to come round.`}
            >
              {SYM.mutate}Mutate
            </button>
          </div>
          {/* Every hangs under Evolve, the two groups one width, joined by a
              wire from the Evolve key that lights when it's on */}
          <div className={"ce-evo" + (evolve ? " on" : "")}>
            <Field label="Repeat">
              <Keys
                label="Repeat"
                value={repeat}
                onChange={setRepeat}
                options={[
                  { v: "off", label: "Off", title: "Play the progression once and stop" },
                  { v: "loop", label: "Loop", title: "Repeat the progression until you press Stop" },
                  {
                    v: "evolve",
                    label: "Evolve",
                    title: "Loop, and mutate the progression as it comes round, so it keeps changing while it plays. Mutate's amount sets how much; every version stays in the history",
                  },
                ]}
              />
            </Field>
            <Field label="Every">
              <Keys
                label="Evolve after this many times round"
                value={evolveEvery}
                disabled={!evolve}
                onChange={setEvolveEvery}
                options={EVOLVE_EVERY.map((n) => ({
                  v: n,
                  label: String(n),
                  title: evolve
                    ? n === 1 ? "Evolve every time the loop comes round" : `Evolve after ${n} times round`
                    : "How often Evolve changes the loop — pick Evolve to use it",
                }))}
              />
            </Field>
          </div>
        </div>
      </section>

      {/* 03–04: how the progression is played, and where it goes */}
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
          {/* how hard and how loosely each chord is struck — the player's, so
              they go out the MIDI port too, and travel in the link */}
          <div className="ce-feel">
            {Object.entries(FEEL).map(([k, f]) => (
              <Level
                key={k}
                label={f.label}
                title={f.hint}
                pos={feel[k]}
                text={`${Math.round(feel[k] * 100)}%`}
                onPos={(p) => setFeel((s) => ({ ...s, [k]: Math.round(p * 100) / 100 }))}
              />
            ))}
          </div>
          {/* 120 bars for 30–150: one bar is one beat per minute */}
          <Level
            wide
            label="Tempo"
            n={120}
            pos={(tempo - 30) / 120}
            text={String(tempo)}
            title="Beats per minute — each chord lasts two beats"
            onPos={(p) => setTempo(Math.round(30 + p * 120))}
            onStep={(d) => setTempo((t) => Math.min(150, Math.max(30, t + d)))}
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
                { v: "int", label: "Int", title: "The synth below" },
                {
                  v: "midi",
                  label: "MIDI",
                  disabled: midiDead,
                  title: midi.status === "ready"
                    ? "Send notes to an external instrument instead of the synth below"
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
          {/* sixteen keys, four by four. Leaving a channel silences it first,
              the same as leaving a port: whatever it was holding stops. */}
          <Field label="Chan">
            <Keys
              cols={4}
              label="MIDI channel"
              value={midi.channel}
              disabled={!midiActive}
              onChange={(ch) => {
                midiPanic();
                midi.setChannel(ch);
              }}
              options={Array.from({ length: 16 }, (_, ch) => ({
                v: ch,
                label: String(ch + 1),
                title: midiActive ? `Send on MIDI channel ${ch + 1}` : "The channel notes go out on — route to MIDI to use it",
              }))}
            />
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
            <span title={repeatStatusTitle}>
              {repeat === "off" ? "once" : repeat}
              {evolve && evolveEvery > 1 && (playing
                ? <> round <b>{Math.min(round, evolveEvery - 1) + 1}</b>/{evolveEvery}</>
                : <> every <b>{evolveEvery}</b></>)}
            </span>
            <span title={`Mutate changes ${MUT_LEVELS[mutLevel - 1][1]}${queued?.kind === "mutate" && !queued.auto ? " — one is waiting for the loop to come round" : ""}`}>
              mutate <b>{MUT_LEVELS[mutLevel - 1][0]}</b>
              {queued?.kind === "mutate" && !queued.auto && " next"}
            </span>
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
                      title={`${genNames(nextProg)}\n` + (queued.auto ? `Evolve: plays ${evolveEvery === 1 ? "when the loop comes round" : `after ${evolveEvery} times round`}` : "Plays when the loop comes round")}
                    >
                      +
                    </span>
                  </li>
                )}
              </ol>
            )}
          </div>

          {noSound && <NoSound onDismiss={onDismissNoSound} />}

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
            title={playing ? "Playing — Space stops" : "Play the progression (Space)"}
          >
            {SYM.play}
          </button>
          <button className="ce-key big" onClick={stopPlayback} disabled={!playing} aria-label="Stop" title="Stop (Space)">
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
    </div>
  );
}

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
