// ------------------------------------------------------------------------
//  FUTURES — finding your way round the list of next chords
// ------------------------------------------------------------------------

// stable identity for an option row (roman alone collides: minor has V and V7)
export const optKey = (o) => `${o.roman}:${o.rootPc}:${o.intervals.join("-")}`;

// Fold the display spellings down to what someone would actually type: "bvii"
// finds ♭VII, "bdim" finds B°, "f#" finds F♯. Matching runs over the chord name
// and the roman, which is how you'd name the chord you're hunting for.
export const normQuery = (s) =>
  s
    .toLowerCase()
    .replace(/[♭b]/g, "b")
    .replace(/[♯#]/g, "#")
    .replace(/°/g, "dim")
    .replace(/\s+/g, "");

export const matchesQuery = (o, q) =>
  normQuery(o.name).includes(q) || normQuery(o.roman).includes(q);
