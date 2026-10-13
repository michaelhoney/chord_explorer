import { useRef } from "react";

// ------------------------------------------------------------------------
//  PANEL PARTS — the few kinds of control both devices are built from
// ------------------------------------------------------------------------
// The face is a piece of hardware (design/hardware.html is the reference):
// a white chassis, modules set into it, keys with cut-out legends lit from
// behind, levels instead of sliders. Everything here is presentation only —
// no audio, no harmony — so the explorer and the synth share it as equals.

// A module's printed heading: its number, its name, a hairline to the edge.
export const ModHead = ({ n, id, children }) => (
  <h2 className="ce-mod-h" id={id}>
    <b>{n}</b>
    {children}
  </h2>
);

// a printed label over a control
export const Field = ({ label, title, children }) => (
  <div className="ce-f" title={title}>
    <span className="ce-lbl">{label}</span>
    {children}
  </div>
);

// A row of keys with cut-out legends, the chosen one lit from behind. This is
// what every dropdown became: the choices are always in view. `column` stacks
// them; `cols` lays them out as a block that many keys wide, and gives the
// four corner keys their corners.
export function Keys({ label, value, options, onChange, disabled, column, cols }) {
  const rows = cols ? Math.ceil(options.length / cols) : 0;
  const corner = (i) => {
    if (!cols) return "";
    const r = Math.floor(i / cols), c = i % cols;
    const lastRow = r === rows - 1;
    return (
      (r === 0 && c === 0 ? " tl" : "") +
      (r === 0 && c === cols - 1 ? " tr" : "") +
      (lastRow && c === 0 ? " bl" : "") +
      // a short last row still rounds the key at its end
      (lastRow && (c === cols - 1 || i === options.length - 1) ? " br" : "")
    );
  };
  return (
    <div
      className={"ce-bg" + (column ? " col" : "") + (cols ? " grid" : "")}
      style={cols ? { "--cols": cols } : undefined}
      role="radiogroup"
      aria-label={label}
    >
      {options.map((o, i) => (
        <button
          key={String(o.v)}
          role="radio"
          aria-checked={value === o.v}
          aria-label={o.aria}
          className={((value === o.v ? "on" : "") + corner(i)).trim() || undefined}
          disabled={disabled || o.disabled}
          title={o.title}
          onClick={() => onChange(o.v)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// a key that stays lit while it's on — sits in a .ce-bg, alone or with others
export const Toggle = ({ on, children, ...rest }) => (
  <button className={on ? "on" : undefined} aria-pressed={on} {...rest}>
    {children}
  </button>
);

// A level: a row of thin bars lit from behind up to the value, the rest dark.
// It stands in for a range input, so it carries the slider role and its keys —
// arrows step, Shift+arrows step ten times as far, Home and End go to the ends.
// `pos` is 0–1; the caller maps it onto whatever the level controls. `onStep`,
// if given, owns the arrow keys (tempo steps a whole BPM); otherwise they move
// a hundredth of the travel. Dragging is driven from the window, the same
// lesson as the roll's reordering: release anywhere and it still lets go.
// `onCommit` fires on release — which is when the synth auditions.
export function Level({ label, pos, text, onPos, onStep, onCommit, n = 36, wide, title }) {
  const bar = useRef(null);
  const clamp = (t) => Math.min(1, Math.max(0, t));
  const lit = Math.round(clamp(pos) * n);
  const fromX = (x) => {
    const r = bar.current.getBoundingClientRect();
    return clamp((x - r.left) / r.width);
  };
  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection; focus by hand instead
    bar.current.focus();
    onPos(fromX(e.clientX));
    function move(m) {
      if (!m.buttons) return up();
      onPos(fromX(m.clientX));
    }
    function up() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      onCommit?.();
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  const STEP_KEYS = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 };
  const onKeyDown = (e) => {
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      return onPos(e.key === "Home" ? 0 : 1);
    }
    const d = STEP_KEYS[e.key];
    if (!d) return;
    e.preventDefault();
    const by = d * (e.shiftKey ? 10 : 1);
    if (onStep) onStep(by);
    else onPos(clamp(pos + by / 100));
  };
  const onKeyUp = (e) => {
    if (e.key in STEP_KEYS || e.key === "Home" || e.key === "End") onCommit?.();
  };
  return (
    <div className={"ce-lvl" + (wide ? " wide" : "")} title={title}>
      <div className="ce-lvl-top">
        <span className="ce-lbl">{label}</span>
        <span className="ce-lvl-val">{text}</span>
      </div>
      <div
        ref={bar}
        className="ce-lvl-bar"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clamp(pos) * 100)}
        aria-valuetext={text}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
      >
        {Array.from({ length: n }, (_, i) => (
          <i key={i} className={i < lit ? "lit" : undefined} />
        ))}
      </div>
    </div>
  );
}

// An indicator lamp with its printed name
export const Led = ({ on, children }) => (
  <span className={"ce-led" + (on ? " on" : "")}>
    <i />
    {children}
  </span>
);

// Shown on a device's display when a press asked for audio and the browser
// said no (see the engine's unlock). Dismissing it is per visit, and covers
// both devices — it's the same refusal.
export function NoSound({ onDismiss }) {
  return (
    <div className="ce-nosound" role="status">
      <p>
        <b>No sound?</b> Your browser is blocking audio on this page. In Safari:
        Safari menu → <i>Settings for {window.location.hostname}…</i> → Auto-Play →{" "}
        <i>Allow All Auto-Play</i>, then reload. In other browsers, look for a sound
        or autoplay permission under the icon at the left of the address bar.
      </p>
      <button className="ce-nosound-x" onClick={onDismiss} aria-label="Dismiss" title="Dismiss">
        ×
      </button>
    </div>
  );
}

export const ShareIcon = () => (
  <svg viewBox="0 0 14 14" aria-hidden="true" focusable="false"
       fill="none" stroke="currentColor" strokeWidth="1.2">
    <path d="M7 1v8M3.5 4.5 7 1l3.5 3.5M2 8v4.5h10V8" />
  </svg>
);

export const Tick = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"
       fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 8.4 L6.4 11.8 L13 5.2" />
  </svg>
);

export const Chevron = ({ up }) => (
  <svg viewBox="0 0 12 8" width="11" height="7" aria-hidden="true" focusable="false">
    <path
      d={up ? "M1.5 6 L6 1.5 L10.5 6" : "M1.5 2 L6 6.5 L10.5 2"}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
