// The piano roll's fixed geometry, in px: per semitone, pill, column, gap
// between columns, and the gap above the bass lane. Fixed so the connector
// SVG and the flex columns share one coordinate system — and so a drag can
// find the column under the pointer with arithmetic rather than measurement.
export const ROLL = { ROW: 13, CELL: 26, COL: 128, GAP: 44, LANE: 36 };
