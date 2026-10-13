import { useState, useEffect, useCallback, useRef } from "react";
import {
  SYNTH_PARAMS,
  SYNTH_GROUPS,
  PRESETS,
  presetNameFor,
  paramToPos,
  paramFromPos,
  formatParam,
  packSynth,
  isDefaultSound,
} from "./params.js";
import Scope from "./Scope.jsx";
import Keyboard from "./Keyboard.jsx";
import Knobs from "./Knobs.jsx";
import { useKnobs, mappable } from "./useKnobs.js";
import { ModHead, Field, Keys, Level, Led, NoSound } from "../panel/parts.jsx";
import { WAVE_SYM, FILTER_SYM } from "../panel/symbols.jsx";
import { MIDI_STATUS } from "../midi/access.js";
import { useMidiIn } from "../midi/in.js";
import { describeMidi, BEND_SEMITONES } from "../midi/messages.js";
import { useUrlSlice } from "../url.js";
import "./synth.css";

/* ------------------------------------------------------------------ *
 *  THE SYNTH — an instrument in its own right
 *
 *  A polysynth: per voice, an oscillator through a resonant filter with
 *  its own envelope, then an amp envelope; an LFO on every voice's cutoff;
 *  drive, chorus and reverb after. The explorer plays it from above; its
 *  own keyboard and a MIDI controller play it directly. The display shows
 *  what the filter is doing to the sound as you play.
 * ------------------------------------------------------------------ */

// enum legends: drawings where a word would be longer than the thing it names
const LEGENDS = { ...WAVE_SYM, ...FILTER_SYM };
const ENUM_TITLES = {
  lowpass: "Lowpass — keeps what's below the cutoff",
  highpass: "Highpass — keeps what's above the cutoff",
};

