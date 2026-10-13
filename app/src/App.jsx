import { useMemo, useState } from "react";
import ChordExplorer from "./chords/ChordExplorer.jsx";
import Synth from "./synth/Synth.jsx";
import { decodeState, randomStart } from "./chords/state.js";
import { unpackSynth, retiredFromSynth } from "./synth/params.js";
import { useSynthEngine } from "./synth/engine.js";
import { useMidiAccess } from "./midi/access.js";
import "./panel/panel.css";

/* ------------------------------------------------------------------ *
 *  THE DESK — two devices, cabled together
 *
 *  The chord explorer is a sequencer: it decides which chords and how
 *  they're struck. The synth is an instrument: the explorer plays it, and
 *  so do its own keyboard and a MIDI controller. Neither reaches into the
 *  other; what they share lives here — the engine (the synth's sound,
 *  which the explorer plays through), the page's MIDI access, the lamp
 *  colour, and whether the browser is letting either make a sound.
 * ------------------------------------------------------------------ */

// what the lights burn — one picked at random on each visit
const LAMPS = ["#FF5F1F", "#ED67B4", "#58B4B9", "#FFB000", "#2FD37A", "#FF2E3F", "#2E8BFF"];

// How the page opens. A link opens exactly as written — any parameter at
// all, even ?k=0 — and only a naked URL rolls a random key and a suggestion,
// so a shared link or a reload is never re-rolled. A link from before
// Dynamics and Humanise moved to the explorer carried them in the synth's
// patch; they're handed across.
function bootFrom(search) {
  const sy = new URLSearchParams(search).get("sy");
  return {
    chords: decodeState(search, retiredFromSynth(sy)) || randomStart(),
    sound: unpackSynth(sy),
  };
}

export default function App() {
  const boot = useMemo(() => bootFrom(window.location.search), []);
  const [sound, setSound] = useState(boot.sound);
  const [engine, blocked] = useSynthEngine(sound);
  const midiAccess = useMidiAccess();
  // the colour every light on the desk burns, a new one each visit — not in
  // the URL, since it's about this visit rather than the music
  const [lamp, setLamp] = useState(() => LAMPS[Math.floor(Math.random() * LAMPS.length)]);
  // dismissing is for this visit and both devices; not in the URL — it's
  // about this browser
  const [noSoundDismissed, setNoSoundDismissed] = useState(false);
  const noSound = blocked && !noSoundDismissed;
  const dismiss = () => setNoSoundDismissed(true);

  return (
    <div className="ce-root" style={{ "--lamp": lamp }}>
      <div className="ce-lamps" role="radiogroup" aria-label="Lamp colour">
        {LAMPS.map((c) => (
          <button
            key={c}
            role="radio"
            aria-checked={lamp === c}
            aria-label={`Lamp colour ${c}`}
            style={{ "--sw": c }}
            onClick={() => setLamp(c)}
          />
        ))}
      </div>
      <ChordExplorer
        boot={boot.chords}
        engine={engine}
        midiAccess={midiAccess}
        noSound={noSound}
        onDismissNoSound={dismiss}
      />
      <Synth
        engine={engine}
        sound={sound}
        setSound={setSound}
        midiAccess={midiAccess}
        lamp={lamp}
        noSound={noSound}
        onDismissNoSound={dismiss}
      />
    </div>
  );
}
