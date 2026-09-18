# Chord Paths — agent briefing

A browser tool for exploring chord progressions by ear and by function. Pick a chord,
it plays, and it shows the moves that follow — each tagged with its **root motion**
("up a fourth") and what it **does** harmonically ("Deceptive cadence — you expect home,
you get the relative minor"). Build a progression, watch its tension rise and resolve,
play it back. No backend, client-side only, [Tone.js](https://tonejs.github.io/) for audio.

See [README.md](README.md) for the human-facing pitch, design rationale, and roadmap.

## Running it

The app is a Vite + React project living in [app/](app). The working copies Vite serves are
[app/src/harmony.js](app/src/harmony.js) (engine),
[app/src/synth.js](app/src/synth.js) (the synth's parameter model),
[app/src/ChordExplorer.jsx](app/src/ChordExplorer.jsx) (UI) and the two suites
[app/src/harmony.test.js](app/src/harmony.test.js) and
[app/src/synth.test.js](app/src/synth.test.js). **Edit those** — that's what runs. The
repo root mirrors all five as the canonical copies; `cp` them over at a checkpoint.

```bash
cd app
npm install
npm run dev        # http://localhost:5173/chord_explorer/ (redirects there from /)
npm test           # vitest run — the engine suite
npm run lint       # oxlint
```

There is no root `package.json`; every script above runs from `app/`.

**Deployment.** `.github/workflows/deploy.yml` builds `app/` and publishes `app/dist` to
GitHub Pages on every push to `main`, gated on lint and the engine suite. Pages serves the
repo at `/chord_explorer/`, so `vite.config.js` sets `base` to match — which is also why the
dev server lives under that path rather than at `/`. Change the repo name and that `base`
has to change with it, or every asset 404s.

Audio starts on your first press — any click or key (browsers block autoplay until a gesture — expected). Fonts
load from Google Fonts via `@import`; offline it falls back to system fonts and still works.

**Setup gotcha:** Tone.js imports `tslib`, which the current rolldown-based Vite doesn't
auto-resolve. If you see `Failed to resolve import "tslib"`, run `npm install tslib` in
`app/` and restart the dev server (clear `node_modules/.vite` if it was cached).

## Architecture

Two **pure, import-free model modules** — [app/src/harmony.js](app/src/harmony.js) (the
functional-harmony engine) and [app/src/synth.js](app/src/synth.js) (the synth's parameter
model) — and a **React/Tone.js presentation layer** in
[app/src/ChordExplorer.jsx](app/src/ChordExplorer.jsx), which imports both modules' named
exports. Keep that seam clean; it's the main lever for testability and for everything on the
roadmap. Neither model has **any imports at all** — not React, not Tone — so
[app/src/harmony.test.js](app/src/harmony.test.js) and
[app/src/synth.test.js](app/src/synth.test.js) run in plain Node with no audio context.

`synth.js` is the same bargain as `harmony.js`, applied to sound: it knows what the knobs
are, what they mean, what a preset is and how a patch packs into a URL, and it builds no
audio nodes. Reading it top to bottom: **`SYNTH_PARAMS`** (one entry per control — range,
`log` scaling, formatting, and the tooltip that is the only place each control explains
itself), **`SYNTH_GROUPS`** (derived from each param's `group`, so a new knob only has to
name its column to appear in it), **`PRESETS`**, **`paramToPos`/`paramFromPos`** (sliders
always run 0–1000 integers whatever they control — float `step` drifts and a log parameter
has no usable linear step), **`packSynth`/`unpackSynth`**, **`lfoRange`**, and
**`velocityCurve`**.

The engine, reading top to bottom:

- **Pitch-class layer** — `SHARP` / `FLAT` / `FLAT_KEYS`, `nameOf`. Notes are integers
  0–11; spelling is cosmetic and never affects audio.
- **Scales & function tables** — `STEPS`, `ROMAN`, `FUNC` (function + tension value per
  scale degree, per mode).
- **`classify(intervals)`** — turns a set of semitone intervals into a chord quality,
  display suffix (`m7`, `maj7`, `°`, `ø7`…), and roman-numeral suffix. Source of truth
  for how a chord is named.
- **`suspensionsFor(key)`** — sus2/sus4 forms, built from the diatonic triads **and the
  borrowed colour chords** (so G major's ♭VII gets `Fsus4`), deduped by root+kind since a
  major and minor triad on the same root suspend identically. Secondary dominants are
  skipped on purpose — remove the 3rd and the defining tritone goes with it. Shown only
  when the **Sus** toggle is on, but always in the URL-decode pool.
- **`buildKey(root, mode)`** — returns `{ diatonic[7], colour[], scale }`. Diatonic chords
  are built by **stacking scale thirds** (so 7ths come out correct without a lookup table).
  `colour` holds secondary dominants + borrowed chords (major) or the harmonic-minor
  dominant + Dorian IV + a secondary (minor).
- **`hueOf(func)`** — function→palette mapping.
- **Voicing helpers** — `chordPitchClasses` / `chordNoteNames` (the note *names* of a chord,
  spelled to the key — used by the UI to show what's in each chord); `rootPositionMidi`
  (the chord's own tones stacked from C4); `voiceLeadMidi` (keeps each new tone nearest to
  the previous chord's notes so common tones hold and the rest step — inversions fall out of
  this); `computeVoicings(prog, voiceLead)` chains a whole progression; `bassNameOf` reads
  the lowest note for slash-chord display; `voiceSteps(prev, next)` gives the per-voice
  semitone step between two realised chords, keyed by destination midi note (`G→A` is
  `+2`) — what the roll's pills label and what you'd dial into a chromatic sequencer.
- **`bassNote(rootPc, prev)` / `bassLine(prog)`** — the optional **Bass** voice: each chord's
  root, in the octave nearest the previous bass note, inside a fixed D2–F3 window
  (`BASS_LOW`/`BASS_HIGH`) — so it moves like a bass line (G→C up a fourth) rather than
  leaping a seventh whenever B goes to C, and small speakers still carry it. **Kept apart from
  the voicings, never folded into them:** `voiceLeadMidi` places each new tone nearest the
  previous chord's notes, and a bass note among them would drag new tones down towards it. So
  the component keeps `voicings` as the upper voices — what voice leading chains from and
  what every Δ measures (the bass's motion is root motion, which the copy already names) —
  and derives `played[i] = { upper: voicings[i], bass: bass[i] }` for what actually sounds. The bass goes on
  after inversions. **`bassPcOf(chord)`** picks which chord tone it is: the root, until the
  tile's ▲/▼ say otherwise — the same `inv` that rolls the upper voices walks the bass through
  the chord tones (+1 the 3rd, +2 the 5th, −1 the top tone, wrapping), so one press re-voices
  the chord *and* moves the bass, and nothing new goes in the URL. The tile's slash names the
  bass voice when it's on, the bottom of the voicing when it's off. Note the two modes read
  `inv` differently: with the bass on it counts chord tones **from the root**; with it off it
  rolls **from wherever voice leading put the chord** — so the same presses can read G/B with
  the bass and G/D without. Deliberate: forcing them to agree would mean overriding voice
  leading in the bass-off mode.
- **`resolveKey(root, mode, add7)`** — `buildKey`, restacked as sevenths when the 7ths
  toggle is on. Pure, so the URL decoder can rebuild the exact pool a shared progression was
  chosen from.
- **`midiToNotes`** — midi ints → the note strings Tone wants (`"C#4"`), in plain
  arithmetic. Matches `Tone.Frequency(m, "midi").toNote()` exactly, and keeps the engine
  import-free.
- **`motionLabel()`** — root-motion description.
- **`SPECIAL` / `ROLE` / `moveDescription()`** — the contextual "what this move does" copy.
  `SPECIAL` keys named cadences by `fromDegree>toDegree`; `ROLE` is the destination-only
  fallback.
- **`decorateChain(chords, mode)` / `resolutionMove(name)`** — turn a bare chord sequence
  into progression items, each read relative to the one before it. The URL decoder and
  `suggestLoop` both go through it, so a reconstituted, suggested and hand-picked chord carry
  identical fields; `resolutionMove` is the single home for that one sentence, which had been
  written out in three places. Extracting it made `motionLabel`, `moveDescription` and
  `isResolution` unused in the presentation layer — a good sign the duplication was real.
- **`suggestLoop(key, { bars, rand })`** — a weighted walk over the transition graph, using
  the same `score()`/`salience()` tables that rank the chooser, so a suggestion is idiomatic
  for the same reasons the top of the futures list is. `rand` is **injected**, not
  `Math.random` reached for internally: that keeps the engine a pure function of its inputs
  and lets tests pin a seed. Three structural rules do more for the output than the weights
  do — no adjacent repeats, no A–B–A oscillation on interior bars, and the last bar can't be
  the tonic, since it is adjacent to the first when the loop comes round. Without the A–B–A
  ban the walk falls into `C A7 C G`, because the tonic's salience pulls it home every other
  bar. Suspensions are excluded: they're a colour you add to a chord, not a skeleton.
- **`isResolution(prev, next)`** — does the move discharge what `prev` was leaning on?
  Root-matching alone isn't enough: a suspension resolves to its *own* root, so that would
  call `Fsus4 → Fsus2` a resolution (and `Fsus4 → Fsus4` one too). The second clause,
  `next.resolvesTo !== next.rootPc`, rules the sus siblings out while keeping the plain
  triad — and `Fm`, which is also a real resolution of `Fsus4`. **Both `optionsFrom` and
  the URL decoder call this**; they used to compute it separately, which is exactly the
  kind of drift that makes a shared progression disagree with a chosen one.
- **`score()` / `salience()` / `optionsFrom(current, key)`** — ranks the next-chord options.
  `optionsFrom` is what the UI calls; it decorates each option with `move`, `motion`, and a
  `resolution` flag.
- **The face is a piece of hardware** — [design/hardware.html](design/hardware.html) is the
  static mockup it was built from, and the reference for anything visual. One white chassis
  (`.ce-chassis`), modules set into it with 2px seams (the chassis colour showing through the
  grid gap), each with a printed number and name (`ModHead`): **01 Key** (root, mode, 7ths,
  Sus), **02 Generate** (Suggest + bars, Mutate + amount, Evolve), **03 Playback** (voicing,
  bass, hold bass, loop, arpeggio, -4-, tempo), **04 Out** (route and MIDI port), then the
  display with the **transport** beside it, **05** the futures and **06 Sound**. Generate sits
  with Key rather than the transport because it sets up material rather than editing what's
  there — the same reason changing key clears the progression. Four columns, two below
  1400px, one below 900px. Sharing is about the page, so it's an icon on the nameplate. The
  whole face is built from a few parts, defined together after the component:
  **`Keys`** (a row of keys with cut-out legends, the chosen one lit — every former dropdown
  became one, so the choices are always in view), **`Toggle`** (a key that stays lit, set in
  a `.ce-bg` alone or with others), **`RootKeys`** (the key laid out as an octave),
  **`Steps`** (Mutate's amount as four lines) and **`Level`** (below). Legends are words where
  a word is short and small line drawings (`SYM`, `WAVE_SYM`) where it isn't — cryptic on
  purpose, with a tooltip on every key. **One lamp colour** lights everything that's on: a
  random pick from `LAMPS` on each visit, changeable from the dots above the chassis, set as
  `--lamp` on `.ce-root`; not in the URL, since it's about the visit, not the progression.
  Pressing the key or mode that's already lit must not clear the progression, hence the
  early return in `changeKey`.
- **`Level`** — what every slider became: a row of thin bars, lit in ink up to the value. It
  replaces a range input, so it carries `role="slider"`, `aria-valuetext`, arrows (Shift for
  ten), Home and End. `pos` is 0–1 and the caller maps it; `onStep` optionally owns the
  arrows (tempo's 120 bars, 30–150, are one BPM each, and an arrow is one BPM). The drag is driven from
  `window` listeners that also let go when `buttons` is 0 — the same lesson as the roll's
  reordering. `onCommit` fires on release, which is when the Sound module auditions.
- **`useMidiOut()`** — behind module 04's **Route** keys (Int / MIDI) and port list. `status` is a small state machine
  (`unsupported | insecure | idle | asking | ready | denied`) whose copy lives in
  `MIDI_STATUS`; on a successful enable it selects the first available port straight away —
  you didn't grant MIDI access to keep hearing the built-in synth — but only there, never on
  a later `onstatechange`, since a device appearing mid-session shouldn't reroute you without
  asking. Support and secure context are checked **before** the control is offered,
  because Safari has never shipped Web MIDI and a dead dropdown explains nothing. Access is
  requested without sysex (notes don't need it, and asking prompts harder) from a click, and
  `onstatechange` refreshes the port list on hot-plug. `send` rebases Tone's audio clock onto
  the `performance.now()` stamp `output.send` wants. Picking a port **replaces** the synth
  rather than doubling it. `panic()` is not optional politeness: hardware holds a note until
  told otherwise, so Stop and every port change do `clear()` (drop queued note-offs, or they
  land after the reset) then all-notes-off. Not persisted to the URL — port ids are
  machine-local and a shared link carrying one would be nonsense. The **channel** (`Chan`,
  sixteen keys four by four, live only while routed to MIDI) follows the same rule: it's
  about your rig, not the progression. Changing it panics the old channel first, exactly as
  changing port does.
- **`useSynth(sound)`** — the chain the Sound panel drives:
  `PolySynth → Filter → Distortion → Chorus → Reverb → Destination`, with an **LFO on the
  filter's cutoff**. Audio starts on the first **`pointerdown` or `keydown` anywhere on the
  page**, from capture-phase listeners on `window` — **never from a `click` handler**. Safari
  27, under its default Auto-Play setting ("Stop Media with Sound"), grants user activation at
  `pointerdown` and has withdrawn it by `pointerup` (measured: 167ms later, `isActive` false by
  the time `click` fires), so a context resumed from a click hangs and goes `"interrupted"` —
  silently, on every site, HTTPS included. Key presses keep activation throughout, which is why
  keyboard-played pages never noticed. `unlock()` runs on every press: the first swaps in a
  fresh `Tone.Context` (Tone creates one at *import* — its deprecated top-level exports
  `Transport`, `Destination`, `Draw` each call `getContext()` as the module loads — and nothing
  has used it), then **calls** `Tone.start()` synchronously inside the press; later presses
  restart a context the browser suspended between gestures. The chain is built only once that
  start has *resolved*, because the filter LFO and the chorus's own LFOs start as they're
  built, and starting a source on a suspended context gets Tone's `The AudioContext is
  "suspended"` warning — the one that means audio is broken, so it must not fire when audio is
  fine. **`ensure()` starts nothing.** It waits on the press's in-flight start (a click handler
  runs moments after its own `pointerdown`, usually before `resume()` resolves), bounded by
  `settle()` because a refusing browser leaves `resume()` pending forever, and before any
  press it answers `null`. That's the other half of the fix: the futures list auditions on
  **hover**, and on the way to clicking a row the pointer crosses other names, so audio used
  to get set up from a `mouseenter` — not a gesture, blocked, and the block stuck. Callers of
  `ensure()` bail on `null`. **`blocked`** is the other thing it returns: a
  second after a press asked for audio, the context either runs or it doesn't, and if it
  doesn't the progression view shows a dismissible **"No sound?"** notice with the Safari
  Auto-Play path (host name filled in) and a generic hint for other browsers. Judged by what
  happened, not by sniffing the browser, so it covers Safari's "Never Auto-Play" and anything
  else that refuses, and never appears when sound works; a later press that gets through
  clears it. Dismissal is per visit and not in the URL. `live` is a ref so the chain comes up with the settings in force
  at the first press, not the ones from mount. Everything after the synth is built **once** and left in place, wet at zero where
  that means off — rebuilding the chain when a slider moves would cut the sound you're
  trying to listen to — and `applySound(nodes, s)` retunes what already exists. That's the
  whole point of a knob, and it's why a preset change mid-playback just re-voices the run.
  Two details bite if you touch it: **the LFO owns the cutoff outright**, because connecting
  a signal to a `Tone.Signal` *replaces* its value rather than adding to it, so the sweep's
  endpoints have to carry the cutoff setting themselves (`lfoRange`, centred in octaves;
  depth 0 collapses `min` and `max` together, which is exactly a filter that isn't moving).
  And `reverb.decay` is the one setter that re-renders an impulse response — async and
  audible — so it's applied only when the value has actually changed. `ensure` returns the
  `PolySynth`; `release` exists because `Transport.stop()` unschedules what hasn't played
  but a note already triggered rings out on its envelope.
- **`velocityCurve(midi, sound, rand)`** (in `synth.js`) — per-note velocity and a few ms of
  onset drift. A chord with every voice at the same velocity is an organ; **Dynamics**
  spreads them (firm bass, singing top, inner voices tucked under) and **Humanise** scatters
  the result. `rand` is **injected**, the same bargain `suggestLoop` makes, and it draws the
  same number of times whatever Humanise is, so turning it down doesn't reshuffle which note
  gets which wobble. This is why `playVoiced` triggers **note by note** rather than handing
  `triggerAttackRelease` the whole chord — per-note velocity needs per-note calls.
  `playVoiced` hands the same **list of note events** (pitch, onset, length, velocity) to the
  synth or the MIDI port, so the two can't drift apart. The list comes from **`chordEvents
  (upper, bass, opts, rand)`** in `synth.js` — pure, so block chord vs arpeggio, the arp order,
  `-4-`, hold bass, velocity and humanise are all decided in one tested place. Chords travel
  through the component as **`{ upper, bass }`**, the bass named rather than folded in as the
  lowest note: it isn't always the lowest (an inversion can roll an upper voice under it), and
  hold bass has to know which note it is.
  Dynamics and Humanise are about how a chord is *played* rather than how it sounds, so they
  go out the **MIDI port too**; everything else in the panel is timbre, which belongs to
  whatever instrument is on the other end.
- **The Sound module** — module 06, always open at the foot of the face, driven entirely off
  `SYNTH_PARAMS`, so adding a knob is a line in that table rather than a line of markup: a
  number becomes a `Level`, an enum (the wave) becomes `Keys` with `WAVE_SYM` legends.
  The one drawing is **`EnvelopeGraph`**, beside the Envelope heading: the ADSR as a shape,
  its segment widths taken from the levels' positions rather than from seconds — attack is on
  a log scale from 2ms, and drawn in linear time a short attack is just a vertical line.
  Releasing a level **auditions** the chord you're on (or the key's tonic, if the progression
  is empty) — you can't design a sound you can't hear — but not while playback is running,
  which is already making the point. The preset name is **derived** by comparing values
  rather than stored, so a shared link carrying only numbers still opens with the right
  preset lit, and nudging one level honestly lights **—** (custom).
- **Random start** — `boot` is `decodeState(search) || randomStart()`: only a URL with **no
  query string at all** gets a random key and a 4-bar suggestion; any parameter, even `?k=0`,
  opens exactly as written, so a shared link or a reload is never re-rolled. The URL sync
  then writes the rolled state into the address bar, so a reload keeps it.
- **URL sync** — the query string is computed every render (`path`), but written to the
  address bar only after 300ms without a change, and flushed on `pagehide`. Never per change:
  a slider drag changes state every frame, and Safari allows 100 `replaceState` calls per 10
  seconds and then **throws** — from inside an effect, which unmounts the whole app to a white
  page (Chrome just throttles, with a warning). `writeUrl` swallows a failed write regardless;
  a lagging address bar is cosmetic. Share copies the computed `path`, not `location.href`,
  so it never copies a URL that's up to 300ms stale.
- **Playback runs on `Tone.getTransport()`** as **one repeating tick per chord slot**
  (`scheduleRepeat`), and each tick reads the progression *live* from `liveRef` at a
  `cursor`. So an edit made while it plays (an inversion, a reorder, a chord added or
  removed, voice-leading or bass toggled) is just heard on the next slot, and the loop never
  breaks pace. Only a key/mode change stops a run. `liveRef` is assigned **during render**,
  not in an effect, so it is never a passive effect behind the state. The **end of a cycle**
  is the one place the progression is swapped: a queued progression lands there, and the
  swap happens *inside the tick* (`live.played = next.played`, then `land()`), because Tone
  runs callbacks ~100ms ahead of the audio and waiting on React would play bar 1 of the old
  one. Loop is read there too, via `loopRef`, so turning it off mid-cycle ends the run at
  that cycle's end. Events are in Transport time, so tempo rescales a run in flight.
  Scheduled callbacks call **`playVoicedRef.current`** and **`stopRef.current`**, never the
  closures — a MIDI port or Arpeggio change must reach a run in flight, and listing
  `stopPlayback` as an effect dependency would stop playback on every port change.
  **Space** plays and stops (`playAllRef`, from a `window` listener registered once), from
  anywhere but a text field. It swallows **both** halves of the press: clicking any key on the
  face leaves it focused, and a focused button activates on Space's keyup, so without that
  Space would also toggle Loop or clear the progression. Enter still presses a focused key.
- **Generations, the queue, Mutate and Evolve.** State is `hist = { gens, cur }`; `prog` is
  `gens[cur]` and `setProg` edits it in place, so hand edits never add history. Suggest,
  Mutate, Evolve and Clear add a generation (`pushGen`; an empty current one is written over,
  capped at `MAX_GENS`). The history is per visit and **not in the URL**; a key change resets
  it. While playing, Suggest, Mutate and a history pick don't cut in: they set **`queued`**
  (`suggest | mutate | goto`), shown dashed at the right of the `.ce-gens` strip, and land at
  the end of the cycle. Stop lands anything you queued rather than dropping it. A queued
  **mutation is derived, not stored**: `nextProg` re-runs `mutateLoop(prog, key, { rand:
  seededRandom(seed), previous })` every render until it lands, so edits made while it waits
  are carried into it, and the seed keeps it the same mutation. **Evolve** (`ev=1`, needs
  Loop) is an effect that queues an `auto` mutation whenever a looping run has nothing
  queued; Stop drops an `auto` one, since it was only ever for next time round.
  The **mutation level** (the select beside Mutate, `ml=` when not 1) is 1–4 quarters of
  the bars, read live, so Evolve and a waiting mutation both follow it.
  **`mutateLoop`** (in `harmony.js`) re-picks `level` quarters of the bars (at least one).
  Levels 1–3 never touch bar 1; level 4 is deliberately the extreme setting and re-picks
  **every** bar, bar 1 included, so the loop needn't start at home any more. It picks with the
  same `loopWeight` as `suggestLoop` (times how well the pick leads into the next bar), keeps
  every other bar as it was, `inv` and `id` included, and won't put back what a bar held in
  the `previous` generation. Without that, evolving a 4-bar loop flips one bar back and forth.
- **Component + `FutureList` / `FutureRow` + `PianoRoll`** — state is `root, mode, add7,
  voiceLead, bassOn, arp, arpFour, arpOrder, holdBass, loop, evolve, tempo, hist, queued, playingIdx, playing`, plus `exiting` / `spawn` for the
  choose choreography. **Arpeggio** makes `playVoiced` play one note per step, the steps
  spread evenly across the chord's slot (`span` — the whole slot in playback, so the last step
  runs straight into the next chord), each note gated to 0.9 of its step with the envelope's
  release ringing on. It used to be a strum — 0.16s-apart onsets held to the end of the slot —
  which left a triad finished in a third of a second and then silent: the "pause after the
  third note". The order comes from **`arpSequence`** in `synth.js`, pure with `rand`
  injected: `arpOrder` is `rise` or `random` (a fresh Fisher–Yates shuffle each time the chord
  plays), and **`-4-`** (`arpFour`) pads a three-note chord to four steps by returning to the
  second note played — 1 3 5 3 rising — so triads and sevenths keep the same rhythm. Chords of
  four or more notes play as they are. **hold bass** (`holdBass`, needs Bass on) decides where
  the bass voice goes: off, it's the arpeggio's first step — so with -4- a triad over a bass
  plays B 1 3 5; on, it sounds for the chord's whole `dur` under an arpeggio of the upper
  voices — 1 3 5 3 over a held B. URL: `a4=1`, `ao=rnd`, `bh=1`. On the face, block / rising /
  random is one row of keys (`arpMode` folds `arp` and `arpOrder` together), with -4- and hold
  bass beside it, disabled while they can't apply. `PianoRoll` renders the progression as columns where each voice sits at
  its pitch height (`top = (max - midi) * ROW`), so common tones line up across columns and
  voice leading is visible; a note common with the previous chord gets a `held` style (a dashed outline). During playback each pill is
  **lit** (`lit`, a Set of midi) from its own onset to its own release: `playVoiced` takes an
  `onLight` callback and schedules it on `Tone.getDraw()` from the same `chordEvents` that
  sound, so an arpeggio walks up the column, a held bass stays lit under it, and a block
  chord lights together. The roll sits on a **mono e-ink panel** (`.ce-screen`): ink on paper
  and nothing else, so a lit pill is filled solid ink and the chord that's sounding gets a
  cursor bar under its tile. Stop cancels the Draw queue so no stray light lands afterwards. A
  behind-the-columns SVG draws ink **connectors** pairing voices by ascending pitch across
  adjacent chords, right-angled the way a panel draws — along from the right edge of one pill,
  up or down at an elbow, along into the next (a held voice is one straight line). Each
  voice turns at its own point in the gap, lower voices sooner and higher ones later (0.4 /
  0.5 / 0.6 of the way for a triad, `ELBOW_STEP` apart): with one shared midpoint, a big move
  stacked every vertical run on the same line and you couldn't tell which voice went where. Fixed `ROLL` geometry (`ROW/CELL/COL/GAP`) keeps the
  SVG and the flex columns on the same coordinates. The bass voice gets its **own lane** under
  the chords (`ROLL.LANE` gap, dashed rule) rather than its true height, which would open a
  tall band of empty rows between the two; pitch is to scale within each lane. Each note pill is its own button (plays
  that single note via `onPlayNote`) and carries its **semitone step from the previous
  chord** at its right edge — voices paired by ascending pitch, the same pairing the
  connectors use, so a voice with no counterpart (a triad growing into a seventh) is
  simply left unlabelled; the chord tile under each column plays the whole chord
  (`onPlay`). The column itself is a plain container — buttons can't nest, which is also why
  the remove **×** is a sibling of the tile positioned over its corner rather than inside it.
  The tile's Δ sits on the roman line, so the first tile, which has none, is the same
  height without a placeholder.
- **Reordering** is pointer-based, not HTML5 drag-and-drop: the columns are a uniform grid,
  so the target index is arithmetic on `clientX` against `colsRef`, and `prog` is reordered
  *live* as you cross a boundary, which lets you watch the voice leading re-solve mid-drag.
  `clickBlocked` is a **separate** ref from `drag`, and that separation is load-bearing: the
  click that ends a drag fires in the same task as `pointerup`, after `onDragEnd` has already
  cleared `drag.current`, so a flag living on the drag object is gone by the time the click
  handler reads it — and the chord you just moved plays. It is released on the next tick.

  **The move/up listeners live on `window`, not the tile, and `setPointerCapture` is
  deliberately not used.** This was a bug: capture is implicitly released when the captured
  node is removed from the document, and reordering *moves* that node, so the capture is gone
  after the first boundary crossing. Release the button anywhere that isn't a tile — over the
  note pills, in a gap, down in the futures list — and the tile's own `pointerup` never fires,
  leaving the drag live. Since `pointermove` also fires on a **plain hover**, every subsequent
  mouse-over then reordered the progression. `onDragMove` additionally bails when
  `e.buttons === 0`, which is the invariant that makes a leaked drag self-heal rather than
  eat the next hover. Any test that drags tile-centre to tile-centre passes regardless of all
  this, because the release happens to land on a tile — aim somewhere else.
  Drag is mouse-only, so the tile also takes **Alt+←/→** to move and **Delete/Backspace** to
  remove.
- **`FutureList`** — the next-chord options, sitting **below** the roll inside the same
  progression view, as the possible futures the current chord opens onto. They were briefly
  side by side; sharing the width capped the roll at about five chords before it had to
  scroll, and the roll is the thing you're reading, so the stage stacks instead. A useful
  side effect: adding a chord no longer reflows the futures list sideways, so the flight
  origin is stable without the offset-within-the-list dance having to absorb it. One flat list
  (diatonic + colour + suspensions merged, the sort is stable so the engine's ranking
  still shows through within a tension band), **ordered by tension ascending by default** so
  the resolutions sit up top. Each `FutureRow` is one line — the tension block, name,
  degree, notes, Δ-from-here, description — and a resolution carries a **Resolves** tag in the
  lamp colour. The **tension block** is where function lives now: the function printed small
  (`tonic`, `dominant`…) over eight squares lit to the chord's tension. Below 1400px the
  description goes; below 900px the notes and degree go too, since both are derivable and in
  the row's tooltip, and the name must stay whole. **Hovering the name** auditions the chord — the name only, so
  scanning a row's description or Δ stays silent; clicking anywhere on the row commits it.
  The `tension ↑` label in the head is a button that flips the sort: ascending puts the
  resolutions on top, descending opens on the outside chords. Direction is deliberately **not** in the URL, same
  as the filter — both are ways of looking at the list, not part of the progression. There is
  no chord-tile grid below any more; this list replaced it.
- **Filtering the futures** — `normQuery` / `matchesQuery` fold the display spellings down
  to what someone would type (`bvii` finds ♭VII, `bdim` finds B°, `f#` finds F♯) and match
  on **name and roman**, not the description. Escape clears, Enter commits the top match.
  The query lives in the component and is cleared *at commit*, not on click — clearing on
  click would repopulate the list mid-exit and undo the fade. `hiddenBy` is the important
  half: for each **off** toggle it builds what that toggle would add (the `sus` pool;
  for 7ths, `optionsFrom` over `resolveKey(root, mode, true)` minus names already on
  offer) and counts query hits, so a search that finds nothing says "+3 more with Sus on"
  and offers the switch, instead of failing next to a control on the other side of the page.
- **The choose choreography** — `EXIT_MS` / `SPAWN_MS`. Clicking a row sets `exiting` to
  its `optKey`: the other rows fade right, the chosen one slides left. After `EXIT_MS`
  the chord commits and `spawn` names the new column, whose pills get `.spawn`. The
  flight vector is a **FLIP** measured in a `useLayoutEffect` in the component — the row's
  offset *within the futures list* is stashed at click time (an absolute rect would be
  stale: adding a column reflows the stage and shifts the list), then each landed pill's
  rect is measured and handed `--dx` / `--dy` back to that point. The `ce-spawn` keyframe
  plays it in reverse. Audio fires on the click, never behind the animation.
  `TensionCurve` still exists in the file but is currently not rendered (removed from the
  progression view for now), and it's the one thing still painted in the function hues. Styles live in the `CSS` template string with design tokens as
  CSS custom properties — **no backticks in that string**, they terminate the template
  literal.

## Invariants — don't break these

- **Function is load-bearing pedagogy.** Every chord *must* have a `func`
  (`tonic | predominant | dominant | subtonic | secondary | borrowed`), which the futures print
  in each row's tension block (and `hueOf` maps to a hue, for `TensionCurve`), and a numeric
  `tension`, which lights that block's meter and plots on the curve. If you add a chord type,
  wire up both. Function used to be shown as colour everywhere; the hardware redesign moved it
  into words, so the face could keep one lamp colour and a mono display.
- **The model modules are pure and import-free.** Everything in `harmony.js` and `synth.js`
  takes data and returns data — no React, no DOM, no Tone. Don't add an import to either
  file; if something needs a library, it belongs in the presentation layer. Keep the pitch
  math in plain integers. `synth.js` in particular describes the synth but never builds it:
  the moment it needs `Tone`, the split has gone wrong.
- **A knob is a row in `SYNTH_PARAMS`, not a piece of markup.** Label, range, scaling,
  formatter, group and tooltip all live in the table; the panel renders whatever is in it.
  Adding a control means adding an entry and applying it in `applySound` — and **appending**
  to the table, never reordering it, because `SYNTH_ORDER` is what every shared link's `sy=`
  was written against.
- **Audio starts on `pointerdown`/`keydown`, never on `click`.** `useSynth`'s `unlock()` is
  the only thing that calls `Tone.start()` for the first time, from capture-phase listeners on
  `window`. A click has lost its user activation in Safari 27 by the time its handler runs, so
  anything that starts audio from `onClick` is silent there — and silent with no error, which
  is how this shipped. Don't start audio from a hover either, or from module load or a bare
  `useEffect`. Testing in Chrome proves nothing about this; Chrome keeps activation through
  the click.
- **Pitch classes are integers 0–11.** All harmonic and voicing math goes through them (and
  midi integers for register). Note strings are for display and for handing to Tone, never
  for logic.
- **Voicing is derived, never stored on the chord.** `computeVoicings(prog, voiceLead)` is a
  pure function of the progression and the toggle, memoised in the component. `choose` plays
  the incremental voicing computed from the current chain end so it matches the recompute.
  Don't stash midi notes on progression items — toggling voice-leading must re-realise cleanly.
- **Tailwind is not available** and was avoided deliberately — styles are plain CSS in the
  `CSS` string. Preserve the CSS-variable token system. `.ce-root button` resets every button,
  so a component rule that sets a button's `color` or `background` needs `.ce-root` in front of
  it to outrank the reset.

## Conventions

Match the existing style: pure functions for anything harmonic, hooks for anything stateful,
copy that says what a control does in plain terms. Keep UI text concrete — a label labels, a
description describes, nothing does double duty. If a change alters harmonic behaviour, add or
update a test rather than eyeballing it.

## Roadmap

Roughly in order of fun (see README for detail):

1. ✅ **Show the notes in each chord** — done; `chordNoteNames` drives the note readout on
   option cards and the current-chord badge, and the progression is a `PianoRoll` where each
   note sits at its pitch height.
2. ✅ **Voice-leading** — done; the **Voice-leading** toggle switches playback from root
   position to `voiceLeadMidi`. The `PianoRoll` makes it legible — held voices align across
   columns — and each tile shows the resulting inversion as a slash chord.
3. ✅ **Web MIDI out** — done; `useMidiOut` + module 04, **Out**. Verified against a
   Waldorf Protein over USB-C in Chrome.
4. ✅ **"Suggest a loop"** — done; `suggestLoop` + the **Suggest** control.
5. ✅ **Make the built-in synth worth listening to** — done; `synth.js` + the **Sound**
   module. Sixteen live controls over waveform, envelope, a resonant filter with an LFO
   on its cutoff, chorus/reverb, and the velocity shaping that stops a block chord sounding
   like an organ. Presets set the sliders rather than hiding them, and the patch rides along
   in the share link.
6. **Save progressions** — localStorage or export to a small text format.
7. **Export** — MIDI file, or a chord-chart / lead-sheet string.
8. ✅ **Random start** — done; `randomStart()` gives a naked URL a random key (major or
   minor) and a 4-bar `suggestLoop`, waiting for Play. Any query string opens as written.
9. ✅ **Evolve** — done; **Mutate** (once) and **Evolve** (each time the loop comes round)
   via `mutateLoop`, with the live-cursor playback, the queue and the history strip.

### Testing

Two suites, one per model module; `npm test` runs both.

[app/src/synth.test.js](app/src/synth.test.js) covers the sound model: that every parameter
and preset is complete and in range, that the slider mapping round-trips every preset value
and puts the ends of a range at the ends of the slider, that a patch survives the URL and
reopens under its own preset name, that a short or damaged `sy=` falls back per parameter
rather than throwing the lot away, and that `velocityCurve` is flat at zero dynamics, shaped
at full, bounded under any jitter, and a pure function of its inputs.

[app/src/harmony.test.js](app/src/harmony.test.js) covers the engine: key building across
all three modes, `classify`, colour chords and suspensions, `optionsFrom` ranking and
cadence copy, and the voicing helpers (common-tone retention, inversion rolls,
`computeVoicings` purity, `voiceSteps` pairing, midi→note conversion), and the bass voice
(root, window, nearest-octave motion, always under the voicings). Run it with
`npm test` from `app/`. If a
change alters harmonic behaviour, add or update an assertion rather than eyeballing the UI.

One known wart the suite pins rather than fixes: spelling follows the **key root**, so
C Mixolydian's ♭VII prints as `A#` while its roman reads `♭VII`. Cosmetic only — audio and
ranking both use pitch classes.
