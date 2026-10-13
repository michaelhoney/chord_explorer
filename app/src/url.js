import { useLayoutEffect } from "react";

// ------------------------------------------------------------------------
//  THE ADDRESS BAR — shared by both devices
// ------------------------------------------------------------------------
// Each device owns a slice of the query string — the explorer its key and
// progression, the synth its patch — and the address bar is their sum, so
// any of it is bookmarkable and shareable and neither device has to know the
// other's parameters.
//
// Written behind a short debounce, never per change: a level drag changes
// state every frame, and Safari allows 100 replaceState calls per 10 seconds
// and then *throws* — from inside an effect, which unmounts the whole app to
// a white page. (Chrome throttles instead, with a warning.) Trailing edge, so
// the bar lands where the drag stopped; flushed on pagehide so a reload
// straight after a change keeps it. And guarded regardless: the address bar
// falling behind is cosmetic, and must never take the app down.
const slices = new Map();
let timer = 0;

// Where the page is, now — what Share copies. Read at the moment of the
// click, so a share never lags the page however recently something changed.
export function currentPath() {
  const qs = [...slices.values()].filter(Boolean).join("&");
  return qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
}

function write() {
  clearTimeout(timer);
  try {
    window.history.replaceState(null, "", currentPath());
  } catch {
    // leave the address bar where it was; the next write will catch it up
  }
}

if (typeof window !== "undefined") window.addEventListener("pagehide", write);

// `qs` is the device's own part of the query string, already encoded; an
// empty string means it has nothing worth saying. A layout effect, so a
// click handler reading currentPath() never sees the slice from a render ago.
export function useUrlSlice(name, qs) {
  useLayoutEffect(() => {
    slices.set(name, qs);
    clearTimeout(timer);
    timer = setTimeout(write, 300);
  }, [name, qs]);
}
