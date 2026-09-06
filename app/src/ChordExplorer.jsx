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
  bassNameOf,
  resolveKey,
  suspensionsFor,
  isResolution,
  motionLabel,
  moveDescription,
  optionsFrom,
} from "./harmony.js";

/* ------------------------------------------------------------------ *
 *  CHORD PATHS — a functional-harmony explorer
 *  Pick a chord, hear it, and see where it can go next — with every
 *  move tagged by what it *does* (root motion + harmonic function).
 *  Colour encodes function: home / build / tension / outside.
 * ------------------------------------------------------------------ */

// ------------------------------------------------------------------------
//  AUDIO
// ------------------------------------------------------------------------
function useSynth() {
  const ref = useRef(null);
  const ensure = useCallback(async () => {
    if (!ref.current) {
      await Tone.start();
      const synth = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: "triangle" },
        envelope: { attack: 0.015, decay: 0.25, sustain: 0.55, release: 1.3 },
      });
      synth.volume.value = -9;
      const rev = new Tone.Reverb({ decay: 2.2, wet: 0.22 });
      synth.chain(rev, Tone.Destination);
      ref.current = synth;
    } else if (Tone.getContext().state !== "running") {
      await Tone.start();
    }
    return ref.current;
  }, []);
  // Transport.stop() unschedules what hasn't played, but a note already
  // triggered rings out on its own envelope — this cuts it
  const release = useCallback(() => ref.current?.releaseAll(), []);
  return { ensure, release };
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

// choreography timings — the futures clear out, then the new column assembles
const EXIT_MS = 170;
const SPAWN_MS = 340;

// stable identity for an option row (roman alone collides: minor has V and V7)
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
  if (s.arp) p.set("arp", "1");
  if (s.loop) p.set("lp", "1");
  if (s.susOn) p.set("su", "1");
  if (s.tempo !== 96) p.set("t", s.tempo);
  if (s.prog.length) p.set("p", s.prog.map(chordToken).join("_"));
  return p.toString();
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
  const arp = p.get("arp") === "1";
  const loop = p.get("lp") === "1";
  const susOn = p.get("su") === "1";
  const tempo = clampNum(p.get("t"), 96, 60, 140);
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
      // decorate like optionsFrom so a reconstituted chord matches a chosen one
      const prev = prog.length ? prog[prog.length - 1] : null;
      const resolution = isResolution(prev, match);
      prog.push({
        ...match,
        id: prog.length + 1,
        inv,
        motion: prev ? motionLabel(prev.rootPc, match.rootPc) : null,
        resolution,
        move: resolution
          ? `Resolution — lands home on ${match.name}, releasing the previous chord’s tension.`
          : moveDescription(mode, prev ? prev.degree : null, match),
      });
    }
  }
  return { root, mode, add7, voiceLead, arp, loop, susOn, tempo, prog };
}

