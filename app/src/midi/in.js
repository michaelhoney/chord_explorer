import { useState, useEffect, useCallback, useRef } from "react";
import { usePorts } from "./access.js";
import { parseMidi } from "./messages.js";

// ------------------------------------------------------------------------
//  MIDI IN — a controller playing the synth
// ------------------------------------------------------------------------
// `source` is "off", "all" (every input — plug in an MPK Mini and it plays,
// whichever channel its keys and pads are on) or one port's id. Messages are
// parsed (see parseMidi) and handed to `onMessage`; what they do is the
// synth's business. Like the output port, not in the URL: it's about this
// machine's rig.
export function useMidiIn(midi, onMessage) {
  const { status, access, enable } = midi;
  const inputs = usePorts(access, "inputs");
  const [source, setSource] = useState("off");
  const handler = useRef(onMessage);
  useEffect(() => {
    handler.current = onMessage;
  });

  const listen = useCallback(
    async (v) => {
      if (v !== "off" && !access && !(await enable())) return;
      setSource(v);
    },
    [access, enable]
  );

  useEffect(() => {
    if (!access || source === "off") return;
    let attached = [];
    let ids = "";
    const deliver = (e) => {
      const m = parseMidi(e.data);
      if (m) handler.current(m);
    };
    // `onmidimessage` rather than a listener: setting it is what opens the port
    // in every browser that has Web MIDI
    const attach = () => {
      const now = [...access.inputs.values()].filter(
        (p) => p.state === "connected" && (source === "all" || p.id === source)
      );
      const next = now.map((p) => p.id).join();
      if (next === ids) return; // opening a port fires statechange too
      ids = next;
      attached.forEach((p) => (p.onmidimessage = null));
      now.forEach((p) => (p.onmidimessage = deliver));
      attached = now;
    };
    attach();
    // a controller plugged in mid-session joins in, if it's what we listen to
    access.addEventListener("statechange", attach);
    return () => {
      access.removeEventListener("statechange", attach);
      attached.forEach((p) => (p.onmidimessage = null));
      // whatever was held when we stopped listening would never get its note-off
      handler.current({ type: "alloff", channel: 0 });
    };
  }, [access, source]);

  return { status, inputs, source, listen };
}
