# Chord Paths

A browser tool for exploring chord progressions by ear and by function. You pick a
chord, it plays, and it shows you the moves that follow — each one tagged with its
**root motion** ("up a fourth") and what it **does** harmonically ("Deceptive cadence —
you expect home, you get the relative minor"). Build a progression, watch its tension
rise and resolve, play it back.

It's a single React component (`ChordExplorer.jsx`) using [Tone.js](https://tonejs.github.io/)
for audio. No backend, no build-time secrets, runs entirely client-side.

> This README has two readers. Everything down to **"For a Claude Code agent"** is for you.
> That section is the operational briefing — if you'd rather, lift it into a `CLAUDE.md`,
> which Claude Code reads automatically.

---

## Quickstart

Needs Node 18+. From your dev directory:

```bash
npm create vite@latest chord-paths -- --template react
cd chord-paths
npm install
npm install tone
```

Copy `ChordExplorer.jsx` into `src/`, then replace `src/App.jsx` with:

```jsx
import ChordExplorer from "./ChordExplorer";

export default function App() {
  return <ChordExplorer />;
}
```

The component ships its own styles, so delete the `import "./App.css"` and
`import "./index.css"` lines from `App.jsx` / `main.jsx` to stop Vite's default
CSS from fighting it. Then:

```bash
npm run dev
```

Audio starts on your first click (browsers block autoplay until a gesture — this is
expected). The type faces load from Google Fonts via an `@import`; if you're offline
it falls back to system fonts and still works.

## Using it

Set a **key** and **major/minor**, then click any chord to start. The **7ths** toggle
enriches the diatonic chords (V becomes V7, etc.). **Tempo** controls playback speed.

Every chord you could play next is listed to the right of the progression, one line
each — name, roman numeral, the voice movement picking it would cost (Δ), and what the
move *does*. They're **ordered by tension**, most tense at the top, so the list reads as
a gradient from "outside" down to "home". Hovering a line plays it; clicking commits it,
and the row flies into the roll and bursts into its note pills while the next set of
futures assembles.

The list mixes diatonic chords with **colour** — secondary dominants and borrowed chords
that sit outside the key for tension and surprise. If you land on a secondary dominant,
its resolution is flagged as the release.

Since that list is the whole vocabulary, it has a **filter**: type `sus`, `♭VII`, `F♯` or
`maj7` to narrow it — Enter takes the top match, Escape clears. If what you're after is
behind a toggle it says so and offers the switch ("+16 more with Sus on") rather than just
coming up empty.

Colour is the whole point: it encodes what a chord *does*.

- **Home** (teal) — tonic, point of rest
- **Build** (amber) — predominant, setting something up
- **Tension** (coral) — dominant, pulling toward home
- **Outside** (violet) — borrowed / secondary, off the diatonic path

The progression itself is a **piano roll**: each voice sits at its pitch height, so
common tones line up across chords and the voice leading is visible. Each note pill
carries its semitone step from the previous chord, and plays on its own when clicked.

## Design notes (why it is the way it is)

It's **key-locked** on purpose. Working within a key is what lets every option carry a
real function label — that's the difference between a chord toy and something that
teaches. To reframe, change the key rather than modulate freely.

**Minor mode** uses the natural-minor diatonic chords as the base, with the
harmonic-minor dominant (V, V7, vii°) offered as colour — which is how minor-key music
actually behaves. The weak natural v stays in-key and honest about being weak.

Voice-leading is on by default: each chord's tones are placed nearest the previous
chord's, so common tones hold and the rest step. Turn it off to hear plain root
position.

## Roadmap, roughly in order of fun

1. **Web MIDI out** — drive the Poly-D / Orchid / Ableton instead of the built-in synth.
   The most rewarding given your rig. (Chrome only, effectively — Safari's Web MIDI
   support is poor, worth flagging in the UI.)
2. **Voice-leading** — move common tones and step the rest, so playback flows instead of
   jumping in parallel blocks.
3. **"Suggest a loop"** — walk the transition graph to propose a 2/4/8-bar progression,
   then let you edit it.
4. **Save progressions** — localStorage or export to a small text format. (The
   no-storage rule you may have seen was an artifact-sandbox limitation; a real Vite app
   has no such constraint.)
5. **Inversions and richer voicings** — slash chords, drop-2, open voicings.
6. **Export** — MIDI file, or a chord-chart / lead-sheet string.

---

## For a Claude Code agent

You're working on two pieces: a **pure functional-harmony engine** and a
**React/Tone.js presentation layer**. Keep that seam clean; it's the main lever for
testability and for everything on the backlog.

### File map

- `src/harmony.js` — the engine. No imports at all, so it tests in plain Node.
- `src/harmony.test.js` — the Vitest suite over it (`npm test`).
- `src/ChordExplorer.jsx` — the UI, importing the engine's named exports.

Reading the engine top to bottom:

- **Pitch-class layer** — `SHARP` / `FLAT` / `FLAT_KEYS`, `nameOf`. Notes are integers
  0–11; spelling is cosmetic and never affects audio.
- **Scales & function tables** — `STEPS`, `ROMAN`, `FUNC` (function + tension value per
  scale degree, per mode).
- **`classify(intervals)`** — turns a set of semitone intervals into a chord quality,
  display suffix (`m7`, `maj7`, `°`, `ø7`…), and roman-numeral suffix. Source of truth
  for how a chord is named.
- **`buildKey(root, mode)`** — returns `{ diatonic[7], colour[], scale }`. Diatonic
  chords are built by **stacking scale thirds** (so 7ths come out correct without a
  lookup table). `colour` holds secondary dominants + borrowed chords (major) or the
  harmonic-minor dominant + Dorian IV + a secondary (minor).
- **`hueOf(func)` / `voicing()` / `motionLabel()`** — function→palette mapping, note
  names for Tone, and the root-motion description.
- **`SPECIAL` / `ROLE` / `moveDescription()`** — the contextual "what this move does"
  copy. `SPECIAL` keys named cadences by `fromDegree>toDegree`; `ROLE` is the
  destination-only fallback.
- **`score()` / `salience()` / `optionsFrom(current, key)`** — ranks the next-chord
  options. `optionsFrom` is the function the UI actually calls; it decorates each option
  with `move`, `motion`, and a `resolution` flag.
- **`useSynth()`** — lazy `Tone.PolySynth → Reverb → Destination`, initialised inside a
  user gesture.
- **Component + `ChordCard` + `TensionCurve`** — state is `root, mode, add7, tempo,
  prog, playingIdx`. Styles live in the `CSS` template string with design tokens as CSS
  custom properties.

### Invariants — don't break these

- **Colour = function is load-bearing pedagogy.** Every chord *must* be assigned a
  `func` (one of `tonic | predominant | dominant | subtonic | secondary | borrowed`) so
  it gets a hue via `hueOf`, and a numeric `tension` so it plots on the curve. If you add
  a chord type, wire up both.
- **The harmony engine is pure.** `buildKey`, `classify`, `optionsFrom`, etc. take data
  and return data — no React, no Tone, no DOM. `harmony.js` has no imports; don't add
  any. It's what makes the engine unit-testable.
- **Audio only after a gesture.** `Tone.start()` must be awaited inside a click handler.
  Don't hoist synth creation to module load or a bare `useEffect`.
- **Pitch classes are integers 0–11.** All harmonic math goes through them. Note strings
  are for display and for handing to Tone, never for logic.
- **Tailwind is not available here** and was avoided deliberately — styles are plain CSS
  in the `CSS` string. In a real Vite project you may move them to a `.css` file; if you
  do, preserve the CSS-variable token system.

### Tests

The engine extraction is done and `src/harmony.test.js` covers it — key building in all
three modes, `classify`, colour chords and suspensions, `optionsFrom` ranking and cadence
copy, and the voicing helpers (common tones held, inversion rolls, `computeVoicings`
purity, midi→note conversion).

```bash
npm test         # vitest run
npm run test:watch
```

Then pick from the roadmap above. **Web MIDI** touches only the presentation layer: add a
`navigator.requestMIDIAccess()` output selector and, in playback, send note-on/off to the
chosen port instead of (or alongside) the synth. It needs a secure context — `localhost`
counts, so `npm run dev` is fine — and realistically it's Chrome-only; surface that in the
UI rather than letting it fail silently in Safari.

### Conventions

Match the existing style: pure functions for anything harmonic, hooks for anything
stateful, copy that says what a control does in plain terms. When you add UI text, keep
it concrete — a label labels, a description describes, nothing does double duty. If a
change alters the harmonic behaviour, add or update a test rather than eyeballing it.
