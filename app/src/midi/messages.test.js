import { describe, it, expect } from "vitest";
import { parseMidi, noteName, describeMidi, BEND_SEMITONES } from "./messages.js";

describe("reading a controller", () => {
  it("reads a key going down, on any channel", () => {
    expect(parseMidi([0x90, 60, 127])).toEqual({ type: "noteon", channel: 0, note: 60, velocity: 1 });
    // an MPK Mini's pads default to channel 10
    expect(parseMidi([0x99, 36, 64])).toMatchObject({ type: "noteon", channel: 9, note: 36 });
  });

  it("reads a key coming up, either way it's sent", () => {
    expect(parseMidi([0x80, 60, 40])).toEqual({ type: "noteoff", channel: 0, note: 60 });
    // note-on at velocity zero is a note-off
    expect(parseMidi([0x90, 60, 0])).toEqual({ type: "noteoff", channel: 0, note: 60 });
  });

  it("reads the sustain pedal as down or up", () => {
    expect(parseMidi([0xb0, 64, 127])).toMatchObject({ type: "pedal", down: true });
    expect(parseMidi([0xb0, 64, 0])).toMatchObject({ type: "pedal", down: false });
  });

  it("centres pitch bend on zero", () => {
    expect(parseMidi([0xe0, 0x00, 0x40]).amount).toBe(0); // 8192
    expect(parseMidi([0xe0, 0x00, 0x00]).amount).toBe(-1);
    expect(parseMidi([0xe0, 0x7f, 0x7f]).amount).toBeCloseTo(1, 3);
  });

  it("hears all-notes-off and all-sound-off as the same thing", () => {
    expect(parseMidi([0xb0, 123, 0]).type).toBe("alloff");
    expect(parseMidi([0xb0, 120, 0]).type).toBe("alloff");
  });

  it("passes other controllers through as a value from 0 to 1", () => {
    expect(parseMidi([0xb3, 70, 127])).toEqual({ type: "cc", channel: 3, cc: 70, value: 1 });
  });

  it("ignores what a synth doesn't play from", () => {
    expect(parseMidi([0xf8])).toBe(null); // clock
    expect(parseMidi([0xd0, 40])).toBe(null); // channel pressure
    expect(parseMidi([])).toBe(null);
  });
});

describe("naming what arrived", () => {
  it("names notes with middle C as C4", () => {
    expect(noteName(60)).toBe("C4");
    expect(noteName(61)).toBe("C♯4");
    expect(noteName(21)).toBe("A0");
  });

  it("describes each message in a line", () => {
    expect(describeMidi(parseMidi([0x90, 64, 100]))).toBe("E4 · 100");
    expect(describeMidi(parseMidi([0xb0, 64, 127]))).toBe("pedal down");
    expect(describeMidi(parseMidi([0xe0, 0x7f, 0x7f]))).toBe(`bend +${BEND_SEMITONES.toFixed(2)}`);
    expect(describeMidi(parseMidi([0xb0, 74, 0]))).toBe("CC 74 · 0");
  });
});
