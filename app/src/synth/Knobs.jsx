import { SYNTH_PARAMS, paramToPos, formatParam } from "./params.js";
import { Toggle } from "../panel/parts.jsx";

// ------------------------------------------------------------------------
//  KNOBS — the controller's eight knobs, drawn as they sit on it
// ------------------------------------------------------------------------
// Two rows of four, like an MPK Mini. Each slot says which knob it is (the CC
// it listens for), which level it turns and where that level is — and, while
// the knob hasn't picked its level up yet, where the knob is. K1–K8 light as
// their knob moves. `k` is useKnobs' result.
const METER = 16;

export default function Knobs({ k, sound, listening }) {
  const nameOf = (p) => `${SYNTH_PARAMS[p].group} ${SYNTH_PARAMS[p].label}`;
  // in Map, what to do next comes first — slots and levels can be paired
  // without the controller, so MIDI In being off is only worth saying outside it
  const hint = k.mapping
    ? k.pending
      ? `Now turn the knob you want on ${nameOf(k.pending)}${listening ? "" : " — with MIDI In on"}, or click a slot.`
      : k.armed != null
        ? `Click any level to put K${k.armed + 1} on it, or turn another knob. Esc when you're done.`
        : "Turn a knob, or pick a slot — then click the level it should turn. Esc when you're done."
    : !listening
      ? "Turn MIDI In on and these follow your controller's knobs."
      : "Turn a knob to move its level. If they disagree — after a preset, say — the knob waits until it reaches the level, then takes it.";
  return (
    <div className="ce-knobs-wrap">
      <div className="ce-knobs-top">
        <div className="ce-bg">
          <Toggle
            on={k.mapping}
            onClick={() => k.setMap(!k.mapping)}
            title="Map: turn a knob and click a level, in either order, to put that knob on that level"
          >
            Map
          </Toggle>
        </div>
        <button
          className="ce-key"
          onClick={k.reset}
          title="Put the knobs back as they came: K1–K8 on CC 70–77, on the filter, its LFO and the amp"
        >
          Default
        </button>
        <p className="ce-print ce-knobs-hint" role="status">{hint}</p>
      </div>
      <div className="ce-knobs" role="group" aria-label="Knobs">
        {k.slots.map((s, i) => {
          const p = s.param ? SYNTH_PARAMS[s.param] : null;
          const knob = s.cc != null ? k.heldBy[s.cc] : null;
          const pos = p ? paramToPos(s.param, sound[s.param]) / 1000 : 0;
          const ghost = p && knob && !knob.held && knob.pos != null && !k.mapping ? knob.pos : null;
          const armed = k.mapping && k.armed === i;
          return (
            <div
              key={i}
              className={"ce-knob" + (armed ? " armed" : "") + (k.touched.has(i) ? " touched" : "")}
            >
              <button
                type="button"
                className="ce-knob-face"
                onClick={() => k.pickSlot(i)}
                aria-pressed={armed}
                title={
                  (p ? `K${i + 1} turns ${nameOf(s.param)}` : `K${i + 1} turns nothing yet`) +
                  (s.cc != null ? ` — the knob sending CC ${s.cc}` : "") +
                  ". Click to remap it."
                }
              >
                <span className="ce-knob-top">
                  <b>K{i + 1}</b>
                  <span>{s.cc != null ? `CC ${s.cc}` : "no knob"}</span>
                </span>
                <span className="ce-knob-group">{p ? p.group : " "}</span>
                <span className="ce-knob-name">{p ? p.label : "—"}</span>
                <span className="ce-knob-val">{p ? formatParam(s.param, sound[s.param]) : " "}</span>
                <span className="ce-knob-meter" aria-hidden="true">
                  {Array.from({ length: METER }, (_, j) => (
                    <i key={j} className={p && j < Math.round(pos * METER) ? "lit" : undefined} />
                  ))}
                  {ghost != null && <b style={{ left: `${ghost * 100}%` }} />}
                </span>
              </button>
              {armed && p && (
                <button
                  type="button"
                  className="ce-knob-x"
                  onClick={() => k.clearSlot(i)}
                  aria-label={`Take K${i + 1} off ${nameOf(s.param)}`}
                  title={`Take K${i + 1} off ${nameOf(s.param)}`}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
