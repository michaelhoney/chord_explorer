import { useState, useCallback } from "react";
import * as Tone from "tone";
import { usePorts } from "./access.js";

// ------------------------------------------------------------------------
//  MIDI OUT — the explorer's chords, to an external instrument
// ------------------------------------------------------------------------
// Takes the page's shared access (see useMidiAccess). Picking a port
// *replaces* the built-in synth rather than doubling it.
export function useMidiOut(midi) {
  const { status, access, enable } = midi;
  const outputs = usePorts(access, "outputs");
  const [portId, setPortId] = useState("");
  // 0–15 on the wire, 1–16 on the keys. Per visit and not in the URL, like the
  // port: which channel an instrument listens on is about your rig, not the
  // progression, and a shared link carrying one would be nonsense elsewhere.
  const [channel, setChannel] = useState(0);

  // Asking from the Out module means you want to hear MIDI: land on a real port
  // straight away. Only here, not on later statechanges — a device appearing
  // mid-session shouldn't reroute you without asking — and not when the synth's
  // In was what asked for access.
  const connect = useCallback(async () => {
    const a = await enable();
    const first = a && [...a.outputs.values()][0];
    if (first) setPortId(first.id);
  }, [enable]);

  const port = (portId && access?.outputs.get(portId)) || null;

  const send = useCallback(
    (events, at) => {
      if (!port) return;
      // Tone schedules on the audio clock; output.send wants a performance.now()
      // stamp, so rebase one onto the other. Both are ms-stable, which is all
      // chord playback needs.
      const t0 = performance.now() + (at - Tone.getContext().currentTime) * 1000;
      // the same events the built-in synth plays — so the arpeggio, Dynamics and
      // Humanise all travel out the port. The synth's sound is timbre, which
      // belongs to whatever instrument is on the other end.
      for (const e of events) {
        const vel = Math.max(1, Math.round(e.velocity * 127));
        port.send([0x90 | channel, e.midi, vel], t0 + e.at * 1000);
        port.send([0x80 | channel, e.midi, 0], t0 + (e.at + e.dur) * 1000);
      }
    },
    [port, channel]
  );

  // hardware holds a note until told otherwise, so Stop has to be emphatic
  const panic = useCallback(() => {
    if (!port) return;
    port.clear?.(); // drop note-offs still queued, or they arrive after the reset
    port.send([0xb0 | channel, 123, 0]); // all notes off
  }, [port, channel]);

  return { status, outputs, portId, setPortId, channel, setChannel, enable: connect, send, panic, active: !!port };
}
