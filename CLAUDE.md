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
[app/src/ChordExplorer.jsx](app/src/ChordExplorer.jsx) (UI) and
[app/src/harmony.test.js](app/src/harmony.test.js). **Edit those** — that's what runs. The
repo root mirrors all three as the canonical copies; `cp` them over at a checkpoint.

```bash
cd app
npm install
npm run dev        # http://localhost:5173
npm test           # vitest run — the engine suite
npm run lint       # oxlint
```

There is no root `package.json`; every script above runs from `app/`.

Audio starts on your first click (browsers block autoplay until a gesture — expected). Fonts
load from Google Fonts via `@import`; offline it falls back to system fonts and still works.

**Setup gotcha:** Tone.js imports `tslib`, which the current rolldown-based Vite doesn't
auto-resolve. If you see `Failed to resolve import "tslib"`, run `npm install tslib` in
`app/` and restart the dev server (clear `node_modules/.vite` if it was cached).

## Architecture

Two pieces, now in two files: a **pure functional-harmony engine** in
[app/src/harmony.js](app/src/harmony.js) and a **React/Tone.js presentation layer** in
[app/src/ChordExplorer.jsx](app/src/ChordExplorer.jsx), which imports the engine's named
exports. Keep that seam clean; it's the main lever for testability and for everything on the
roadmap. The engine has **no imports at all** — not React, not Tone — so
[app/src/harmony.test.js](app/src/harmony.test.js) runs in plain Node with no audio context.

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
- **`useSynth()`** — lazy `Tone.PolySynth → Reverb → Destination`, initialised inside a user
  gesture.
- **Component + `FutureList` / `FutureRow` + `PianoRoll`** — state is `root, mode, add7,
  voiceLead, arp, tempo, prog, playingIdx`, plus `exiting` / `spawn` for the choose
  choreography. `arp` (Arpeggio toggle) makes `playVoiced` roll a chord's notes
  up with staggered onsets that hold to the end of the slot, instead of one block attack. `PianoRoll` renders the progression as columns where each voice sits at
  its pitch height (`top = (max - midi) * ROW`), so common tones line up across columns and
  voice leading is visible; a note common with the previous chord gets a `held` style. A
  behind-the-columns SVG draws faint **connectors** pairing voices by ascending pitch across
  adjacent chords (`held` = horizontal). Fixed `ROLL` geometry (`ROW/CELL/COL/GAP`) keeps the
  SVG and the flex columns on the same coordinates. Each note pill is its own button (plays
  that single note via `onPlayNote`) and carries its **semitone step from the previous
  chord** at its right edge — voices paired by ascending pitch, the same pairing the
  connectors use, so a voice with no counterpart (a triad growing into a seventh) is
  simply left unlabelled; the chord tile under each column plays the whole chord
  (`onPlay`). The column itself is a plain container — buttons can't nest.
- **`FutureList`** — the next-chord options, sitting beside the roll in the same
  progression view as the possible futures the current chord opens onto. One flat list
  (diatonic + colour + suspensions merged, the sort is stable so the engine's ranking
  still shows through within a tension band), **ordered by tension descending** so the
  top of the list is the furthest from home. Each `FutureRow` is one line —
  tension meter, name, roman, Δ-from-here, description — so a couple of dozen fit
  vertically; hovering previews the chord, clicking commits it. There is no chord-tile
  grid below any more; this list replaced it.
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
  progression view for now). Styles live in the `CSS` template string with design tokens as
  CSS custom properties — **no backticks in that string**, they terminate the template
  literal.

## Invariants — don't break these

- **Colour = function is load-bearing pedagogy.** Every chord *must* have a `func`
  (`tonic | predominant | dominant | subtonic | secondary | borrowed`) so it gets a hue via
  `hueOf`, and a numeric `tension` so it plots on the curve. If you add a chord type, wire up
  both.
- **The harmony engine is pure and import-free.** Everything in `harmony.js` takes data and
  returns data — no React, no DOM, no Tone. Don't add an import to that file; if something
  needs a library, it belongs in the presentation layer. Keep the pitch math in plain
  integers.
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

### Testing

[app/src/harmony.test.js](app/src/harmony.test.js) covers the engine: key building across
all three modes, `classify`, colour chords and suspensions, `optionsFrom` ranking and
cadence copy, and the voicing helpers (common-tone retention, inversion rolls,
`computeVoicings` purity, `voiceSteps` pairing, midi→note conversion). Run it with
`npm test` from `app/`. If a
change alters harmonic behaviour, add or update an assertion rather than eyeballing the UI.

One known wart the suite pins rather than fixes: spelling follows the **key root**, so
C Mixolydian's ♭VII prints as `A#` while its roman reads `♭VII`. Cosmetic only — audio and
ranking both use pitch classes.
