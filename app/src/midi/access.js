import { useState, useEffect, useCallback, useRef } from "react";

// ------------------------------------------------------------------------
//  MIDI ACCESS — shared by the explorer's Out and the synth's In
// ------------------------------------------------------------------------
// Web MIDI is Chrome 43+ / Firefox 108+ only — Safari has never shipped it on
// macOS or iOS, and every iOS browser is WebKit underneath — and it needs a
// secure context (localhost counts). Both are detected up front and reported
// in the UI, rather than leaving a control that silently does nothing.
//
// One access for the page, asked for once, whichever device asks first. What
// each side does with it once granted is its own business: Out lands on the
// first output (you didn't grant MIDI to keep hearing the built-in synth), but
// enabling MIDI *in* must not quietly reroute the explorer's output.
export const MIDI_SUPPORTED =
  typeof navigator !== "undefined" && typeof navigator.requestMIDIAccess === "function";

// what a MIDI control says before a port can be picked
export const MIDI_STATUS = {
  unsupported: {
    label: "No Web MIDI",
    dead: true,
    hint: "This browser has no Web MIDI. Safari has never shipped it, on macOS or iOS — Chrome or Firefox will work.",
  },
  insecure: {
    label: "No Web MIDI",
    dead: true,
    hint: "Web MIDI needs a secure context — serve the page over HTTPS, or from localhost.",
  },
  idle: { label: "Enable MIDI", dead: false, hint: "Look for connected MIDI instruments" },
  asking: { label: "Asking…", dead: true, hint: "Waiting on the browser's MIDI permission prompt" },
  denied: {
    label: "MIDI blocked",
    dead: false,
    hint: "The browser denied MIDI access. Allow it for this site, then click to retry.",
  },
};

export function useMidiAccess() {
  const [status, setStatus] = useState(() =>
    !MIDI_SUPPORTED ? "unsupported" : !window.isSecureContext ? "insecure" : "idle"
  );
  const [access, setAccess] = useState(null);
  const pending = useRef(null);

  // resolves to the MIDIAccess, or null if it was refused; a second caller
  // while the prompt is up shares the first one's answer
  const enable = useCallback(() => {
    if (!MIDI_SUPPORTED || !window.isSecureContext) return Promise.resolve(null);
    if (pending.current) return pending.current;
    setStatus("asking");
    // no sysex: notes don't need it, and asking for it prompts harder
    pending.current = navigator.requestMIDIAccess().then(
      (a) => {
        setAccess(a);
        setStatus("ready");
        return a;
      },
      () => {
        pending.current = null; // so a click can ask again
        setStatus("denied");
        return null;
      }
    );
    return pending.current;
  }, []);

  return { status, access, enable };
}

// The ports of one kind ("inputs" or "outputs"), kept current as devices are
// plugged in and pulled out. A listener rather than `onstatechange`, because
// both hooks watch the same access.
export function usePorts(access, kind) {
  const [ports, setPorts] = useState([]);
  useEffect(() => {
    if (!access) return;
    const read = () =>
      setPorts(
        [...access[kind].values()]
          .filter((p) => p.state !== "disconnected")
          .map((p) => ({ id: p.id, name: p.name }))
      );
    read();
    access.addEventListener("statechange", read);
    return () => access.removeEventListener("statechange", read);
  }, [access, kind]);
  return ports;
}
