import {
  nameOf,
  mod12,
  chordNoteNames,
  midiToNotes,
  voicingDistance,
  voiceSteps,
  bassNameOf,
} from "./harmony.js";
import { ROLL } from "./roll.js";
import { Chevron } from "../panel/parts.jsx";

// Piano-roll progression: each voice sits at its pitch height, so common tones
// line up across columns and the voice leading is visible. Right-angled ink
// connectors trace each voice from one chord to the next — the way a panel
// draws — and the chord tile sits underneath.

// semitone step as a sequencer would read it: +2, -3, 0 for a held voice
const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "·");
const stepTitle = (n) =>
  n === 0
    ? "this voice holds"
    : `this voice moves ${n > 0 ? "+" : "−"}${Math.abs(n)} semitone${Math.abs(n) === 1 ? "" : "s"}`;
const octaveOf = (m) => Math.floor(m / 12) - 1; // C4 is 60

export default function PianoRoll({
  prog, voicings, bass, playingIdx, lit, keyRoot, spawn, colsRef, dragIdx, dragMoved,
  onPlay, onPlayNote, onInvert, onRemove, onDragStart, onTileKey,
}) {
  const { ROW, CELL, COL, GAP } = ROLL;
  const all = voicings.flat();
  if (!all.length) return null;
  const max = Math.max(...all);
  const min = Math.min(...all);
  const bandH = (max - min) * ROW + CELL;
  const width = prog.length * COL + Math.max(0, prog.length - 1) * GAP;
  const topOf = (m) => (max - m) * ROW; // pill top
  const cy = (m) => topOf(m) + CELL / 2; // pill centre

  // The bass voice gets its own lane under the chords rather than its true
  // height: it sits an octave or two below them, and drawing that honestly would
  // put a tall band of empty rows between the two. Pitch is still to scale
  // *within* each lane; the dashed rule marks where the scale breaks.
  const hasBass = !!(bass && bass.length);
  const bMax = hasBass ? Math.max(...bass) : 0;
  const bMin = hasBass ? Math.min(...bass) : 0;
  const laneTop = bandH + ROLL.LANE;
  const bassTop = (m) => laneTop + (bMax - m) * ROW;
  const rollH = hasBass ? laneTop + (bMax - bMin) * ROW + CELL : bandH;

  // connectors: pair voices by ascending pitch order across adjacent chords,
  // from the right edge of one pill to the left edge of the next — along, down
  // (or up) at the elbow, along again. Each voice turns at its own point in the
  // gap, lower voices sooner and higher ones later (0.4 / 0.5 / 0.6 of the way
  // for a triad): at a shared midpoint, every vertical run in a big move lies
  // on the same line and you can't tell which voice went where.
  const ELBOW_STEP = 0.1;
  const links = [];
  const link = (i, y1, y2, at = 0.5) => {
    const x1 = i * (COL + GAP) + COL;
    const x2 = (i + 1) * (COL + GAP);
    const elbow = x1 + (x2 - x1) * at;
    links.push(y1 === y2 ? `M${x1} ${y1}H${x2}` : `M${x1} ${y1}H${elbow}V${y2}H${x2}`);
  };
  for (let i = 0; i < voicings.length - 1; i++) {
    const a = [...voicings[i]].sort((p, q) => p - q);
    const b = [...voicings[i + 1]].sort((p, q) => p - q);
    const n = Math.min(a.length, b.length);
    for (let v = 0; v < n; v++) {
      const at = Math.min(0.8, Math.max(0.2, 0.5 + (v - (n - 1) / 2) * ELBOW_STEP));
      link(i, cy(a[v]), cy(b[v]), at);
    }
    // the bass has its own lane, so nothing to share its elbow with
    if (hasBass) link(i, bassTop(bass[i]) + CELL / 2, bassTop(bass[i + 1]) + CELL / 2);
  }

  return (
    <div className="ce-roll-inner" style={{ width }}>
      <svg className="ce-roll-links" width={width} height={rollH} aria-hidden="true">
        {hasBass && (
          <line
            className="ce-roll-lane"
            x1={0} x2={width} y1={bandH + ROLL.LANE / 2} y2={bandH + ROLL.LANE / 2}
          />
        )}
        {links.map((d, k) => <path key={k} d={d} className="ce-roll-link" />)}
      </svg>
      <div className="ce-roll-cols" ref={colsRef}>
        {prog.map((c, i) => {
          const midi = voicings[i];
          // the column that just landed: its pills fly in from the future row
          const born = spawn && spawn.idx === i;
          const prevSet = i > 0 ? new Set(voicings[i - 1]) : null;
          const rootName = nameOf(c.rootPc, keyRoot);
          // the slash names the lowest note you hear: the bass voice when it's on
          // (the root, unless the arrows have walked it to another chord tone),
          // otherwise the bottom of the voicing
          const bassName = hasBass ? nameOf(mod12(bass[i]), keyRoot) : bassNameOf(midi, keyRoot);
          const inverted = bassName !== rootName;
          const notes = chordNoteNames(c, keyRoot);
          // semitone travel from the previous chord (the connectors' total length)
          const dist = i > 0 ? voicingDistance(voicings[i - 1], midi) : null;
          // per-voice steps, for dialling the move into a chromatic sequencer
          const steps = i > 0 ? voiceSteps(voicings[i - 1], midi) : null;
          const pill = (m, { step, held, isBass, delay }) => (
            <button
              key={isBass ? "bass" : m}
              type="button"
              className={
                "ce-roll-note" +
                (isBass ? " bass" : "") +
                (held ? " held" : "") +
                (i === playingIdx && lit.has(m) ? " lit" : "") +
                (born ? " spawn" : "")
              }
              // --dx / --dy are measured after layout, in the parent
              style={{
                top: isBass ? bassTop(m) : topOf(m),
                ...(born ? { animationDelay: `${delay}ms` } : null),
              }}
              onClick={() => onPlayNote(m)}
              title={
                `Play ${midiToNotes([m])[0]}` +
                (isBass ? " · bass" : "") +
                (step == null ? "" : ` · ${stepTitle(step)}`)
              }
            >
              <span>{nameOf(mod12(m), keyRoot)}{octaveOf(m)}</span>
              {step != null && <em className="ce-roll-step">{signed(step)}</em>}
            </button>
          );
          return (
            <div
              key={c.id}
              className={
                "ce-roll-col" +
                (i === playingIdx ? " playing" : "") +
                (i === dragIdx ? " dragging" : "")
              }
              style={{ width: COL }}
            >
              <span className="ce-roll-notes" style={{ height: rollH }}>
                {[...midi].sort((a, b) => a - b).map((m, v) =>
                  pill(m, {
                    step: steps ? steps.get(m) : undefined,
                    held: prevSet && prevSet.has(m),
                    // the bass lands first, so the chord builds upward
                    delay: (v + (hasBass ? 1 : 0)) * 52,
                  })
                )}
                {hasBass &&
                  pill(bass[i], {
                    step: i > 0 ? bass[i] - bass[i - 1] : null,
                    held: i > 0 && bass[i - 1] === bass[i],
                    isBass: true,
                    delay: 0,
                  })}
              </span>
              <div className={"ce-roll-tilewrap" + (born ? " spawn" : "")}>
                <button
                  type="button"
                  className="ce-roll-tile"
                  onPointerDown={(e) => onDragStart(i, e)}
                  onClick={() => { if (!dragMoved()) onPlay(i); }}
                  onKeyDown={(e) => onTileKey(i, e)}
                  aria-label={`${c.name}, chord ${i + 1} of ${prog.length}. Alt with the arrow keys reorders, Delete removes.`}
                  title={`${c.name}${inverted ? "/" + bassName : ""} · ${notes.join(" ")} · ${c.move}\nDrag to reorder · Alt+← / Alt+→ · Delete to remove`}
                >
                  <span className="ce-chip-name">
                    {c.name}
                    {inverted && <span className="ce-chip-slash">/{bassName}</span>}
                  </span>
                  <span className="ce-chip-roman">
                    {c.roman}
                    {/* the first chord has nothing to measure from */}
                    {dist != null && (
                      <span
                        className="ce-chip-dist"
                        title={`${dist} semitone${dist === 1 ? "" : "s"} of voice movement from the previous chord`}
                      >
                        Δ{dist}
                      </span>
                    )}
                  </span>
                </button>
                <button
                  type="button"
                  className="ce-roll-del"
                  onClick={() => onRemove(i)}
                  aria-label={`Remove ${c.name} from the progression`}
                  title={`Remove ${c.name}`}
                >
                  ×
                </button>
                <span className="ce-roll-invert">
                  <button
                    type="button"
                    className="ce-inv-btn"
                    onClick={() => onInvert(i, +1)}
                    aria-label={hasBass ? "Move the bass up a chord tone" : "Raise the lowest note an octave"}
                    title={hasBass
                      ? "Move the bass up a chord tone, and raise the lowest upper note an octave"
                      : "Raise the lowest note an octave"}
                  >
                    <Chevron up />
                  </button>
                  <button
                    type="button"
                    className="ce-inv-btn"
                    onClick={() => onInvert(i, -1)}
                    aria-label={hasBass ? "Move the bass down a chord tone" : "Lower the highest note an octave"}
                    title={hasBass
                      ? "Move the bass down a chord tone, and lower the highest upper note an octave"
                      : "Lower the highest note an octave"}
                  >
                    <Chevron />
                  </button>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
