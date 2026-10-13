// ------------------------------------------------------------------------
//  LEGENDS — small line drawings in place of words, where a word would be
//  longer than the thing it names. Cryptic on purpose: every key that wears
//  one has a tooltip.
// ------------------------------------------------------------------------
// plain functions rather than components: these are drawn once, at import
const sym = (children, box = "0 0 22 12") => (
  <svg viewBox={box} aria-hidden="true" focusable="false"
       fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
    {children}
  </svg>
);
const dot = (x, y) => <circle cx={x} cy={y} r="1.4" fill="currentColor" stroke="none" />;

export const WAVE_SYM = {
  sine: sym(<><path d="M1 6C3.8-1.5 8.2-1.5 11 6S18.2 13.5 21 6" /></>),
  triangle: sym(<><path d="M1 10L6 2L11 10L16 2L21 10" /></>),
  sawtooth: sym(<><path d="M1 10L10 2V10L19 2V10" /></>),
  square: sym(<><path d="M1 10V2H6V10H11V2H16V10H21" /></>),
};

// a filter by its response: flat where it passes, a bump at the corner, a
// slope where it cuts
export const FILTER_SYM = {
  lowpass: sym(<><path d="M1 5H10C12.5 5 13 2.5 14.5 3.5C16 4.5 18 8.5 21 11" /></>),
  highpass: sym(<><path d="M1 11C4 8.5 6 4.5 7.5 3.5C9 2.5 9.5 5 12 5H21" /></>),
};

export const SYM = {
  // voicing: three stacked lines jumping between chords, or stepping smoothly
  rootPos: sym(<><path d="M1 10h5M1 6h5M1 2h5M16 11h5M16 7h5M16 3h5" /></>),
  voiceLed: sym(<><path d="M1 10h20M1 6h9l2 1h9M1 2h9l2 -1h9" /></>),
  // arpeggio: the chord's notes as dots in time — together, rising, scattered
  block: sym(<>{dot(11, 2)}{dot(11, 6)}{dot(11, 10)}</>),
  rise: sym(<>{dot(3, 10)}{dot(11, 6)}{dot(19, 2)}</>),
  random: sym(<>{dot(3, 6)}{dot(11, 10)}{dot(19, 2)}</>),
  // hold bass: an arpeggio over a line that doesn't stop
  hold: sym(<><path d="M1 11h20" />{dot(5, 6)}{dot(11, 3)}{dot(17, 6)}</>),
  suggest: sym(<><path d="M1 9h2l3-6h2l3 6" /></>, "0 0 12 12"),
  mutate: sym(<><path d="M2 3h5l-2-2M10 9H5l2 2" /></>, "0 0 12 12"),
  play: sym(<><path d="M3 1.5v11L12 7z" fill="currentColor" stroke="none" /></>, "0 0 14 14"),
  stop: sym(<><rect x="2.5" y="2.5" width="9" height="9" fill="currentColor" stroke="none" /></>, "0 0 14 14"),
  x: sym(<><path d="M3 3l8 8M11 3l-8 8" /></>, "0 0 14 14"),
  // octave shift: a step down, a step up
  down: sym(<><path d="M3 5l4 4 4-4" /></>, "0 0 14 14"),
  up: sym(<><path d="M3 9l4-4 4 4" /></>, "0 0 14 14"),
};
