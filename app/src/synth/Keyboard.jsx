import { useState, useEffect, useRef } from "react";
import { SYM } from "../panel/symbols.jsx";

// ------------------------------------------------------------------------
//  KEYS — a tiny keyboard, two octaves like an MPK Mini's 25
// ------------------------------------------------------------------------
// Press and hold to sound a note; slide along the keys to play the ones you
// cross. With the keyboard focused (click it, or Tab to it) the computer's
// keys play it too, laid out the way a DAW does: A to K are the white keys,
// W E T Y U the black ones, Z and X shift an octave. Only while focused, so
// typing anywhere else on the page never plays a note.
//
// A key is lit while its note is held — from here, from MIDI in, or by the
// pedal — and while the explorer is sounding it, so chords played from above
// show up here too.

const WHITE_PCS = [0, 2, 4, 5, 7, 9, 11];
const SPAN = 25; // C to C, two octaves
const VELOCITY = 0.8; // a mouse has no velocity; this sits where a firm press would
const LOWEST = 24; // C1
const HIGHEST = 84; // C6, so the top key is C8

// the computer keys, as semitones above the keyboard's lowest C
const TYPED = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8,
  KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16, Quote: 17,
};
const LETTER = Object.fromEntries(
  Object.entries(TYPED).map(([code, n]) => [n, code === "Semicolon" ? ";" : code === "Quote" ? "'" : code.slice(3)])
);
const octaveName = (m) => `C${Math.floor(m / 12) - 1}`;

export default function Keyboard({ engine }) {
  const [base, setBase] = useState(48); // C3–C5
  const [lit, setLit] = useState(() => new Set());
  const [focused, setFocused] = useState(false);
  const ref = useRef(null);
  const pointers = useRef(new Map()); // pointerId → the note it's holding
  // computer key → the note it started, so shifting octave mid-hold still lets
  // go of the note you're holding rather than one an octave away
  const typed = useRef(new Map());

  useEffect(() => engine.subscribe(setLit), [engine]);

  const noteAt = (x, y) => {
    const el = document.elementFromPoint(x, y)?.closest?.("[data-midi]");
    return el && ref.current?.contains(el) ? Number(el.dataset.midi) : null;
  };

  // Driven from the window, not the keys: a slide crosses many keys, and a
  // release can land anywhere — off the keyboard, off the page.
  useEffect(() => {
    const held = pointers.current;
    const move = (e) => {
      const m = held.get(e.pointerId);
      if (m == null) return;
      if (!e.buttons) return up(e); // let go somewhere we didn't hear about
      const next = noteAt(e.clientX, e.clientY);
      if (next == null || next === m) return;
      engine.noteOff(m);
      engine.noteOn(next, VELOCITY);
      held.set(e.pointerId, next);
    };
    const up = (e) => {
      const m = held.get(e.pointerId);
      if (m == null) return;
      held.delete(e.pointerId);
      engine.noteOff(m);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      held.forEach((m) => engine.noteOff(m));
      held.clear();
    };
  }, [engine]);

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    const m = Number(e.target.closest("[data-midi]")?.dataset.midi);
    if (!Number.isFinite(m)) return;
    e.preventDefault(); // no text selection, no drag ghost; focus by hand instead
    ref.current.focus();
    pointers.current.set(e.pointerId, m);
    engine.noteOn(m, VELOCITY);
  };

  const shift = (by) => setBase((b) => Math.min(HIGHEST, Math.max(LOWEST, b + by)));

  const onKeyDown = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === "KeyZ" || e.code === "KeyX") {
      e.preventDefault();
      shift(e.code === "KeyZ" ? -12 : 12);
      return;
    }
    const n = TYPED[e.code];
    if (n == null) return;
    e.preventDefault();
    if (e.repeat || typed.current.has(e.code)) return;
    typed.current.set(e.code, base + n);
    engine.noteOn(base + n, VELOCITY);
  };
  const onKeyUp = (e) => {
    const m = typed.current.get(e.code);
    if (m == null) return;
    typed.current.delete(e.code);
    engine.noteOff(m);
  };
  // focus gone, key-ups gone with it: let go of everything typed
  const onBlur = () => {
    typed.current.forEach((m) => engine.noteOff(m));
    typed.current.clear();
    setFocused(false);
  };

  const notes = Array.from({ length: SPAN }, (_, i) => base + i);
  const whites = notes.filter((m) => WHITE_PCS.includes(m % 12));
  const W = whites.length;

  return (
    <div className="ce-kb-wrap">
      <div className="ce-kb-oct">
        <button className="ce-key" onClick={() => shift(-12)} disabled={base <= LOWEST} aria-label="Octave down" title="Down an octave (Z)">
          {SYM.down}
        </button>
        <span className="ce-print" aria-live="polite">{octaveName(base)}–{octaveName(base + SPAN - 1)}</span>
        <button className="ce-key" onClick={() => shift(12)} disabled={base >= HIGHEST} aria-label="Octave up" title="Up an octave (X)">
          {SYM.up}
        </button>
      </div>
      <div
        ref={ref}
        className={"ce-kb" + (focused ? " focused" : "")}
        tabIndex={0}
        role="group"
        aria-label={`Keyboard, ${octaveName(base)} to ${octaveName(base + SPAN - 1)}. While it has focus, A to K play the white keys, W E T Y U the black ones, and Z and X shift the octave.`}
        title="Press and hold to play; slide across the keys. Click the keyboard, then type: A–K are the white keys, W E T Y U the black, Z / X shift the octave."
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onFocus={() => setFocused(true)}
        onBlur={onBlur}
      >
        {whites.map((m) => (
          <div key={m} data-midi={m} className={"ce-kb-w" + (lit.has(m) ? " lit" : "")}>
            {focused && LETTER[m - base] != null && <span className="ce-kb-letter">{LETTER[m - base]}</span>}
            {m % 12 === 0 && <span className="ce-kb-c">{octaveName(m)}</span>}
          </div>
        ))}
        {notes
          .filter((m) => !WHITE_PCS.includes(m % 12))
          .map((m) => {
            // sits over the boundary after the white key below it
            const below = whites.indexOf(m - 1) + 1;
            return (
              <div
                key={m}
                data-midi={m}
                className={"ce-kb-b" + (lit.has(m) ? " lit" : "")}
                style={{ left: `calc(${(below / W) * 100}% - var(--kb-bw) / 2)` }}
              >
                {focused && LETTER[m - base] != null && <span className="ce-kb-letter">{LETTER[m - base]}</span>}
              </div>
            );
          })}
      </div>
    </div>
  );
}
