# Chord Paths — agent briefing

A browser tool for exploring chord progressions by ear and by function. Pick a chord,
it plays, and it shows the moves that follow — each tagged with its **root motion**
("up a fourth") and what it **does** harmonically ("Deceptive cadence — you expect home,
you get the relative minor"). Build a progression, watch its tension rise and resolve,
play it back. No backend, client-side only, [Tone.js](https://tonejs.github.io/) for audio.

See [README.md](README.md) for the human-facing pitch, design rationale, and roadmap.

## Running it

The app is a Vite + React project living in [app/](app). The source component
[ChordExplorer.jsx](ChordExplorer.jsx) at the repo root is the canonical copy; the working
copy Vite serves is [app/src/ChordExplorer.jsx](app/src/ChordExplorer.jsx). **When you edit
the component, edit `app/src/ChordExplorer.jsx`** (that's what runs). Keep the root copy in
sync when you reach a checkpoint.

```bash
cd app
npm install
npm run dev        # http://localhost:5173
```

Audio starts on your first click (browsers block autoplay until a gesture — expected). Fonts
load from Google Fonts via `@import`; offline it falls back to system fonts and still works.

**Setup gotcha:** Tone.js imports `tslib`, which the current rolldown-based Vite doesn't
auto-resolve. If you see `Failed to resolve import "tslib"`, run `npm install tslib` in
`app/` and restart the dev server (clear `node_modules/.vite` if it was cached).

## Architecture

The component is really two things bolted together: a **pure functional-harmony engine**
(top ~60%) and a **React/Tone.js presentation layer** (the rest). Keep that seam clean; it's
the main lever for testability and for everything on the roadmap.

Reading top to bottom:

- **Pitch-class layer** — `SHARP` / `FLAT` / `FLAT_KEYS`, `nameOf`. Notes are integers
  0–11; spelling is cosmetic and never affects audio.
- **Scales & function tables** — `STEPS`, `ROMAN`, `FUNC` (function + tension value per
  scale degree, per mode).
- **`classify(intervals)`** — turns a set of semitone intervals into a chord quality,
  display suffix (`m7`, `maj7`, `°`, `ø7`…), and roman-numeral suffix. Source of truth
  for how a chord is named.
- **`buildKey(root, mode)`** — returns `{ diatonic[7], colour[], scale }`. Diatonic chords
  are built by **stacking scale thirds** (so 7ths come out correct without a lookup table).
  `colour` holds secondary dominants + borrowed chords (major) or the harmonic-minor
  dominant + Dorian IV + a secondary (minor).
- **`hueOf(func)`** — function→palette mapping.
- **Voicing helpers** — `chordPitchClasses` / `chordNoteNames` (the note *names* of a chord,
  spelled to the key — used by the UI to show what's in each chord); `rootPositionMidi`
  (plain root position + octave-down bass); `voiceLeadMidi` (keeps each new tone nearest to
  the previous chord's notes so common tones hold and the rest step — inversions fall out of
  this); `computeVoicings(prog, voiceLead)` chains a whole progression; `bassNameOf` reads
  the lowest note for slash-chord display.
- **`motionLabel()`** — root-motion description.
- **`SPECIAL` / `ROLE` / `moveDescription()`** — the contextual "what this move does" copy.
  `SPECIAL` keys named cadences by `fromDegree>toDegree`; `ROLE` is the destination-only
  fallback.
- **`score()` / `salience()` / `optionsFrom(current, key)`** — ranks the next-chord options.
  `optionsFrom` is what the UI calls; it decorates each option with `move`, `motion`, and a
  `resolution` flag.
- **`useSynth()`** — lazy `Tone.PolySynth → Reverb → Destination`, initialised inside a user
  gesture.
- **Component + `ChordCard` + `PianoRoll`** — state is `root, mode, add7, voiceLead, arp,
  tempo, prog, playingIdx`. `arp` (Arpeggio toggle) makes `playVoiced` roll a chord's notes
  up with staggered onsets that hold to the end of the slot, instead of one block attack. `PianoRoll` renders the progression as columns where each voice sits at
  its pitch height (`top = (max - midi) * ROW`), so common tones line up across columns and
  voice leading is visible; a note common with the previous chord gets a `held` style. A
  behind-the-columns SVG draws faint **connectors** pairing voices by ascending pitch across
  adjacent chords (`held` = horizontal). Fixed `ROLL` geometry (`ROW/CELL/COL/GAP`) keeps the
  SVG and the flex columns on the same coordinates. Each note pill is its own button (plays
  that single note via `onPlayNote`); the chord tile under each column plays the whole chord
  (`onPlay`). The column itself is a plain container — buttons can't nest.
  `TensionCurve` still exists in the file but is currently not rendered (removed from the
  progression view for now). Styles live in the `CSS` template string with design tokens as
  CSS custom properties.

## Invariants — don't break these

- **Colour = function is load-bearing pedagogy.** Every chord *must* have a `func`
  (`tonic | predominant | dominant | subtonic | secondary | borrowed`) so it gets a hue via
  `hueOf`, and a numeric `tension` so it plots on the curve. If you add a chord type, wire up
  both.
- **The harmony engine is pure.** `buildKey`, `classify`, `optionsFrom`, the voicing helpers,
  etc. take data and return data — no React, no DOM. Voicing helpers touch `Tone.Frequency`
  only to convert midi→note strings at the edge; keep the pitch math in plain integers.
- **Audio only after a gesture.** `Tone.start()` is awaited inside `useSynth`'s `ensure`,
  called from click handlers. Don't hoist synth creation to module load or a bare `useEffect`.
- **Pitch classes are integers 0–11.** All harmonic and voicing math goes through them (and
  midi integers for register). Note strings are for display and for handing to Tone, never
  for logic.
- **Voicing is derived, never stored on the chord.** `computeVoicings(prog, voiceLead)` is a
  pure function of the progression and the toggle, memoised in the component. `choose` plays
  the incremental voicing computed from the current chain end so it matches the recompute.
  Don't stash midi notes on progression items — toggling voice-leading must re-realise cleanly.
- **Tailwind is not available** and was avoided deliberately — styles are plain CSS in the
  `CSS` string. Preserve the CSS-variable token system.

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
3. **Web MIDI out** — drive external instruments. Touches only the presentation layer: add a
   `navigator.requestMIDIAccess()` output selector and, in playback, send note-on/off to the
   chosen port. Needs a secure context (`localhost` counts); realistically Chrome-only —
   surface that in the UI rather than letting it fail silently in Safari.
4. **"Suggest a loop"** — walk the transition graph to propose a 2/4/8-bar progression.
5. **Save progressions** — localStorage or export to a small text format.
6. **Export** — MIDI file, or a chord-chart / lead-sheet string.

### Suggested next refactor

Extract the engine into `app/src/harmony.js` (everything from `SHARP` down through
`optionsFrom`, plus the voicing helpers) and add a Vitest file. The engine is deterministic
and pure, so tests are cheap and high-value. Good first assertions:

- In C major, `buildKey(0,'major').diatonic` yields `C Dm Em F G Am B°` with romans
  `I ii iii IV V vi vii°`.
- With `add7`, degree 4 (V) classifies as a dominant 7th and degree 6 (vii°) as
  half-diminished (`ø7`).
- From the tonic, `optionsFrom` ranks V and IV above the tonic-substitute chords.
- A secondary dominant sets `resolvesTo`, and its target is flagged `resolution: true` and
  sorted to the front.
- `voiceLeadMidi(prev, chord)` retains common tones exactly and moves the rest by the
  smallest interval (e.g. C→Am holds C and E, moves G→A).

```bash
cd app && npm install -D vitest
```
