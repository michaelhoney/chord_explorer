# Chord Paths — agent briefing

A browser tool for exploring chord progressions by ear and by function. Pick a chord,
it plays, and it shows the moves that follow — each tagged with its **root motion**
("up a fourth") and what it **does** harmonically ("Deceptive cadence — you expect home,
you get the relative minor"). Build a progression, watch its tension rise and resolve,
play it back. Below it sits **the synth** it plays through: a polysynth with a resonant
lowpass/highpass filter and its own filter envelope, a scope that shows what the filter is
doing, a tiny keyboard, and MIDI in for a controller like an AKAI MPK Mini. No backend,
client-side only, [Tone.js](https://tonejs.github.io/) for audio.

See [README.md](README.md) for the human-facing pitch, design rationale, and roadmap.

## Running it

The app is a Vite + React project living in [app/](app), and everything that runs is under
[app/src/](app/src), in four folders (see **Architecture**). That's the only copy: the repo
root used to mirror the source files, but a flat mirror can't follow a folder tree, so it went
when the code was split into modules.

```bash
cd app
npm install
npm run dev        # http://localhost:5173/
npm test           # vitest run — every suite
npm run lint       # oxlint
```

There is no root `package.json`; every script above runs from `app/`.

**Deployment.** `.github/workflows/deploy.yml` builds `app/` and publishes `app/dist` to
Cloudflare Pages (project `chords`, served at chords.michaelhoney.com) on every push to
`main`, gated on lint and the test suites. `.github/workflows/check.yml` runs the same gates —
lint, tests and a build — on every pull request into `main`, so a PR shows whether it would
deploy before it's merged. The deploy needs the repo secrets
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The site is at the root of its domain,
so `vite.config.js` has `base: '/'`; serving it under a path would need `base` to match.

Audio starts on your first press — any click or key (browsers block autoplay until a gesture — expected). Fonts
load from Google Fonts via a `<link>` in `index.html`; offline it falls back to system fonts
and still works.

**Setup gotcha:** Tone.js imports `tslib`, which the current rolldown-based Vite doesn't
auto-resolve. If you see `Failed to resolve import "tslib"`, run `npm install tslib` in
`app/` and restart the dev server (clear `node_modules/.vite` if it was cached).

## Architecture

Two devices on one desk. **Chord Paths**, the explorer, is a sequencer: it decides which
chords, and how they're struck. **The synth** is an instrument: the explorer plays it, and so
do its own keyboard and a MIDI controller. [app/src/App.jsx](app/src/App.jsx) is the desk —
the only file that imports both — and holds what they share: the synth's engine (which the
explorer plays through), the page's MIDI access, the lamp colour, and whether the browser is
refusing to make sound.

```
app/src/
  App.jsx, url.js        the desk, and the address bar both devices write into
  chords/                the explorer
    harmony.js             the functional-harmony engine                  pure, no imports
    perform.js             how a chord is struck → note events             pure, no imports
    state.js               the explorer's slice of the URL                 pure
    ChordExplorer.jsx      the device; with PianoRoll, FutureList, TensionCurve (parked)
    futures.js, roll.js    small helpers the components share
  synth/                 the instrument
    params.js              the patch model: knobs, presets, wire format    pure, no imports
    dsp.js                 the display's maths: response curve, trigger     pure, no imports
    engine.js              the signal chain — the only file that builds audio nodes
    Synth.jsx              the device; with Scope and Keyboard
  midi/                  access.js (one access for the page), out.js, in.js, messages.js (pure)
  panel/                 parts.jsx, symbols.jsx, panel.css — the hardware both faces are built from
```

Keep the seams clean; they're the main lever for testability and for everything on the
roadmap. The **model modules** — `harmony.js`, `perform.js`, `params.js`, `dsp.js`,
`messages.js` — have **no imports at all**, not React, not Tone, not each other (`state.js`
builds on harmony and perform, and nothing else), so every suite runs in plain Node with no
audio context. The **explorer never builds an audio node**: it hands `chordEvents`' note
events to `engine.play` or a MIDI port, and Tone is only its clock. The **synth knows nothing
about chords**: it plays notes, from whoever sends them.

`synth/params.js` is the same bargain as `harmony.js`, applied to sound: it knows what the
knobs are, what they mean, what a preset is and how a patch packs into a URL, and it builds no
audio nodes. Reading it top to bottom: **`SYNTH_PARAMS`** (one entry per control, in the
order the panel shows them — range, `log` scaling, formatting, the tooltip that is the only
place each control explains itself, and `legacy`: what a link written before the parameter
existed gets, when that should differ from the default preset), **`SYNTH_GROUPS`** (derived
from each param's `group`, so a new knob only has to name its column to appear in it),
**`SYNTH_WIRE`** (the order a patch is written into a link — append-only, see Invariants),
**`PRESETS`**, **`paramToPos`/`paramFromPos`** (levels always run 0–1000 integers whatever
they control — float steps drift and a log parameter has no usable linear step),
**`packSynth`/`unpackSynth`/`retiredFromSynth`**, and the derived settings
**`lfoCents`/`contourCents`/`cutoffAt`**.

`synth/dsp.js` is the display's arithmetic: **`filterResponse`** (the filter's gain in dB,
from the coefficient formulas the Web Audio spec gives for BiquadFilterNode — Q read in dB,
two stages for −24dB/oct — and checked against the browser's own `getFrequencyResponse` to
within 0.00001dB, so the curve on the display is the filter you hear), **`logFreqs`/
`logPos`** (the octave axis), **`spectrumAt`** (FFT bins onto that axis: the loudest bin
between two display points, so a harmonic never falls between the cracks), and the scope's
**`scopeSpan`/`findTrigger`/`sampleFrame`** (below).

The harmony engine, `chords/harmony.js`, reading top to bottom:

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
  Sus), **02 Generate** (two lines, amount on the left and the key that acts on the right — bars
  2/4/8 then **Suggest**, amount 1/2/3 then **Mutate** — sharing grid columns (`.ce-go`) so
  the two keys match; a container query shrinks them when the four-column face narrows the
  module; then **Repeat** — Off / Loop /
  Evolve as one row of keys — and Evolve's **Every** 1/2/4/8, hung under it in `.ce-evo`: the two groups share a width, and
  a wire drops from the Evolve key onto Every, lit in the lamp colour while Evolve is on — its
  length is fixed CSS arithmetic, so it depends on `.ce-evo`'s row gap and label line-height), **03 Playback** (voicing,
  bass, hold bass, arpeggio, -4-, Dynamics and Humanise, tempo), **04 Out** (route and MIDI port), then the
  display with the **transport** beside it, and **05** the futures. Generate sits
  with Key rather than the transport because it sets up material rather than editing what's
  there — the same reason changing key clears the progression. Four columns, two below
  1400px, one below 900px. Sharing is about the page, so it's an icon on the nameplate — and
  it copies the whole desk, the synth's patch included. The synth is a second chassis below
  (see **The synth device**). Both faces are built from a few parts in `panel/parts.jsx`:
  **`Keys`** (a row of keys with cut-out legends, the chosen one lit — every former dropdown
  became one, so the choices are always in view; with `cols`, a block of them, like the 4×4
  MIDI channels and the 3×3 presets), **`Toggle`** (a key that stays lit, set in
  a `.ce-bg` alone or with others) — every key on the face stands **`--key-h`** tall by its outline, grouped or alone (the transport's `.big` keys excepted), **`RootKeys`** (the key laid out as an octave, in the explorer),
  and **`Level`** (below). Legends are words where
  a word is short and small line drawings (`SYM`, `WAVE_SYM`, `FILTER_SYM`, in `panel/symbols.jsx`) where it isn't — cryptic on
  purpose, with a tooltip on every key. **One lamp colour** lights everything that's on: a
  random pick from `LAMPS` on each visit (in `App.jsx`), changeable from the dots above the
  chassis, set as `--lamp` on `.ce-root`, which holds both devices; not in the URL, since it's about the visit, not the progression.
  Pressing the key or mode that's already lit must not clear the progression, hence the
  early return in `changeKey`.
- **`Level`** — what every slider became: a row of thin bars, lit in ink up to the value. It
  replaces a range input, so it carries `role="slider"`, `aria-valuetext`, arrows (Shift for
  ten), Home and End. `pos` is 0–1 and the caller maps it; `onStep` optionally owns the
  arrows (tempo's 120 bars, 30–150, are one BPM each, and an arrow is one BPM). The drag is driven from
  `window` listeners that also let go when `buttons` is 0 — the same lesson as the roll's
  reordering. `onCommit` fires on release, which is when the synth auditions.
- **MIDI** — one **`useMidiAccess()`** for the page (`midi/access.js`), shared by the
  explorer's Out and the synth's In: `status` is a small state machine
  (`unsupported | insecure | idle | asking | ready | denied`) whose copy lives in
  `MIDI_STATUS`, and `enable()` resolves to the access (or null), sharing one prompt between
  callers. Support and secure context are checked **before** a control is offered, because
  Safari has never shipped Web MIDI and a dead dropdown explains nothing. Access is requested
  without sysex (notes don't need it, and asking prompts harder) from a click. Each side
  watches its own ports through **`usePorts`**, a `statechange` *listener* rather than
  `onstatechange`, since both watch the same access.
  **`useMidiOut(midi)`** (`midi/out.js`) is behind the explorer's module 04 **Route** keys
  (Int / MIDI) and port list. Enabling from *there* selects the first output straight away —
  you didn't grant MIDI access to keep hearing the built-in synth — but only there: not on a
  later `statechange` (a device appearing mid-session shouldn't reroute you without asking),
  and not when it was the synth's In that asked for access. `send` rebases Tone's audio clock
  onto the `performance.now()` stamp `output.send` wants. Picking a port **replaces** the
  synth rather than doubling it. `panic()` is not optional politeness: hardware holds a note
  until told otherwise, so Stop and every port change do `clear()` (drop queued note-offs, or
  they land after the reset) then all-notes-off. Not persisted to the URL — port ids are
  machine-local and a shared link carrying one would be nonsense. The **channel** (`Chan`,
  sixteen keys four by four, live only while routed to MIDI) follows the same rule: it's
  about your rig, not the progression. Changing it panics the old channel first, exactly as
  changing port does.
  **`useMidiIn(midi, onMessage)`** (`midi/in.js`) is behind the synth's module 04 **In**:
  `source` is `off`, `all` (every input, every channel — an MPK Mini's keys and pads default
  to different channels, and both should play) or one port. It sets `onmidimessage` rather
  than adding a listener, because setting it is what opens the port in every browser that has
  Web MIDI, re-attaches when the set of matching inputs changes (opening a port fires
  `statechange` too, hence the comparison), and sends an `alloff` when it stops listening,
  since whatever was held would never get its note-off. Messages go through the pure
  **`parseMidi`** (`midi/messages.js`): note on/off (velocity 0 is an off), the sustain pedal
  (CC64), pitch bend (±2 semitones, `BEND_SEMITONES`), all-notes-off; clock, sysex and
  aftertouch are ignored, and other CCs pass through unused. Also not in the URL.
- **The engine** (`synth/engine.js`, the only file that builds audio nodes) — a plain
  `Engine` object behind a thin **`useSynthEngine(sound)`** hook, so its methods are stable
  and the devices pass it round without re-rendering on its account. The chain:

  ```
  seq  ┐  each voice: osc → filter → amp env        ┌→ (tap: out of the filter)
       ├────────────────────────────────────→ post ┤
  keys ┘                                           └→ drive → chorus → reverb → out
  each voice: osc → its own copy of the amp env → dry → (tap: into the filter)
              filter env → contour ┐
  LFO → lfoDepth ──────────────────┴→ that voice's filter detune
  ```

  **Per-voice filters.** A `Voice` subclasses `Tone.Synth` and puts a −24dB `Tone.Filter`
  between the oscillator and the amp envelope, with its own **filter envelope** — so every
  note opens and closes the filter for itself, the way a polysynth's voice cards do. The
  envelope has Attack, Decay and Sustain and no release of its own: it closes over the amp's
  release, so a note darkens as it fades, Minimoog-style. **Modulation goes on `detune`.**
  The filter envelope (scaled by the `contour` gain to `filterEnv` octaves of cents) and the
  shared LFO (`lfoCents`) both connect to the voice filter's `detune`, where they add:
  cutoff × 2^(octaves), the way a control voltage moves a hardware filter. That leaves
  `frequency` to the Cutoff level alone. (It also retires an old trap: connecting a signal to
  a `Tone.Signal` *replaces* its value, so the LFO used to own the cutoff outright and carry
  the setting in its own range.) The LFO reaches each voice through a **gain of the voice's
  own**, never straight to the detune: Tone's `disconnect()` can't resolve a Signal's
  parameter and falls back to disconnecting the source from *everything* — for a shared LFO,
  every other voice. **Two pools, one sound**: `seq` plays the explorer's chords and `keys`
  the keyboard and MIDI in, so a key you hold is never released by a chord that shares its
  note, and Stop (`release()`, the seq pool only) never cuts a held key. Everything after the
  voices is built **once** and left in place, wet at zero where that means off — rebuilding
  the chain when a level moves would cut the sound you're trying to listen to — and
  `applySound(nodes, s)` retunes what already exists (`voiceSettings` for both pools via
  `PolySynth.set`, which every new voice is also built from). That's the whole point of a
  knob, and it's why a preset change mid-playback just re-voices the run. `reverb.decay` is
  the one setter that re-renders an impulse response — async and audible — so it's applied
  only when the value has actually changed.
  **Starting audio.** It starts on the first **`pointerdown` or `keydown` anywhere on the
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
  `ensure()` bail on `null`. **`blocked`** is the hook's other return: a second after a press
  asked for audio, the context either runs or it doesn't, and if it doesn't both devices'
  displays show a dismissible **"No sound?"** notice (`NoSound`) with the Safari Auto-Play
  path (host name filled in) and a generic hint for other browsers. Judged by what happened,
  not by sniffing the browser, so it covers Safari's "Never Auto-Play" and anything else that
  refuses, and never appears when sound works; a later press that gets through clears it.
  Dismissal is per visit, covers both devices, and is not in the URL. `engine.sound` is
  assigned during render so the chain comes up with the settings in force at the first
  press, not the ones from mount.
  **What it offers.** `play(events, t)` triggers `chordEvents`' list note by note on the seq
  pool (per-note velocity needs per-note calls) and remembers it as `last`; `release()` cuts
  the seq pool. `noteOn`/`noteOff` are live notes on the keys pool at `Tone.immediate()` —
  *not* `Tone.now()`, which adds the 100ms scheduling look-ahead: fine for a sequence, far too
  late under a finger. A note let go before audio came up (the first click on a cold page
  usually is) still plays, for as long as it was held — or the first thing the keyboard
  teaches you is that it's broken. `setPedal` holds released notes until it lifts; `bend`
  detunes both pools; `allNotesOff`. `audition()` replays `last` — the chord you just picked,
  the note you just struck, C major before anything — unless the transport is running or a
  key is held, which are already demonstrating the change. `subscribe(fn)` reports which
  notes are sounding (held live notes, and sequenced notes between their start and end,
  worked out on animation frames against the audio clock only while something is scheduled),
  for the keyboard's lights and the Note lamp. `readScope(buf)` fills the display's buffers
  from three AnalyserNode taps (plain analysers run whether or not they lead anywhere, so the
  dry copy is heard by the scope and nothing else) and reports where the filter is: the
  newest sounding voice's envelope value (`Envelope.getValueAtTime`), the LFO's (a tap of its
  own), and the lowest note sounding.
- **`velocityCurve(midi, feel, rand)`** (in `chords/perform.js`) — per-note velocity and a few
  ms of onset drift. A chord with every voice at the same velocity is an organ; **Dynamics**
  spreads them (firm bass, singing top, inner voices tucked under) and **Humanise** scatters
  the result. `rand` is **injected**, the same bargain `suggestLoop` makes, and it draws the
  same number of times whatever Humanise is, so turning it down doesn't reshuffle which note
  gets which wobble. `playVoiced` hands the same **list of note events** (pitch, onset,
  length, velocity) to the synth's engine or the MIDI port, so the two can't drift apart. The
  list comes from **`chordEvents(upper, bass, opts, rand)`**, also in `perform.js` — pure, so
  block chord vs arpeggio, the arp order, `-4-`, hold bass, velocity and humanise are all
  decided in one tested place. Chords travel through the component as **`{ upper, bass }`**,
  the bass named rather than folded in as the lowest note: it isn't always the lowest (an
  inversion can roll an upper voice under it), and hold bass has to know which note it is.
  **Dynamics and Humanise are the player's, not the synth's** — they're how a chord is
  *struck*, not how it sounds — so they live in the explorer's Playback module (`FEEL`, two
  `Level`s), go out the MIDI port too, and travel in the explorer's link as `dy=`/`hu=`. They
  used to be synth parameters; a link from then carried them in slots 14–15 of `sy=`, which
  `retiredFromSynth` reads back out and `App`'s `bootFrom` hands to `decodeState`.
- **The synth device** (`synth/Synth.jsx`) — a second chassis: nameplate (lamps **Note**, lit
  while anything sounds, its own small subscription so the panel doesn't re-render per note;
  and **MIDI In**, lit briefly by each message), the **display** with **01 Presets** beside
  it, **02 Sound**, **03 Keys** and **04 In**. Four columns; two below 1400px; one below 900.
  **Presets** are a 3×3 block of keys (`Keys cols={3}`), the ninth, **—**, lighting when the
  levels match none of them; the name is **derived** by comparing values rather than stored,
  so a shared link carrying only numbers still opens with the right preset lit, and nudging
  one level honestly lights **—**. Picking one plays it. **Sound** is driven entirely off
  `SYNTH_PARAMS`, a column per group, so adding a knob is a line in that table rather than a
  line of markup: a number becomes a `Level`, an enum becomes `Keys` with drawn legends (the
  wave, the filter type). **`EnvelopeGraph`** sits beside each envelope's heading: the shape,
  its segment widths taken from the levels' positions rather than from seconds — attack is on
  a log scale from 2ms, and drawn in linear time a short attack is just a vertical line. The
  filter envelope's is scaled by its Amount, so at zero it lies flat and faint, which is what
  it does to the filter. Letting go of any level **auditions** (see the engine). **Keys**
  (`Keyboard.jsx`) is 25 keys, C to C like an MPK Mini, C3–C5 by default with octave keys
  (C1 to C8 at the top): press and slide to play, driven from `window` listeners because a
  slide crosses keys and a release lands anywhere; with the keyboard *focused*, the computer
  keys play it DAW-style (A–K white, W E T Y U black, Z/X octave) — only while focused, so
  typing elsewhere never plays a note, and blur lets go of everything typed. Space still means
  the transport. A key is lit while its note sounds, whoever is playing it, so the explorer's
  chords show up there too. The MIDI readout and lamp are throttled: pitch bend alone can
  send a hundred messages a second, and each would re-render every level on the panel.
- **The scope** (`synth/Scope.jsx`) — dark glass, lit in the lamp colour, two panes comparing
  the same two signals: the voices with no filter (grey, the dry tap) and out of it (lit,
  tapped before drive and the effects, so the only difference between the traces is the
  filter). **Wave** is held still the way a hardware scope holds it: `scopeSpan` shows three
  periods of the lowest note sounding (4–45ms), and `findTrigger` picks among the rising zero
  crossings the one whose frame best matches the last frame drawn — a single note has one
  crossing a cycle and any will do, but a chord crosses several times at points that look
  nothing alike, and this locks onto its shape. It triggers on the dry signal (a raw
  oscillator has the cleanest edges) and draws both from the same moment, so any shift
  between them is the filter's; the vertical scale eases (fast down, slow up). **Spectrum**
  puts both on an octave axis with the filter's response over them — `filterResponse` at
  `cutoffAt(sound, env, lfo)`, so the line moves with the envelope and the LFO and the cutoff
  is read out live beside its marker; the dashed line is where the envelope opens it to. The
  spectra are offset so the loudest incoming harmonic sits on 0dB, which puts the outgoing
  harmonics where the curve says they should be. Drawn on canvases from an animation frame,
  never through React state, paused off-screen (IntersectionObserver), and before audio it
  still draws the curve from the levels — and a flat trace, the way a scope at rest does.
- **Random start** — App's `bootFrom` is `decodeState(search, retiredFromSynth(sy)) ||
  randomStart()`: only a URL with **no query string at all** gets a random key and a 4-bar
  suggestion; any parameter, even `?k=0`, opens exactly as written, so a shared link or a
  reload is never re-rolled. The URL sync then writes the rolled state into the address bar,
  so a reload keeps it.
- **URL sync** (`url.js`) — the address bar is shared: each device owns a **slice** of the
  query string through **`useUrlSlice(name, qs)`** (the explorer its key and progression via
  `encodeState` in `chords/state.js`, the synth its `sy=` patch), and the bar is their sum, so
  neither device knows the other's parameters. Slices are set in a layout effect and written
  to the address bar only after 300ms without a change, and flushed on `pagehide`. Never per
  change: a level drag changes state every frame, and Safari allows 100 `replaceState` calls
  per 10 seconds and then **throws** — from inside an effect, which unmounts the whole app to
  a white page (Chrome just throttles, with a warning). A failed write is swallowed
  regardless; a lagging address bar is cosmetic. Share copies **`currentPath()`**, composed
  at the moment of the click, not `location.href`, so it never copies a URL that's up to
  300ms stale.
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
  are carried into it, and the seed keeps it the same mutation. Loop and Evolve are one
  three-way control (`repeat`, derived from the `loop` and `evolve` booleans, so Evolve can't
  be on without Loop). **Loop is on by default** — the URL records `lp=0` when it's off, so an
  old link without `lp` now opens looping. **Evolve** (`ev=1`) is an effect that queues an
  `auto` mutation whenever a looping run has nothing queued; the tick counts `rounds` since
  the progression last changed and lands an `auto` one only once that reaches **Every**
  (`evolveEvery`, `ee=` when not 1, read through a ref so a change reaches a run in flight).
  Anything you queued yourself still lands at the very next cycle end. Stop drops an `auto`
  one, since it was only ever for next time round.
  The display's top line reads both out: `once` / `loop` / `evolve` (with `every N`, or
  `round r/N` while playing — `round` is state the tick sets on the Draw clock, mirroring the
  `rounds` ref), and `mutate` with the amount, plus `next` while a Mutate you pressed waits.
  The **mutation level** (the keys beside Mutate, `ml=` when not 1) is 1–3 quarters of
  the bars — the engine's level 4 isn't offered in the UI, and `ml=4` in an old link reads as 3 — read live, so Evolve and a waiting mutation both follow it.
  **`mutateLoop`** (in `harmony.js`) re-picks `level` quarters of the bars (at least one).
  Levels 1–3 never touch bar 1; level 4 is deliberately the extreme setting and re-picks
  **every** bar, bar 1 included, so the loop needn't start at home any more. It picks with the
  same `loopWeight` as `suggestLoop` (times how well the pick leads into the next bar), keeps
  every other bar as it was, `inv` and `id` included, and won't put back what a bar held in
  the `previous` generation. Without that, evolving a 4-bar loop flips one bar back and forth.
- **Component + `FutureList` / `FutureRow` + `PianoRoll`** — state is `root, mode, add7,
  voiceLead, bassOn, arp, arpFour, arpOrder, holdBass, loop, evolve, tempo, feel, hist, queued, playingIdx, playing`, plus `exiting` / `spawn` for the
  choose choreography. **Arpeggio** makes `playVoiced` play one note per step, the steps
  spread evenly across the chord's slot (`span` — the whole slot in playback, so the last step
  runs straight into the next chord), each note gated to 0.9 of its step with the envelope's
  release ringing on. It used to be a strum — 0.16s-apart onsets held to the end of the slot —
  which left a triad finished in a third of a second and then silent: the "pause after the
  third note". The order comes from **`arpSequence`** in `chords/perform.js`, pure with `rand`
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
  `TensionCurve` still exists, in its own file, but is currently not rendered (removed from
  the progression view for now), and it's the one thing still painted in the function hues.
- **Styles** are plain `.css` files, one per module, imported by the component that owns
  them and bundled by Vite: `panel/panel.css` (the design tokens on `.ce-root`, and the
  hardware both faces share — chassis, modules, keys, levels, lamps), `chords/chords.css`
  and `synth/synth.css` (each device's grid and its own parts). They used to be one template
  string inside the component, which is gone along with its no-backticks rule.

## Invariants — don't break these

- **Function is load-bearing pedagogy.** Every chord *must* have a `func`
  (`tonic | predominant | dominant | subtonic | secondary | borrowed`), which the futures print
  in each row's tension block (and `hueOf` maps to a hue, for `TensionCurve`), and a numeric
  `tension`, which lights that block's meter and plots on the curve. If you add a chord type,
  wire up both. Function used to be shown as colour everywhere; the hardware redesign moved it
  into words, so the face could keep one lamp colour and a mono display.
- **The model modules are pure and import-free.** Everything in `harmony.js`, `perform.js`,
  `params.js`, `dsp.js` and `messages.js` takes data and returns data — no React, no DOM, no
  Tone, and no imports at all. Don't add one; if something needs a library, it belongs in the
  presentation layer. Keep the pitch math in plain integers. `params.js` in particular
  describes the synth but never builds it: the moment it needs `Tone`, the split has gone
  wrong.
- **Only the engine builds audio nodes, and the devices don't reach into each other.** The
  explorer hands note events to `engine.play` (or a MIDI port) and uses Tone only as a clock;
  the synth never imports anything from `chords/`. `App.jsx` is the one place both meet. If
  the explorer wants something new from the synth, it's a method on the engine.
- **A knob is a row in `SYNTH_PARAMS`, not a piece of markup.** Label, range, scaling,
  formatter, group and tooltip all live in the table; the panel renders whatever is in it.
  Adding a control means adding an entry (in the column you want it, in the order you want
  it) and applying it in `applySound` — and **appending** its key to `SYNTH_WIRE`, never
  reordering or removing one, because that's what every shared link's `sy=` was written
  against. A parameter that leaves the synth is retired in place (`~name`, written empty), as
  Dynamics and Humanise were. Give a new parameter a `legacy` value if an old link should get
  something other than the default preset's — the filter envelope's is 0, so an old patch
  doesn't open with a filter sweep it never had.
- **Audio starts on `pointerdown`/`keydown`, never on `click`.** The engine's `unlock()` is
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
- **Tailwind is not available** and was avoided deliberately — styles are plain CSS files
  (see **Styles**). Preserve the CSS-variable token system. `.ce-root button` resets every button,
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
5. ✅ **Make the built-in synth worth listening to** — done; `synth.js` (now `synth/params.js`) + the **Sound**
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
10. ✅ **The synth, as an instrument** — done; split out of the explorer into its own device
    (`synth/`), with a lowpass/highpass filter and a per-voice filter envelope (Amount,
    Attack, Decay, Sustain), a scope comparing the signal either side of the filter by wave
    and by spectrum with the live response curve, a 25-key keyboard, and MIDI in (notes on
    any channel, sustain pedal, pitch bend). Dynamics and Humanise moved to the explorer.
11. **Knobs from a controller** — map CCs (an MPK Mini's eight knobs send 70–77 by default)
    to levels, ideally by MIDI learn: touch a level, turn a knob. `parseMidi` already hands
    CCs through; nothing uses them yet.
12. **More filter** — key tracking (the cutoff following the note, as a Moog's keyboard
    control switches do), velocity to filter amount, a 12dB slope and bandpass/notch types
    (append to `filterType`'s options and `filterResponse` already knows the maths for its
    own two). Each is a row in `SYNTH_PARAMS` plus a line in `applySound`.

### Testing

A suite beside every pure module; `npm test` runs them all.

[app/src/synth/params.test.js](app/src/synth/params.test.js) covers the patch model: that
every parameter and preset is complete and in range, that the wire format writes every live
parameter once and never moves an existing slot, that the slider mapping round-trips every
preset value and puts the ends of a range at the ends of the slider, that a patch survives
the URL and reopens under its own preset name, that a short or damaged `sy=` falls back per
parameter rather than throwing the lot away, that a link from before the filter envelope
opens as it sounded then and hands its Dynamics and Humanise to the player, and that
`cutoffAt` adds the envelope and the LFO in octaves.

[app/src/synth/dsp.test.js](app/src/synth/dsp.test.js) covers the display's maths: that the
response curve passes, cuts and resonates where Web Audio's biquads do (gain exactly the
resonance at the corner, per stage; ~24dB an octave past it; a cutoff past Nyquist open for a
lowpass and shut for a highpass), the octave axis, that no harmonic falls between two
display points, and that the scope's trigger holds a chord's shape still.

[app/src/chords/perform.test.js](app/src/chords/perform.test.js) covers how a chord is
struck: `velocityCurve` flat at zero dynamics, shaped at full, bounded under any jitter, and a
pure function of its inputs; the arpeggio orders; and `chordEvents`' block, arp, -4- and
hold-bass timings. [app/src/chords/state.test.js](app/src/chords/state.test.js) covers the
explorer's link, feel included, and the hand-over from old links.
[app/src/midi/messages.test.js](app/src/midi/messages.test.js) covers reading a controller.

[app/src/chords/harmony.test.js](app/src/chords/harmony.test.js) covers the harmony engine: key building across
all three modes, `classify`, colour chords and suspensions, `optionsFrom` ranking and
cadence copy, and the voicing helpers (common-tone retention, inversion rolls,
`computeVoicings` purity, `voiceSteps` pairing, midi→note conversion), and the bass voice
(root, window, nearest-octave motion, always under the voicings). Run it with
`npm test` from `app/`. If a
change alters harmonic behaviour, add or update an assertion rather than eyeballing the UI.

One known wart the suite pins rather than fixes: spelling follows the **key root**, so
C Mixolydian's ♭VII prints as `A#` while its roman reads `♭VII`. Cosmetic only — audio and
ranking both use pitch classes.
