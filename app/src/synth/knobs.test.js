import { describe, it, expect } from "vitest";
import {
  DEFAULT_KNOBS,
  KNOB_COUNT,
  assignParam,
  adoptCc,
  slotForCc,
  slotForParam,
  takeover,
  parseKnobs,
} from "./knobs.js";
import { SYNTH_PARAMS } from "./params.js";

// the levels, not the keys: a knob has no sensible way to pick a waveform
const mappable = (k) => !!SYNTH_PARAMS[k] && SYNTH_PARAMS[k].kind !== "enum";

describe("the default knobs", () => {
  it("map eight knobs to eight different levels", () => {
    expect(DEFAULT_KNOBS).toHaveLength(8);
    expect(KNOB_COUNT).toBe(8);
    expect(new Set(DEFAULT_KNOBS.map((s) => s.cc)).size).toBe(8);
    expect(new Set(DEFAULT_KNOBS.map((s) => s.param)).size).toBe(8);
    for (const s of DEFAULT_KNOBS) expect(mappable(s.param), s.param).toBe(true);
  });

  it("answer to an MPK Mini's knobs out of the box, CC 70–77", () => {
    expect(DEFAULT_KNOBS.map((s) => s.cc)).toEqual([70, 71, 72, 73, 74, 75, 76, 77]);
    expect(DEFAULT_KNOBS[0].param).toBe("cutoff");
  });
});

describe("remapping", () => {
  it("moves a level from one knob to another rather than sharing it", () => {
    const s = assignParam(DEFAULT_KNOBS, 7, "cutoff");
    expect(s[7].param).toBe("cutoff");
    expect(s[0].param).toBe(null);
    expect(slotForParam(s, "cutoff")).toBe(7);
  });

  it("moves a knob from one slot to another rather than sharing it", () => {
    const s = adoptCc(DEFAULT_KNOBS, 2, 70);
    expect(s[2].cc).toBe(70);
    expect(s[0].cc).toBe(null);
    expect(slotForCc(s, 70)).toBe(2);
    // the slot keeps the level it was on
    expect(s[2].param).toBe("filterEnv");
  });

  it("leaves the slots it was given alone", () => {
    const before = JSON.stringify(DEFAULT_KNOBS);
    assignParam(DEFAULT_KNOBS, 3, "chorus");
    adoptCc(DEFAULT_KNOBS, 3, 21);
    expect(JSON.stringify(DEFAULT_KNOBS)).toBe(before);
  });
});

describe("pickup", () => {
  const fresh = { pos: null, held: false };

  it("won't move a level the knob disagrees with", () => {
    expect(takeover(fresh, 0.9, 0.3)).toBe(false);
  });

  it("picks the level up once the knob reaches it", () => {
    expect(takeover({ pos: 0.5, held: false }, 0.301, 0.3)).toBe(true);
  });

  it("picks it up when a fast turn passes straight over it", () => {
    expect(takeover({ pos: 0.2, held: false }, 0.45, 0.3)).toBe(true);
    expect(takeover({ pos: 0.6, held: false }, 0.1, 0.3)).toBe(true);
  });

  it("doesn't count turning towards it as passing it", () => {
    expect(takeover({ pos: 0.9, held: false }, 0.6, 0.3)).toBe(false);
  });

  it("keeps hold once it has the level", () => {
    expect(takeover({ pos: 0.3, held: true }, 0.95, 0.3)).toBe(true);
  });
});

describe("storing the knobs", () => {
  it("round-trips through JSON", () => {
    const s = assignParam(adoptCc(DEFAULT_KNOBS, 0, 21), 1, "chorus");
    expect(parseKnobs(JSON.stringify(s), mappable)).toEqual(s);
  });

  it("gives up on anything that isn't eight slots", () => {
    expect(parseKnobs("not json", mappable)).toBe(null);
    expect(parseKnobs("{}", mappable)).toBe(null);
    expect(parseKnobs(JSON.stringify(DEFAULT_KNOBS.slice(0, 7)), mappable)).toBe(null);
    expect(parseKnobs(null, mappable)).toBe(null);
  });

  it("drops a bad slot's knob or level, not the whole lot", () => {
    const raw = DEFAULT_KNOBS.map((s) => ({ ...s }));
    raw[0] = { cc: 300, param: "cutoff" };
    raw[1] = { cc: 71, param: "wave" }; // a key, not a level
    raw[2] = { cc: 72, param: "kazoo" };
    const s = parseKnobs(raw, mappable);
    expect(s[0]).toEqual({ cc: null, param: "cutoff" });
    expect(s[1]).toEqual({ cc: 71, param: null });
    expect(s[2]).toEqual({ cc: 72, param: null });
    expect(s[3]).toEqual(DEFAULT_KNOBS[3]);
  });

  it("won't let two slots share a knob or a level", () => {
    const raw = DEFAULT_KNOBS.map((s) => ({ ...s }));
    raw[5] = { cc: 70, param: "cutoff" };
    const s = parseKnobs(raw, mappable);
    expect(s[0]).toEqual(DEFAULT_KNOBS[0]);
    expect(s[5]).toEqual({ cc: null, param: null });
  });
});