export default function Synth({ engine, sound, setSound, midiAccess, lamp, noSound, onDismissNoSound }) {
  // the synth's part of the address bar: the patch, when it isn't the default
  useUrlSlice("synth", isDefaultSound(sound) ? "" : `sy=${packSynth(sound)}`);

  // MIDI in: what a controller does to the synth. The lamp and the readout
  // are throttled — pitch bend alone can send a hundred messages a second,
  // and each would otherwise re-render every level on the panel.
  const [activity, setActivity] = useState(false);
  const [lastMsg, setLastMsg] = useState("");
  const readout = useRef({ text: "", timer: 0, off: 0 });
  useEffect(() => {
    const r = readout.current;
    return () => {
      clearTimeout(r.timer);
      clearTimeout(r.off);
    };
  }, []);
  // the controller's knobs on the levels (see useKnobs)
  const knobs = useKnobs(sound, setSound);
  const onCC = knobs.onCC;
  const onMidi = useCallback(
    (m) => {
      if (m.type === "noteon") engine.noteOn(m.note, m.velocity);
      else if (m.type === "noteoff") engine.noteOff(m.note);
      else if (m.type === "pedal") engine.setPedal(m.down);
      else if (m.type === "bend") engine.bend(m.amount * BEND_SEMITONES);
      else if (m.type === "alloff") engine.allNotesOff();
      else if (m.type === "cc") onCC(m.cc, m.value);
      const r = readout.current;
      r.text = describeMidi(m);
      setActivity(true);
      clearTimeout(r.off);
      r.off = setTimeout(() => setActivity(false), 140);
      if (!r.timer) {
        r.timer = setTimeout(() => {
          r.timer = 0;
          setLastMsg(r.text);
        }, 100);
      }
    },
    [engine, onCC]
  );
  const midiIn = useMidiIn(midiAccess, onMidi);
  const listening = midiIn.source !== "off";
  const midiDead = midiIn.status !== "ready" && MIDI_STATUS[midiIn.status].dead;

  return (
    <div className="ce-chassis ce-synth">
      <header className="ce-mod ce-plate">
        <h1>synth<small>poly · filter · scope</small></h1>
        <div className="ce-leds" aria-hidden="true">
          <NoteLed engine={engine} />
          <Led on={activity}>MIDI In</Led>
        </div>
        <div className="ce-grille" aria-hidden="true" />
      </header>

      <section className="ce-mod ce-s-disp" aria-label="Scope">
        {noSound && <NoSound onDismiss={onDismissNoSound} />}
        <Scope engine={engine} sound={sound} lamp={lamp} />
      </section>

      {/* beside the display, so you can pick one and watch what it does */}
      <section className="ce-mod ce-s-pre" aria-labelledby="ce-h-pre">
        <ModHead n="01" id="ce-h-pre">Presets</ModHead>
        <Presets sound={sound} setSound={setSound} onAudition={engine.audition} />
      </section>

      <section className="ce-mod ce-s-snd" aria-labelledby="ce-h-snd">
        <ModHead n="02" id="ce-h-snd">Sound</ModHead>
        <SoundColumns sound={sound} setSound={setSound} onAudition={engine.audition} knobs={knobs} />
      </section>

      <section className="ce-mod ce-s-keys" aria-labelledby="ce-h-keys">
        <ModHead n="03" id="ce-h-keys">Keys</ModHead>
        <Keyboard engine={engine} />
      </section>

      <section className="ce-mod ce-s-in" aria-labelledby="ce-h-in">
        <ModHead n="04" id="ce-h-in">In</ModHead>
        <div className="ce-stack">
          <Field label="Listen">
            <Keys
              label="MIDI in"
              value={listening ? "on" : "off"}
              onChange={(v) => midiIn.listen(v === "on" ? "all" : "off")}
              options={[
                { v: "off", label: "Off", title: "Ignore MIDI controllers" },
                {
                  v: "on",
                  label: "On",
                  disabled: midiDead,
                  title: midiIn.status === "ready"
                    ? "Play the synth from a MIDI controller — keys and pads on any channel, the sustain pedal, pitch bend"
                    : MIDI_STATUS[midiIn.status].hint,
                },
              ]}
            />
          </Field>
          <Field label="Port">
            {midiIn.status !== "ready" ? (
              <p className="ce-print" title={MIDI_STATUS[midiIn.status].hint}>
                {MIDI_STATUS[midiIn.status].label}
              </p>
            ) : (
              <Keys
                column
                label="MIDI input"
                value={midiIn.source}
                onChange={midiIn.listen}
                options={[
                  { v: "all", label: "All inputs", title: "Listen to every connected controller" },
                  ...midiIn.inputs.map((p, i) => ({ v: p.id, label: `${i + 1} · ${p.name}`, title: `Listen to ${p.name} only` })),
                ]}
              />
            )}
          </Field>
          <Field label="Last">
            <p className="ce-print ce-midi-last" title="The last message a controller sent">
              {listening ? lastMsg || "Waiting…" : "—"}
            </p>
          </Field>
        </div>
      </section>

      <section className="ce-mod ce-s-knobs" aria-labelledby="ce-h-knobs">
        <ModHead n="05" id="ce-h-knobs">Knobs</ModHead>
        <Knobs k={knobs} sound={sound} listening={listening} />
      </section>
    </div>
  );
}

// lit while the synth is sounding anything at all — its own little
// subscription, so the rest of the panel doesn't re-render on every note
function NoteLed({ engine }) {
  const [on, setOn] = useState(false);
  useEffect(() => engine.subscribe((notes) => setOn(notes.size > 0)), [engine]);
  return <Led on={on}>Note</Led>;
}

// ------------------------------------------------------------------------
//  SOUND — every control, read straight off SYNTH_PARAMS
// ------------------------------------------------------------------------
// One control per parameter, so adding a knob is a line in the table rather
// than a line of markup. Every level runs 0–1000 underneath whatever it
// controls (see paramToPos) — meaningless to read aloud, hence
// aria-valuetext carrying the formatted value instead. `knob` is what the
// level shows of the controller knob on it (see useKnobs' levelFor), and
// `pick`, in Map, makes a click choose the level rather than move it.
function Control({ k, value, onChange, onCommit, knob, pick }) {
  const p = SYNTH_PARAMS[k];
  if (p.kind === "enum") {
    return (
      <Field label={p.label} title={p.hint}>
        <Keys
          label={p.label}
          value={value}
          onChange={(v) => {
            onChange(v);
            onCommit?.();
          }}
          options={p.options.map((o) => ({ v: o, label: LEGENDS[o] ?? o, aria: o, title: ENUM_TITLES[o] ?? o }))}
        />
      </Field>
    );
  }
  return (
    <Level
      label={p.label}
      title={p.hint}
      pos={paramToPos(k, value) / 1000}
      text={formatParam(k, value)}
      onPos={(t) => onChange(paramFromPos(k, Math.round(t * 1000)))}
      // audition on release, not on every frame of the drag
      onCommit={onCommit}
      {...knob}
      pick={pick}
    />
  );
}

