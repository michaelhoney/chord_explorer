import { useState, useEffect, useRef, useCallback } from "react";
import { SYNTH_PARAMS, paramToPos, paramFromPos } from "./params.js";
import {
  DEFAULT_KNOBS, assignParam, adoptCc, slotForCc, slotForParam, takeover, parseKnobs,
} from "./knobs.js";

// ------------------------------------------------------------------------
//  THE KNOBS, LIVE
// ------------------------------------------------------------------------
// A controller's knobs turning the synth's levels (see knobs.js for the
// slots and the pickup rule). Feed it controller changes with `onCC`; it
// moves `sound` through `setSound`, exactly as dragging the level would, so
// the sound, the URL and the panel all follow.
//
// **Map** is how a knob gets a level: in Map, turning a knob says *which*
// knob (it lights its slot, and moves nothing) and clicking a level says
// *what* — in either order. A knob the synth hasn't met takes the slot that's
// lit, or else the first slot whose knob hasn't been heard from this visit,
// so on a controller sending other CCs, turning the knobs left to right in
// Map fills K1 to K8.

const STORE = "chord-paths.knobs";
// a knob turns a level, not a key: there's no sensible way to turn a waveform
export const mappable = (k) => !!SYNTH_PARAMS[k] && SYNTH_PARAMS[k].kind !== "enum";
const posOf = (k, value) => paramToPos(k, value) / 1000;

function load() {
  try {
    return parseKnobs(window.localStorage.getItem(STORE), mappable) ?? DEFAULT_KNOBS;
  } catch {
    return DEFAULT_KNOBS; // storage blocked: the defaults, for this visit
  }
}

export function useKnobs(sound, setSound) {
  const [slots, setSlots] = useState(load);
  useEffect(() => {
    try {
      window.localStorage.setItem(STORE, JSON.stringify(slots));
    } catch {
      // not kept past this visit, which is all it costs
    }
  }, [slots]);
  const [mapping, setMapping] = useState(false);
  const [armed, setArmed] = useState(null); // the slot that's lit, in Map
  const [pending, setPending] = useState(null); // a level picked before its knob
  // each knob as last heard, by CC: where it is (0–1) and whether it holds its level
  const [heldBy, setHeldBy] = useState({});
  const [touched, setTouched] = useState(() => new Set()); // slots that just moved

  // Read by the batch below, which runs outside React. Assigned during render;
  // the batch also writes its own changes into `sound` here straight away, so
  // the next batch sees them even if React hasn't rendered in between.
  const live = useRef(null);
  live.current = { sound, slots, mapping, armed, pending };
  const knobs = useRef(new Map()); // cc → { pos, held, wrote }
  const heard = useRef(new Set()); // CCs heard from this visit
  const queue = useRef(new Map()); // cc → position, waiting for the batch
  const timer = useRef(0);
  const unlight = useRef(0);
  useEffect(() => () => {
    clearTimeout(timer.current);
    clearTimeout(unlight.current);
  }, []);

  // One batch per frame or so: a fast turn sends dozens of messages, and only
  // where each knob ended up matters. A timer, not an animation frame, so the
  // knobs keep working while the page is in a background tab.
  const flush = useCallback(() => {
    timer.current = 0;
    const L = live.current;
    let { slots: next, armed: arm, pending: want } = L;
    const updates = {};
    const lit = new Set();
    for (const [cc, pos] of queue.current) {
      let i = slotForCc(next, cc);
      if (L.mapping) {
        // in Map a turn names the knob and moves nothing
        if (i < 0) {
          i = arm ?? next.findIndex((s) => s.cc == null || !heard.current.has(s.cc));
          if (i >= 0) next = adoptCc(next, i, cc);
        }
        heard.current.add(cc);
        knobs.current.set(cc, { pos, held: false, wrote: null });
        if (i < 0) continue;
        arm = i;
        lit.add(i);
        if (want) {
          next = assignParam(next, i, want);
          want = null;
        }
        continue;
      }
      heard.current.add(cc);
      const k = i >= 0 ? next[i].param : null;
      const prev = knobs.current.get(cc) ?? { pos: null, held: false, wrote: null };
      if (!k) {
        knobs.current.set(cc, { ...prev, pos });
        continue;
      }
      lit.add(i);
      const now = updates[k] ?? L.sound[k];
      // it only still holds the level if the level is where it left it —
      // a preset, a mouse or a link moving it makes the knob let go
      const held = takeover({ pos: prev.pos, held: prev.held && prev.wrote === now }, pos, posOf(k, now));
      if (held) {
        const v = paramFromPos(k, Math.round(pos * 1000));
        updates[k] = v;
        knobs.current.set(cc, { pos, held: true, wrote: v });
      } else {
        knobs.current.set(cc, { pos, held: false, wrote: null });
      }
    }
    queue.current.clear();

    if (Object.keys(updates).length) {
      L.sound = { ...L.sound, ...updates };
      setSound((s) => ({ ...s, ...updates }));
    }
    if (next !== L.slots) setSlots(next);
    if (arm !== L.armed) setArmed(arm);
    if (want !== L.pending) setPending(want);
    setHeldBy(Object.fromEntries([...knobs.current].map(([cc, s]) => [cc, { pos: s.pos, held: s.held }])));
    if (lit.size) {
      setTouched(lit);
      clearTimeout(unlight.current);
      unlight.current = setTimeout(() => setTouched(new Set()), 180);
    }
  }, [setSound]);

  // `pos` is the controller's value as 0–1 (parseMidi's `value`)
  const onCC = useCallback(
    (cc, pos) => {
      queue.current.set(cc, pos);
      if (!timer.current) timer.current = setTimeout(flush, 16);
    },
    [flush]
  );

  // In Map, clicking a level puts the lit slot on it — or, with no slot lit,
  // waits for you to turn the knob you want on it
  const pickLevel = useCallback((k) => {
    const { armed: i } = live.current;
    if (i == null) return setPending(k);
    setSlots((s) => assignParam(s, i, k));
    setPending(null);
  }, []);

  // clicking a slot lights it, going into Map if need be
  const pickSlot = useCallback((i) => {
    const { pending: k } = live.current;
    setMapping(true);
    setArmed(i);
    if (k) {
      setSlots((s) => assignParam(s, i, k));
      setPending(null);
    }
  }, []);

  const clearSlot = useCallback(
    (i) => setSlots((s) => s.map((x, j) => (j === i ? { ...x, param: null } : x))),
    []
  );
  const reset = useCallback(() => setSlots(DEFAULT_KNOBS), []);
  const setMap = useCallback((on) => {
    setMapping(on);
    setArmed(null);
    setPending(null);
  }, []);

  // Escape leaves Map, from anywhere
  useEffect(() => {
    if (!mapping) return;
    const esc = (e) => {
      if (e.key === "Escape") setMap(false);
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [mapping, setMap]);

  // what a level shows about its knob: the tag (K3), whether that knob is
  // turning right now, where the knob is while it hasn't picked the level up,
  // and — in Map — whether it's the level the lit slot is on
  const levelFor = (k) => {
    const i = slotForParam(slots, k);
    if (i < 0) return { tag: null, touched: false, ghost: null, target: false };
    const cc = slots[i].cc;
    const knob = cc != null ? heldBy[cc] : null;
    return {
      tag: `K${i + 1}`,
      touched: touched.has(i),
      ghost: knob && !knob.held && knob.pos != null && !mapping ? knob.pos : null,
      target: mapping && armed === i,
    };
  };

  return {
    slots, mapping, armed, pending, heldBy, touched,
    onCC, pickLevel, pickSlot, clearSlot, reset, setMap, levelFor,
  };
}
