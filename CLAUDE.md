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
- **`useMidiOut()`** — the **Output** selector. `status` is a small state machine
  (`unsupported | insecure | idle | asking | ready | denied`) whose copy lives in
  `MIDI_STATUS`; support and secure context are checked **before** the control is offered,
  because Safari has never shipped Web MIDI and a dead dropdown explains nothing. Access is
  requested without sysex (notes don't need it, and asking prompts harder) from a click, and
  `onstatechange` refreshes the port list on hot-plug. `send` rebases Tone's audio clock onto
  the `performance.now()` stamp `output.send` wants. Picking a port **replaces** the synth
  rather than doubling it. `panic()` is not optional politeness: hardware holds a note until
  told otherwise, so Stop and every port change do `clear()` (drop queued note-offs, or they
  land after the reset) then all-notes-off. Not persisted to the URL — port ids are
  machine-local and a shared link carrying one would be nonsense.
- **`useSynth()`** — lazy `Tone.PolySynth → Reverb → Destination`, initialised inside a user
  gesture. Returns `{ ensure, release }`; `release` exists because `Transport.stop()`
  unschedules what hasn't played but a note already triggered rings out on its envelope.
- **Playback runs on `Tone.getTransport()`**, not a pass scheduled up front. The Loop toggle
  forced this: a loop needs a Stop that lands *now*, and `Transport.cancel()` is the only
  thing that unschedules what's queued. Events are placed in Transport time (`0:beat:0`),
  so the tempo slider rescales a run already in flight. The end-of-run stop is **always**
  scheduled and guarded by `loopRef.current`, which is what makes both directions work live:
  turning Loop off mid-cycle ends the run at that cycle's end, turning it on never trips the
  stop. Scheduled callbacks call **`playVoicedRef.current`**, never the closure: a Transport
  callback keeps whatever `playVoiced` it was built with, so switching MIDI output or
  toggling Arpeggio mid-run would do nothing until the next Play. Same reason `stopPlayback`
  lives in a ref — listing it as an effect dependency makes the cleanup fire on every port
  change, silently stopping playback and panicking the port twice.
  `playingRef` / `loopRef` shadow the state because scheduled callbacks and the
  invalidation effect would otherwise close over stale values — and depending on `playing`
  in that effect would stop playback the instant it started. Editing the progression (or the
  key) stops playback, since the schedule is built against a specific `voicings`.
- **Component + `FutureList` / `FutureRow` + `PianoRoll`** — state is `root, mode, add7,
  voiceLead, arp, loop, tempo, prog, playingIdx, playing`, plus `exiting` / `spawn` for the
  choose choreography. `arp` (Arpeggio toggle) makes `playVoiced` roll a chord's notes
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
  (`onPlay`). The column itself is a plain container — buttons can't nest, which is also why
  the remove **×** is a sibling of the tile positioned over its corner rather than inside it.
  The first tile has no Δ to show, so it renders a `ce-chip-ghost` (`visibility:hidden`)
  rather than nothing — same element, so the tiles stay exactly the same height.
- **Reordering** is pointer-based, not HTML5 drag-and-drop: the columns are a uniform grid,
  so the target index is arithmetic on `clientX` against `colsRef`, and `prog` is reordered
  *live* as you cross a boundary, which lets you watch the voice leading re-solve mid-drag.
  `clickBlocked` is a **separate** ref from `drag`, and that separation is load-bearing: the
  click that ends a drag fires in the same task as `pointerup`, after `onDragEnd` has already
  cleared `drag.current`, so a flag living on the drag object is gone by the time the click
  handler reads it — and the chord you just moved plays. It is released on the next tick.
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
  the resolutions sit up top. Each `FutureRow` is one line — tension meter, name, roman,
  notes, Δ-from-here, description — so a couple of dozen fit vertically. The `em` values in
  that grid resolve against the **button's own font-size** (the UA default ~13.3px), not the
  16px root; the notes track is sized for the widest spelling a chord can have — four flat
  names, which `E♭m7` (ii7 in D♭ major) actually produces. Below 560px the notes column is
  the one that gives way, since it's derivable and repeated in the row's tooltip, and the
  name must stay whole. **Hovering the name** auditions the chord — the name only, so
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
3. ✅ **Web MIDI out** — done; `useMidiOut` + the **Output** selector. Verified against a
   Waldorf Protein over USB-C in Chrome.
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
