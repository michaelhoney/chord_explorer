/* ------------------------------------------------------------------ *
 *  MIDI MESSAGES — bytes in, meaning out
 *
 *  Pure and import-free. A controller like an AKAI MPK Mini sends a
 *  stream of three-byte messages; this reads the ones a synth plays
 *  from, and ignores the rest (clock, sysex, aftertouch). Every channel
 *  is accepted — the MPK's keys and pads default to different ones, and
 *  both should play.
 * ------------------------------------------------------------------ */

// Pitch bend's reach, either way. Two semitones is the General MIDI default,
// and what a controller's bend wheel or joystick expects to mean.
export const BEND_SEMITONES = 2;

export function parseMidi(data) {
  const [status = 0, d1 = 0, d2 = 0] = data;
  const type = status & 0xf0;
  const channel = status & 0x0f;
  // a note-on at velocity 0 is a note-off — running status sends them that way
  if (type === 0x90 && d2 > 0) return { type: "noteon", channel, note: d1, velocity: d2 / 127 };
  if (type === 0x80 || type === 0x90) return { type: "noteoff", channel, note: d1 };
  if (type === 0xb0) {
    if (d1 === 64) return { type: "pedal", channel, down: d2 >= 64 };
    // all sound off, all notes off
    if (d1 === 120 || d1 === 123) return { type: "alloff", channel };
    return { type: "cc", channel, cc: d1, value: d2 / 127 };
  }
  // 14 bits, centred on 8192: −1 to just under +1
  if (type === 0xe0) return { type: "bend", channel, amount: (((d2 << 7) | d1) - 8192) / 8192 };
  return null;
}

// a note number as a player reads it: 60 is C4
const NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
export const noteName = (m) => `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;

// a one-line readout of what just arrived, for the In module
export function describeMidi(msg) {
  if (!msg) return "";
  switch (msg.type) {
    case "noteon":
      return `${noteName(msg.note)} · ${Math.round(msg.velocity * 127)}`;
    case "noteoff":
      return `${noteName(msg.note)} off`;
    case "pedal":
      return `pedal ${msg.down ? "down" : "up"}`;
    case "bend":
      return `bend ${msg.amount >= 0 ? "+" : "−"}${Math.abs(msg.amount * BEND_SEMITONES).toFixed(2)}`;
    case "alloff":
      return "all notes off";
    default:
      return `CC ${msg.cc} · ${Math.round(msg.value * 127)}`;
  }
}
