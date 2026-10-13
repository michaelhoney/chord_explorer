import { hueOf } from "./harmony.js";

// Kept, not dead: the tension curve is out of the progression view for now but
// the concept it draws — distance from home over time — is the thing the whole
// explorer is about, and it will come back. Nothing imports it yet. It's the one
// thing on the face still painted in the function hues.
const HUE = {
  home: "var(--home)",
  build: "var(--build)",
  tension: "var(--tension)",
  outside: "var(--outside)",
};

export default function TensionCurve({ prog, playingIdx }) {
  const W = 100, H = 34, pad = 4;
  const max = 4.5;
  const n = prog.length;
  const x = (i) => (n === 1 ? W / 2 : pad + (i * (W - pad * 2)) / (n - 1));
  const y = (t) => H - pad - (Math.min(t, max) / max) * (H - pad * 2);
  const pts = prog.map((c, i) => `${x(i)},${y(c.tension)}`).join(" ");
  return (
    <svg className="ce-curve" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" y1={H - pad} x2={W} y2={H - pad} className="ce-curve-base" />
      {n > 1 && <polyline points={pts} className="ce-curve-line" />}
      {prog.map((c, i) => (
        <circle
          key={c.id}
          cx={x(i)}
          cy={y(c.tension)}
          r={i === playingIdx ? 2.4 : 1.6}
          style={{ fill: HUE[hueOf(c.func)] }}
        />
      ))}
    </svg>
  );
}
