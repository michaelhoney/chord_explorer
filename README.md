# Chord Paths

A browser tool for exploring chord progressions by ear and by function. You pick a
chord, it plays, and it shows you the moves that follow — each one tagged with its
**root motion** ("up a fourth") and what it **does** harmonically ("Deceptive cadence —
you expect home, you get the relative minor"). Build a progression, watch its tension
rise and resolve, play it back.

Below it sits **the synth** it plays through — an instrument in its own right, with a
resonant lowpass/highpass filter and a filter envelope, a scope that shows you what the filter
is doing to the sound, a tiny keyboard, and MIDI in for a controller like an AKAI MPK Mini.

It's a Vite + React app in `app/`, using [Tone.js](https://tonejs.github.io/) for audio. No
backend, no build-time secrets, runs entirely client-side.

> This README has two readers. Everything down to **"For a Claude Code agent"** is for you.
> That section is the operational briefing — if you'd rather, lift it into a `CLAUDE.md`,
> which Claude Code reads automatically.

---

## Quickstart

Needs Node 18+. From the repo:

```bash
cd app
npm install
npm run dev
```

Audio starts on your first press — a click or a key (browsers block autoplay until a
gesture — this is expected). The type faces load from Google Fonts; if you're offline
it falls back to system fonts and still works.

## Using it

The controls are grouped by what they act on: **chord population** on the left of the
header (key, mode, 7ths, Sus, Suggest, Mutate, and Loop / Evolve), **playback preferences** on the right
(voice-leading, bass, arpeggio, feel, output, tempo), and **transport and editing** down with the
progression itself. The share icon at the top right copies a link to whatever you have.

Set a **key** and **major/minor**, then click any chord to start. The **7ths** toggle
enriches the diatonic chords (V becomes V7, etc.). **Tempo** controls playback speed, and
**Loop** makes Play repeat the progression until you press Stop — both apply to a run
already in progress.

**Arpeggio** plays each chord one note at a time, the notes spread evenly across the chord's
beats so the line runs straight on into the next chord. **-4-** gives a three-note chord a
fourth step by coming back to its middle note (1 3 5 3), so every chord keeps the same
rhythm; **rise** plays low to high, **random** shuffles the order afresh each time. With
**Bass** on, **hold bass** chooses where the bass goes: off, it's the arpeggio's first note
(bass, 1, 3, 5); on, it holds for the whole chord while the arpeggio runs over it (1 3 5 3
above a held bass).

**Dynamics** spreads the voices of a chord apart in volume (firm bass, singing top, inner
voices tucked under); at zero every note is equally loud, which is the organ sound.
**Humanise** scatters volume and timing by a few percent so a chord sounds struck rather
than triggered. They're about how a chord is *played*, so they go out the MIDI port as well.

**Output** sends the notes to an external instrument instead of the synth below. Click
*Enable MIDI* and allow the permission — it switches to the first port it finds, and the
dropdown lets you pick another; switching output mid-run moves the
sound across, and Stop sends an all-notes-off so nothing hangs on the hardware. Needs
Chrome 43+ or Firefox 108+ — Safari has never shipped Web MIDI, on macOS or iOS — and a
secure context, so HTTPS or localhost. The control says which of those is missing rather
than sitting there dead. The **Chan** keys pick the channel.

### The synth

The second device on the page is the synth the explorer plays through — and you can play it
yourself. It's a polysynth: each note gets its own oscillator, filter and envelopes.

- **Presets** set every level rather than hiding them, so they're somewhere to start from
  and read; **—** lights the moment you move one. Pluck and Brass are the filter envelope's
  worked examples (fast and shut, slow and swelling), Reed is the highpass one, Sweep the
  LFO's, and Organ is deliberately flat — no filter movement at all — so you can hear what
  the others are doing by switching to it and back.
- **Osc** — waveform, *Spread* (three detuned copies of the oscillator: a little is width, a
  lot is seasick) and *Drive*.
- **Filter** — **lowpass or highpass**, *Cutoff* and *Resonance*, and an **LFO** sweeping the
  cutoff. Lowpass keeps what's under the cutoff, so closing it darkens the sound; highpass
  keeps what's above, and thins it from the bottom up.
- **Filter env** — the filter's own envelope, like a Minimoog's filter contour: *Amount* is
  how many octaves it opens the filter at its peak, then *Attack*, *Decay* and *Sustain*.
  There's no separate release: the filter closes over the amp's release, so a note darkens
  as it fades. At Amount zero the filter ignores it.
- **Amp env** — attack, decay, sustain, release: short attack and low sustain is a pluck;
  long attack and high sustain is a pad.
- **Space** — chorus, reverb, and how long the room takes to die away.

The **scope** shows what the filter is doing, two ways, comparing what goes into the filter
(grey) with what comes out (lit). **Wave** is the waveform, held still like a hardware scope:
close a lowpass on a sawtooth and its corners round off; wind up the resonance and it rings.
**Spectrum** is the same by frequency, with the filter's response drawn over it — the line
moves as the envelope opens and closes the filter and the LFO sweeps it, the cutoff is read
out live, and the dashed line shows where the envelope opens it to.

**Keys** is a two-octave keyboard (like an MPK Mini's 25 keys): press and hold, or slide
across. Click it and your computer keys play it too — A to K are the white keys, W E T Y U
the black ones, Z and X shift the octave. **In** listens to MIDI controllers: plug in an MPK
Mini, press **On**, and its keys and pads play the synth (on any channel), with the sustain
pedal and pitch bend working too. Like MIDI out, it needs Chrome or Firefox. Keys light up
whenever their note sounds — including the explorer's chords.

Everything retunes live — turn a knob while a loop is playing and you hear it in the next
chord. Letting go of a level replays the last thing the synth played, so you can design a
sound with the loop stopped. The patch rides along in the share link. It works everywhere,
Safari included — it needs no MIDI and no permission, just a press to start the audio. On an
iPhone, note that Safari honours the **ringer switch** for web audio: on silent, there's
nothing to hear.

Every chord you could play next is listed below the progression, one line
each — name, roman numeral, the notes in the chord, the voice movement picking it would
cost (Δ), and what the move *does*. They're **ordered by tension**, least tense first, so
the resolutions sit at the top and the list runs out toward "outside" — click **tension**
in the header to flip it and open on the outside chords instead. Hovering a chord's **name** auditions it, so
you can run down the column and hear the options without committing; clicking anywhere on
the row commits it, and the row flies into the roll and bursts into its note pills while
the next set of futures assembles.

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

**Suggest** proposes a loop — 2, 4 or 8 bars — by walking the transition graph with the
same ranking that orders the futures list, biased so the last bar hands back to the first.
Click it again to re-roll. It replaces whatever is in the progression, so share the link
first if you want to keep something.

**Drag a chord tile left or right to reorder it** — the voice leading re-solves as you
drag, so you can see what a different order costs before you drop it. The **×** on a tile
removes that chord. Both work from the keyboard too: focus a tile, then **Alt+←/→** to
move it and **Delete** to remove it.

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

**Bass** adds each chord's root underneath, down where a bass player would put it. It takes
whichever octave is nearest the last bass note, so it walks like a bass line rather than
jumping around, and it gets its own lane under the piano roll. With it on, a tile's **▲/▼**
move the bass through the chord's tones as well as re-voicing the chord — ▲ on C gives C/E,
then C/G — so a line like C · G/B · Am is two clicks away. The voice-leading and the Δ
numbers stay about the upper voices; the bass's movement is the root motion the descriptions
already name.

## Roadmap, roughly in order of fun

1. ✅ **Web MIDI out** — done; the **Output** selector drives external instruments.
   Confirmed working into a Waldorf Protein over USB-C, in Chrome.
2. ✅ **Voice-leading** — done; the **Voice-leading** toggle places each chord's tones
   nearest the previous chord's, and the piano roll makes the held voices visible.
3. ✅ **"Suggest a loop"** — done; the **Suggest** button proposes a 2/4/8-bar loop.
4. ✅ **A synth worth listening to** — done; the **Sound** panel, with a filter LFO and
   velocity shaping, so the progressions land for people without a MIDI rig.
5. **Save progressions** — localStorage or export to a small text format. (The
   no-storage rule you may have seen was an artifact-sandbox limitation; a real Vite app
   has no such constraint.)
6. **Inversions and richer voicings** — slash chords, drop-2, open voicings.
7. **Export** — MIDI file, or a chord-chart / lead-sheet string.
8. **Random start** — a naked URL (no query string) opens in a random key, major or minor,
   with a 4-bar `suggestLoop` already in the progression, so a first visit starts with
   something to play rather than an empty page. A shared link still opens exactly as written.
9. **Evolve** — a toggle beside Loop: every time the loop comes round, replace the
   progression with a fresh suggestion of the same length (same key), so a loop keeps
   changing while it plays.
10. ✅ **The synth as an instrument** — done; its own device, with a lowpass/highpass
    filter, a filter envelope, a scope, a keyboard and MIDI in.
11. **Knobs from a controller** — MIDI learn, so an MPK Mini's eight knobs can turn the
    cutoff, resonance and the rest.
12. **More filter** — key tracking, velocity to filter, a 12dB slope, bandpass and notch.

---

## For a Claude Code agent

You're working on two kinds of thing: **pure, import-free model modules** and a
**React/Tone.js presentation layer**. Keep that seam clean; it's the main lever for
testability and for everything on the backlog.

### File map

Everything is under `app/src/`. CLAUDE.md has the full map and the reasons.

- `chords/` — the explorer. `harmony.js` (the harmony engine) and `perform.js` (how a chord
  is struck: velocity shaping, arpeggios, the note events) have no imports at all, so they
  test in plain Node; `state.js` is its slice of the URL; `ChordExplorer.jsx` is the device.
- `synth/` — the instrument. `params.js` (the knobs, presets and how a patch packs into a
  URL) and `dsp.js` (the display's maths) are import-free too; `engine.js` is the signal
  chain — the only file that builds audio nodes; `Synth.jsx` is the device, with `Scope.jsx`
  and `Keyboard.jsx`.
- `midi/` — one shared MIDI access, out, in, and a pure message parser.
- `panel/` — the hardware both devices are built from: keys, levels, lamps, the stylesheet.
- `App.jsx` — the desk: the only file that imports both devices. `url.js` — the address bar
  they share.
- A `*.test.js` beside every pure module; `npm test` runs them all.

Reading the harmony engine top to bottom:

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
- **The engine** (`synth/engine.js`) — per voice, oscillator → filter (with its own
  envelope) → amp envelope; an LFO on every voice's cutoff; drive, chorus and reverb after.
  Audio starts from the first `pointerdown`/`keydown` on the page. CLAUDE.md has the detail,
  and the Safari reason it can't be a click.
- **Styles** — plain `.css` files per module, with the design tokens as CSS custom
  properties on `.ce-root`.

### Invariants — don't break these

- **Function is load-bearing pedagogy.** Every chord *must* be assigned a
  `func` (one of `tonic | predominant | dominant | subtonic | secondary | borrowed`),
  which the next-chord list prints beside each chord, and a numeric `tension`, which
  lights its tension meter. If you add a chord type, wire up both.
- **The model modules are pure.** `buildKey`, `classify`, `optionsFrom`, `velocityCurve`,
  `filterResponse` etc. take data and return data — no React, no Tone, no DOM.
  `harmony.js`, `perform.js`, `params.js`, `dsp.js` and `messages.js` have no imports; don't
  add any. It's what makes them unit-testable.
- **Only the synth's engine builds audio nodes.** The explorer hands it note events; the
  synth knows nothing about chords.
- **Audio starts on `pointerdown`/`keydown`, never on `click`.** Safari 27 has withdrawn a
  click's user activation by the time its handler runs, so audio started from `onClick` is
  silently blocked there. Don't start it from a hover, module load or a bare `useEffect`
  either.
- **Pitch classes are integers 0–11.** All harmonic math goes through them. Note strings
  are for display and for handing to Tone, never for logic.
- **Tailwind is not available here** and was avoided deliberately — styles are plain `.css`
  files, one per module. Preserve the CSS-variable token system.

### Tests

Every pure module has a suite beside it. `chords/harmony.test.js` covers the harmony engine
— key building in all three modes, `classify`, colour chords and suspensions, `optionsFrom`
ranking and cadence copy, and the voicing helpers (common tones held, inversion rolls,
`computeVoicings` purity, midi→note conversion). `synth/params.test.js` and
`synth/dsp.test.js` cover the patch model and the display's maths (the response curve is
Web Audio's own biquad), `chords/perform.test.js` and `chords/state.test.js` how chords are
struck and linked, and `midi/messages.test.js` reading a controller.

```bash
npm test         # vitest run
npm run test:watch
```

Then pick from the roadmap above. Web MIDI needs a secure context — `localhost` counts, so
`npm run dev` is fine — and Safari has never shipped it; the MIDI controls say so rather than
failing silently.

### Conventions

Match the existing style: pure functions for anything harmonic, hooks for anything
stateful, copy that says what a control does in plain terms. When you add UI text, keep
it concrete — a label labels, a description describes, nothing does double duty. If a
change alters the harmonic behaviour, add or update a test rather than eyeballing it.
