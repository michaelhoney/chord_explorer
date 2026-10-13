import { describe, it, expect } from "vitest";
import { encodeState, decodeState, randomStart, DEFAULT_TEMPO } from "./state.js";
import { FEEL } from "./perform.js";

const base = {
  root: 7, mode: "major", add7: false, voiceLead: true, bass: false,
  arp: false, arpFour: false, arpOrder: "rise", holdBass: false,
  loop: true, evolve: false, evolveEvery: 1, mutLevel: 1, susOn: false,
  tempo: DEFAULT_TEMPO, feel: { dynamics: FEEL.dynamics.default, humanise: FEEL.humanise.default },
  prog: [],
};

describe("the explorer's link", () => {
  it("opens a naked URL as nothing, so the page can roll a random start", () => {
    expect(decodeState("")).toBe(null);
    const r = randomStart();
    expect(r.prog).toHaveLength(4);
    expect(["major", "minor"]).toContain(r.mode);
  });

  it("leaves default feel out of the link", () => {
    expect(encodeState(base)).toBe("k=7");
  });

  it("round-trips Dynamics and Humanise", () => {
    const qs = encodeState({ ...base, feel: { dynamics: 0.2, humanise: 0.9 } });
    expect(qs).toContain("dy=0.2");
    expect(qs).toContain("hu=0.9");
    expect(decodeState(`?${qs}`).feel).toEqual({ dynamics: 0.2, humanise: 0.9 });
  });

  it("falls back to the default feel for a link with none", () => {
    expect(decodeState("?k=7").feel).toEqual({ dynamics: 0.5, humanise: 0.35 });
  });

  it("takes an old link's feel from the synth patch it used to live in", () => {
    // what retiredFromSynth hands over from an old `sy=`
    expect(decodeState("?k=7", { dynamics: 0.7, humanise: 0.45 }).feel).toEqual({ dynamics: 0.7, humanise: 0.45 });
    expect(decodeState("?k=7", { dynamics: 0 }).feel).toEqual({ dynamics: 0, humanise: 0.35 });
  });

  it("lets a link's own feel win over anything inherited", () => {
    expect(decodeState("?k=7&dy=0.1", { dynamics: 0.7 }).feel.dynamics).toBe(0.1);
  });

  it("clamps junk feel back into range", () => {
    const f = decodeState("?k=7&dy=4&hu=banana").feel;
    expect(f.dynamics).toBe(1);
    expect(f.humanise).toBe(0.35);
  });

  it("round-trips a progression through the key's chord pool", () => {
    const s = decodeState("?k=7&p=7.0-4-7_4.0-3-7_0.0-4-7~1");
    expect(s.prog.map((c) => c.name)).toEqual(["G", "Em", "C"]);
    expect(s.prog[2].inv).toBe(1);
    expect(encodeState({ ...base, prog: s.prog })).toBe("k=7&p=7.0-4-7_4.0-3-7_0.0-4-7%7E1");
  });
});