// An envelope as a shape, printed beside its heading so the levels under it
// read as one gesture. Segment widths follow the levels' own positions, not
// seconds: attack runs 2ms–2s on a log scale, and drawn in linear time a 15ms
// attack would be a vertical line. So it shows what the levels show — where
// each one is set — as the outline of a note: up, down to sustain, hold, away.
// `peak` scales the height: the filter envelope's is its amount, so at zero
// it lies flat, which is exactly what it does to the filter.
const ENVELOPES = {
  "Filter env": { keys: ["filterAttack", "filterDecay", "filterSustain", "release"], peak: (s) => (s.filterEnv > 0 ? 0.3 + (0.7 * s.filterEnv) / SYNTH_PARAMS.filterEnv.max : 0) },
  "Amp env": { keys: ["attack", "decay", "sustain", "release"], peak: () => 1 },
};
function EnvelopeGraph({ sound, keys: [ka, kd, ks, kr], peak = 1 }) {
  const W = 104, BASE = 22, TOP = 2, SEG = 26; // px; A, D and R each up to SEG wide
  const w = (k) => 3 + (SEG - 3) * (paramToPos(k, sound[k]) / 1000);
  const a = w(ka);
  const d = w(kd);
  const r = w(kr);
  const top = BASE - (BASE - TOP) * peak;
  const ys = BASE - (BASE - top) * sound[ks];
  const x1 = a, x2 = a + d, x3 = W - r; // the sustain holds from x2 to x3
  // decay and release fall away fast and then flatten, as the synth's do
  const path = `M0 ${BASE}L${x1} ${top}Q${x1 + d * 0.15} ${ys} ${x2} ${ys}L${x3} ${ys}Q${x3 + r * 0.15} ${BASE} ${W} ${BASE}`;
  return (
    <svg className={"ce-adsr" + (peak ? "" : " flat")} viewBox={`0 0 ${W} ${BASE}`} width={W} height={BASE} aria-hidden="true" focusable="false">
      <path className="ce-adsr-fill" d={`${path}Z`} />
      {[x1, x2, x3].map((x, i) => (
        <line key={i} className="ce-adsr-tick" x1={x} x2={x} y1={TOP} y2={BASE} />
      ))}
      <path className="ce-adsr-line" d={path} />
    </svg>
  );
}

// Presets are keys like everything else, and the last one, —, lights when
// the levels match none of them. Picking one plays it.
function Presets({ sound, setSound, onAudition }) {
  const preset = presetNameFor(sound);
  return (
    <>
      <Keys
        cols={3}
        label="Preset"
        value={preset ?? "custom"}
        onChange={(name) => {
          if (name === "custom") return;
          setSound({ ...PRESETS[name] });
          onAudition();
        }}
        options={[
          ...Object.keys(PRESETS).map((name) => ({ v: name, label: name, title: `${name} — a starting point; every level is still yours afterwards` })),
          { v: "custom", label: "—", aria: "Custom", title: "Custom: the levels match none of the presets" },
        ]}
      />
      <p className="ce-print ce-snd-note">
        Let go of a level to hear the last thing played. The explorer above plays
        through this synth unless its Out is set to MIDI.
      </p>
    </>
  );
}

// a column per group in SYNTH_PARAMS, so a new knob only has to name its group
function SoundColumns({ sound, setSound, onAudition, knobs }) {
  const set = (k) => (v) => setSound((s) => ({ ...s, [k]: v }));
  return (
    <div className="ce-snd-cols">
      {SYNTH_GROUPS.map((g) => (
        <div className="ce-snd-col" key={g.name}>
          <div className="ce-snd-hrow">
            <h3 className="ce-snd-h">{g.name}</h3>
            {ENVELOPES[g.name] && (
              <EnvelopeGraph sound={sound} keys={ENVELOPES[g.name].keys} peak={ENVELOPES[g.name].peak(sound)} />
            )}
          </div>
          <div className="ce-stack">
            {g.keys.map((k) => (
              <Control
                key={k}
                k={k}
                value={sound[k]}
                onChange={set(k)}
                onCommit={onAudition}
                knob={knobs.levelFor(k)}
                pick={knobs.mapping && mappable(k) ? () => knobs.pickLevel(k) : undefined}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