export default function ChordExplorer() {
  const boot = useMemo(() => decodeState(window.location.search) || {}, []);
  const [root, setRoot] = useState(boot.root ?? 0);
  const [mode, setMode] = useState(boot.mode ?? "major");
  const [add7, setAdd7] = useState(boot.add7 ?? false);
  const [voiceLead, setVoiceLead] = useState(boot.voiceLead ?? true);
  const [arp, setArp] = useState(boot.arp ?? false);
  const [loop, setLoop] = useState(boot.loop ?? false);
  const [susOn, setSusOn] = useState(boot.susOn ?? false);
  const [tempo, setTempo] = useState(boot.tempo ?? 96);
  const [prog, setProg] = useState(boot.prog ?? []);
  const [playingIdx, setPlayingIdx] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false); // read inside scheduled callbacks and effects
  const loopRef = useRef(false);
  const [query, setQuery] = useState("");
  const { ensure, release } = useSynth();
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

  // keep the URL in sync so any state is bookmarkable / shareable
  useEffect(() => {
    const qs = encodeState({ root, mode, add7, voiceLead, arp, loop, susOn, tempo, prog });
    const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    window.history.replaceState(null, "", url);
  }, [root, mode, add7, voiceLead, arp, loop, susOn, tempo, prog]);

  const current = prog.length ? prog[prog.length - 1] : null;
  const { inKey, colour, sus } = useMemo(() => optionsFrom(current, key), [current, key]);

  // every possible next chord as one flat list, most tense at the top. Sort is
  // stable, so within a tension band the engine's own ranking still shows through.
  const futures = useMemo(
    () =>
      [...inKey, ...colour, ...(susOn ? sus : [])].sort((a, b) => b.tension - a.tension),
    [inKey, colour, sus, susOn]
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

  const playVoiced = useCallback(
    async (midi, dur = 1.1, when) => {
      const synth = await ensure();
      const t = when ?? Tone.now();
      if (arp && midi.length > 1) {
        // roll the notes up low-to-high (inversion shifts leave midi unsorted)
        const notes = midiToNotes([...midi].sort((a, b) => a - b));
        const stagger = Math.min(dur * 0.22, 0.16);
        notes.forEach((n, i) => {
          synth.triggerAttackRelease(n, dur - i * stagger, t + i * stagger);
        });
      } else {
        synth.triggerAttackRelease(midiToNotes(midi), dur, t);
      }
    },
    [ensure, arp]
  );

  const preview = useCallback(
    (opt) => {
      // taste the chord without committing it — same voicing choose would use
      const prevMidi = voiceLead && voicings.length ? voicings[voicings.length - 1] : null;
      const midi = voiceLead ? voiceLeadMidi(prevMidi, opt) : rootPositionMidi(opt);
      playVoiced(midi, 0.8);
    },
    [voiceLead, voicings, playVoiced]
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
      playVoiced(midi); // sound lands on the click, not after the animation
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
    [exiting, voiceLead, voicings, playVoiced, prog.length]
  );

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

  // Playback runs on Tone's Transport rather than scheduling a pass up front:
  // looping needs a Stop that lands now, not at the end of the current cycle,
  // and Transport.cancel() is the only thing that unschedules what's queued.
  // Events are placed in Transport time (beats), so the tempo slider rescales
  // them mid-flight instead of applying only on the next Play.
  const STEP = 2; // one chord = a half note = two beats
  const atBeat = (n) => `0:${n}:0`;

  const stopPlayback = useCallback(() => {
    const t = Tone.getTransport();
    t.stop();
    t.cancel();
    t.position = 0;
    t.loop = false;
    release();
    playingRef.current = false;
    setPlaying(false);
    setPlayingIdx(-1);
  }, [release]);

  const playAll = useCallback(async () => {
    if (playingRef.current) return stopPlayback(); // the button is Play/Stop
    if (!prog.length) return;
    await ensure();
    const t = Tone.getTransport();
    t.cancel();
    t.bpm.value = tempo;
    prog.forEach((c, i) => {
      t.schedule((time) => {
        // duration read at fire time, so a tempo change lands on the next chord
        playVoiced(voicings[i], Tone.Time(atBeat(STEP)).toSeconds() * 0.92, time);
        Tone.getDraw().schedule(() => setPlayingIdx(i), time); // visuals on the audio clock
      }, atBeat(i * STEP));
    });
    const end = atBeat(prog.length * STEP);
    // always armed, and guarded by the live loop flag — so turning Loop off
    // mid-cycle still ends the run, and turning it on never trips the stop
    t.schedule((time) => {
      if (!loopRef.current) Tone.getDraw().schedule(() => stopPlayback(), time);
    }, end);
    t.loopStart = 0;
    t.loopEnd = end;
    t.loop = loop;
    t.position = 0;
    playingRef.current = true;
    setPlaying(true);
    t.start();
  }, [prog, tempo, loop, ensure, playVoiced, voicings, stopPlayback]);

  // the toggles reach into a run already in progress
  useEffect(() => { Tone.getTransport().bpm.value = tempo; }, [tempo]);
  useEffect(() => {
    loopRef.current = loop;
    if (playingRef.current) Tone.getTransport().loop = loop;
  }, [loop]);

  // editing the progression invalidates what's scheduled against it
  useEffect(() => {
    if (playingRef.current) stopPlayback();
  }, [prog, root, mode, add7, voiceLead, stopPlayback]);
  useEffect(() => stopPlayback, [stopPlayback]); // and stop on unmount

  const undo = () => setProg((p) => p.slice(0, -1));
  const clear = () => setProg([]);

  // inversion scrolling: nudge one chord's register by an octave at its extreme,
  // and play the result so the change is audible
  const invert = useCallback(
    (i, dir) => {
      setProg((p) =>
        p.map((c, j) => (j === i ? { ...c, inv: (c.inv || 0) + dir } : c))
      );
      if (voicings[i]) playVoiced(applyInversion(voicings[i], dir), 0.8);
    },
    [voicings, playVoiced]
  );
  const changeKey = (r, m) => { setRoot(r); setMode(m); setProg([]); setQuery(""); };

  const [copied, setCopied] = useState(false);
  const share = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
    } catch {
      // clipboard blocked (insecure context / permissions) — select-and-copy fallback
      const el = document.createElement("textarea");
      el.value = window.location.href;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      el.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }, []);

  return (
    <div className="ce-root">
      <style>{CSS}</style>

      <header className="ce-head">
        <div className="ce-brand">
          <span className="ce-mark" aria-hidden="true">↳</span>
          <div>
            <h1>Chord Paths</h1>
            <p className="ce-sub">
              Pick a chord, hear it, and follow where it wants to go.
            </p>
          </div>
        </div>

        <div className="ce-controls">
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

          <button
            className={"ce-toggle" + (voiceLead ? " on" : "")}
            aria-pressed={voiceLead}
            onClick={() => setVoiceLead((v) => !v)}
            title="Use inversions to minimise the distance each voice moves between chords"
          >
            Voice-leading
          </button>

          <button
            className={"ce-toggle" + (arp ? " on" : "")}
            aria-pressed={arp}
            onClick={() => setArp((v) => !v)}
            title="Roll each chord's notes up one at a time instead of playing them together"
          >
            Arpeggio
          </button>

          <button
            className={"ce-toggle" + (loop ? " on" : "")}
            aria-pressed={loop}
            onClick={() => setLoop((v) => !v)}
            title="Repeat the progression until you press Stop"
          >
            Loop
          </button>

          <label className="ce-field ce-tempo">
            <span>Tempo {tempo}</span>
            <input
              type="range" min="60" max="140" value={tempo}
              onChange={(e) => setTempo(Number(e.target.value))}
            />
          </label>
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
            <button
              className={"ce-share" + (copied ? " copied" : "")}
              onClick={share}
              disabled={!prog.length}
              title="Copy a link to this progression"
            >
              {copied ? "✓ Copied" : "Share"}
            </button>
          </div>
        </div>

        <div className="ce-stage">
          <div className="ce-roll" ref={rollRef}>
            {prog.length ? (
              <PianoRoll
                prog={prog}
                voicings={voicings}
                playingIdx={playingIdx}
                keyRoot={key.root}
                spawn={spawn}
                colsRef={colsRef}
                onPlay={(i) => playVoiced(voicings[i])}
                onPlayNote={(m) => playVoiced([m])}
                onInvert={invert}
              />
            ) : (
              <p className="ce-empty">
                Pick a chord from the futures — it plays, and the roll starts here.
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
            listKey={`${prog.length}|${root}|${mode}|${add7}|${susOn}|${voiceLead}`}
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
//  FUTURES — every chord that could come next, one line each, most tense first
// ------------------------------------------------------------------------
const MAX_TENSION = 4.5; // the top of the tension meter, matching the engine's range

function FutureList({
  options, total, current, keyRoot, fromMidi, voiceLead, exiting, listKey, listRef,
  query, onQuery, hiddenBy, onPick, onPreview,
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
          <span
            className="ce-futures-axis"
            title={filtering ? undefined : "Rows are ordered by how much tension the chord carries"}
          >
            {filtering ? `${options.length} of ${total}` : "tension ↓"}
          </span>
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
      onMouseEnter={() => onPreview(opt)}
      onClick={() => onPick(opt, ref.current)}
      title={
        `${opt.name} — ${notes}` +
        (opt.motion ? ` · root ${opt.motion}` : "") +
        `\n${opt.move}`
      }
    >
      <span className="ce-fu-tension" aria-hidden="true"><i /></span>
      <span className="ce-fu-name">{opt.name}</span>
      <span className="ce-fu-roman">{opt.roman}</span>
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
const ROLL = { ROW: 11, CELL: 18, COL: 84, GAP: 10 }; // px per semitone, pill, column, gap

// semitone step as a sequencer would read it: +2, -3, 0 for a held voice
const signed = (n) => (n > 0 ? `+${n}` : `${n}`);
const stepTitle = (n) =>
  n === 0
    ? "this voice holds"
    : `this voice moves ${signed(n)} semitone${Math.abs(n) === 1 ? "" : "s"}`;

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

function PianoRoll({ prog, voicings, playingIdx, keyRoot, spawn, colsRef, onPlay, onPlayNote, onInvert }) {
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
  }

  return (
    <div className="ce-roll-scroll">
      <div className="ce-roll-inner" style={{ width }}>
        <svg className="ce-roll-links" width={width} height={bandH} aria-hidden="true">
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
            const bass = bassNameOf(midi, keyRoot);
            const inverted = bass !== rootName;
            const notes = chordNoteNames(c, keyRoot);
            // semitone travel from the previous chord (the connectors' total length)
            const dist = i > 0 ? voicingDistance(voicings[i - 1], midi) : null;
            // per-voice steps, for dialling the move into a chromatic sequencer
            const steps = i > 0 ? voiceSteps(voicings[i - 1], midi) : null;
            return (
              <div
                key={c.id}
                className={"ce-roll-col" + (i === playingIdx ? " playing" : "")}
                style={{ "--c": HUE[hueOf(c.func)], width: COL }}
              >
                <span className="ce-roll-notes" style={{ height: bandH }}>
                  {[...midi].sort((a, b) => a - b).map((m, v) => {
                    const step = steps ? steps.get(m) : undefined;
                    return (
                      <button
                        key={m}
                        type="button"
                        className={
                          "ce-roll-note" +
                          (prevSet && prevSet.has(m) ? " held" : "") +
                          (born ? " spawn" : "")
                        }
                        // --dx / --dy are measured after layout, in the parent
                        style={{
                          top: topOf(m),
                          ...(born ? { animationDelay: `${v * 52}ms` } : null),
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
                </span>
                <div className={"ce-roll-tilewrap" + (born ? " spawn" : "")}>
                  <button
                    type="button"
                    className="ce-roll-tile"
                    onClick={() => onPlay(i)}
                    title={`${c.name}${inverted ? "/" + bass : ""} · ${notes.join(" ")} · ${c.move}`}
                  >
                    <span className="ce-chip-name">
                      {c.name}
                      {inverted && <span className="ce-chip-slash">/{bass}</span>}
                    </span>
                    <span className="ce-chip-roman">{c.roman}</span>
                    {dist != null && (
                      <span
                        className={"ce-chip-dist" + (dist <= 2 ? " smooth" : dist >= 7 ? " far" : "")}
                        title={`${dist} semitone${dist === 1 ? "" : "s"} of voice movement from the previous chord`}
                      >
                        Δ{dist}
                      </span>
                    )}
                  </button>
                  <span className="ce-roll-invert">
                    <button
                      type="button"
                      className="ce-inv-btn"
                      onClick={() => onInvert(i, +1)}
                      aria-label="Raise the lowest note an octave"
                      title="Raise the lowest note an octave"
                    >
                      <Chevron up />
                    </button>
                    <button
                      type="button"
                      className="ce-inv-btn"
                      onClick={() => onInvert(i, -1)}
                      aria-label="Lower the highest note an octave"
                      title="Lower the highest note an octave"
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

.ce-head{display:flex; flex-wrap:wrap; gap:16px; justify-content:space-between; align-items:flex-start;}
.ce-brand{display:flex; gap:12px; align-items:flex-start;}
.ce-mark{font-size:26px; line-height:1; color:var(--tension); transform:translateY(2px);}

.ce-controls{display:flex; flex-wrap:wrap; gap:10px; align-items:flex-end;}
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
.ce-transport button:first-child{background:var(--ink); color:var(--panel); border-color:var(--ink);}
.ce-transport button:first-child:disabled{background:var(--bg); color:var(--ink);}
.ce-transport button.ce-playing{background:var(--tension); border-color:var(--tension); color:var(--panel);}
.ce-share.copied:not(:disabled){background:var(--ink); color:var(--panel); border-color:var(--ink);}

.ce-empty{font-size:13px; color:var(--muted); line-height:1.5; margin:4px 0; max-width:60ch;}

.ce-curve{width:100%; height:46px; display:block; margin:2px 0 12px;}
.ce-curve-base{stroke:var(--line); stroke-width:.5; stroke-dasharray:1.5 1.5;}
.ce-curve-line{fill:none; stroke:var(--ink); stroke-width:1; opacity:.55; vector-effect:non-scaling-stroke;}

/* stage: the roll on the left, the futures fanning out on the right */
/* the roll takes only the width its chords need, so a short progression leaves
   the futures room to breathe; past that it shrinks and scrolls internally */
.ce-stage{display:flex; align-items:flex-start; gap:18px;}
.ce-roll{flex:0 1 auto; min-width:0; overflow-x:auto; padding:2px 0 4px;}
.ce-roll-inner{position:relative;}
.ce-roll-links{position:absolute; top:0; left:0; z-index:0; overflow:visible; pointer-events:none;}
.ce-roll-link{stroke:var(--ink); stroke-width:1; opacity:.13;}
.ce-roll-link.held{opacity:.24;}
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
.ce-roll-note:hover .ce-roll-step, .ce-roll-col.playing .ce-roll-step{color:var(--ink);}
.ce-roll-note.held{
  background:color-mix(in srgb, var(--c) 30%, var(--panel));
  border-color:var(--c);
}
.ce-roll-note:hover{background:color-mix(in srgb, var(--c) 42%, var(--panel)); border-color:var(--c);}
.ce-roll-note:active{transform:scale(.94);}
.ce-roll-note:focus-visible{outline:2px solid var(--ink); outline-offset:1px;}
.ce-roll-col.playing .ce-roll-note{background:color-mix(in srgb, var(--c) 40%, var(--panel)); border-color:var(--c);}

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

.ce-roll-tilewrap{display:flex; align-items:stretch; gap:4px;}
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
.ce-futures{flex:1 1 auto; min-width:min(430px, 100%); display:flex; flex-direction:column; gap:7px;}
.ce-futures-head{display:flex; align-items:center; justify-content:space-between; gap:10px;}
.ce-futures-tools{display:flex; align-items:center; gap:9px; flex:0 0 auto;}
.ce-futures-axis{
  font-family:var(--mono); font-size:10px; color:var(--muted); letter-spacing:.06em;
  min-width:6.2em; text-align:right; /* holds width as the count swaps in */
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
  display:grid; grid-template-columns:14px 5.4em 4.4em 2.9em minmax(0,1fr);
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
.ce-fu-name{font-size:14.5px; font-weight:600; letter-spacing:-.01em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
.ce-fu-roman{font-family:var(--mono); font-size:10.5px; color:var(--c); font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
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

@media (max-width:820px){
  /* not enough width to sit side by side — futures stack under the roll */
  .ce-stage{flex-direction:column;}
  .ce-roll{width:100%;}
  .ce-futures{flex:1 1 auto; width:100%;}
}
@media (max-width:560px){
  .ce-controls{width:100%;}
  .ce-future{grid-template-columns:12px 4.6em 4.2em 2.7em minmax(0,1fr); gap:6px;}
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
