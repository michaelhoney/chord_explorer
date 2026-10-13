import { useRef } from "react";
import { chordNoteNames, optionDistance } from "./harmony.js";
import { optKey } from "./futures.js";
import { ModHead } from "../panel/parts.jsx";

// ------------------------------------------------------------------------
//  FUTURES — every chord that could come next, one line each
// ------------------------------------------------------------------------
const MAX_TENSION = 4.5; // the top of the tension meter, matching the engine's range
const METER = 8; // squares in a tension meter

export default function FutureList({
  options, total, current, keyRoot, fromMidi, voiceLead, exiting, listKey, listRef,
  query, onQuery, hiddenBy, tensionDesc, onFlipSort, onPick, onPreview,
}) {
  const filtering = query.trim() !== "";
  // Enter commits the top match, so "fsus4 ⏎" plays the chord you came for. The
  // row element is what the flight animation measures from, hence the lookup.
  const onKeyDown = (e) => {
    if (e.key === "Escape") { onQuery(""); e.currentTarget.blur(); }
    if (e.key === "Enter" && options.length) {
      onPick(options[0], listRef.current?.querySelector(".ce-future"));
    }
  };
  return (
    <div className="ce-futures">
      <div className="ce-fut-head">
        <ModHead n="05">{current ? `From ${current.name} — next` : "Start on any chord"}</ModHead>
        <label className="ce-filter">
          <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.1">
            <circle cx="5" cy="5" r="3.8" />
            <path d="M8 8l3 3" />
          </svg>
          <input
            type="search"
            value={query}
            placeholder="filter — bvii, f#, sus"
            aria-label="Filter the chords by name or roman numeral"
            title="Filter by name or roman numeral — “sus”, “♭VII”, “F♯”. Enter picks the top match."
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {filtering && <span className="ce-futures-count">{options.length}/{total}</span>}
        </label>
      </div>
      <div className="ce-future head">
        <button
          type="button"
          className="ce-futures-axis"
          onClick={onFlipSort}
          aria-label={`Sorted by tension, ${tensionDesc ? "most tense first" : "least tense first"}. Flip the order.`}
          title={(tensionDesc ? "Most tense first" : "Least tense first") + " — click to flip the order"}
        >
          Tension {tensionDesc ? "↓" : "↑"}
        </button>
        <span>Chord</span>
        <span className="ce-fu-roman">Degree</span>
        <span className="ce-fu-notes">Notes</span>
        <span className="ce-fu-dist">Δ</span>
        <span className="ce-fu-move">What it does</span>
      </div>
      {/* keyed on the whole option set so the assemble animation replays */}
      <div className="ce-futures-list" key={listKey} ref={listRef}>
        {options.map((o, i) => (
          <FutureRow
            key={optKey(o)}
            i={i}
            opt={o}
            keyRoot={keyRoot}
            dist={optionDistance(fromMidi, o, voiceLead)}
            state={exiting ? (exiting === optKey(o) ? "chosen" : "leaving") : ""}
            onPick={onPick}
            onPreview={onPreview}
          />
        ))}
      </div>
      {filtering && (!options.length || hiddenBy.length > 0) && (
        <p className="ce-futures-note" role="status">
          {!options.length && <span>Nothing here matches “{query.trim()}”.</span>}
          {hiddenBy.map((g) => (
            <button key={g.label} type="button" className="ce-futures-hint" onClick={g.turnOn}>
              +{g.hits.length} more with {g.label} on
            </button>
          ))}
        </p>
      )}
    </div>
  );
}

function FutureRow({ opt, i, keyRoot, dist, state, onPick, onPreview }) {
  const ref = useRef(null);
  const notes = chordNoteNames(opt, keyRoot).join(" ");
  // at least one square, so the calmest chord still reads as a meter
  const lit = Math.max(1, Math.round((Math.min(opt.tension, MAX_TENSION) / MAX_TENSION) * METER));
  return (
    <button
      ref={ref}
      type="button"
      className={"ce-future" + (opt.resolution ? " resolve" : "") + (state ? " " + state : "")}
      style={{ "--i": i }}
      onClick={() => onPick(opt, ref.current)}
      title={
        `${opt.name} — ${notes} · ${opt.func}` +
        (opt.motion ? ` · root ${opt.motion}` : "") +
        `\n${opt.move}`
      }
    >
      {/* what the chord does and how hard it pulls, in one block: the function
          printed small over a meter of squares lit to its tension */}
      <span className="ce-fu-tension" aria-hidden="true">
        <span className="ce-fu-func">{opt.func}</span>
        <span className="ce-fu-meter">
          {Array.from({ length: METER }, (_, j) => (
            <i key={j} className={j < lit ? "lit" : undefined} />
          ))}
        </span>
      </span>
      {/* hovering auditions the chord — the name alone, so reading a row is silent */}
      <span className="ce-fu-name" onMouseEnter={() => onPreview(opt)}>{opt.name}</span>
      <span className="ce-fu-roman">{opt.roman}</span>
      <span className="ce-fu-notes">{notes}</span>
      <span className="ce-fu-dist">
        {dist != null && (
          <span title={`${dist} semitone${dist === 1 ? "" : "s"} of voice movement from the current chord`}>
            Δ{dist}
          </span>
        )}
      </span>
      <span className="ce-fu-move">
        {opt.move}
        {opt.resolution && <span className="ce-fu-res">Resolves</span>}
      </span>
    </button>
  );
}
