// SMS / FHWA color ramps, sampled directly from the SMS ramp picker image so they
// match what reviewers see. Each ramp is a list of [position 0..1, [r,g,b]] stops.

export const RAMPS = {
  topography: [[0, [56,144,137]], [0.125, [155,185,122]], [0.25, [181,196,126]], [0.375, [244,232,158]], [0.5, [242,215,144]], [0.625, [225,184,133]], [0.75, [196,143,126]], [0.875, [229,200,200]], [1, [255,252,255]]],
  depth: [[0, [194,217,238]], [0.125, [157,198,227]], [0.25, [120,180,217]], [0.375, [87,158,205]], [0.5, [57,133,192]], [0.625, [31,109,176]], [0.75, [23,89,154]], [0.875, [16,69,131]], [1, [8,49,108]]],
  velocity: [[0, [0,63,158]], [0.125, [0,38,255]], [0.25, [0,172,251]], [0.375, [0,242,181]], [0.5, [0,255,56]], [0.625, [122,255,0]], [0.75, [223,201,0]], [0.875, [255,113,0]], [1, [255,7,0]]],
  shear: [[0, [139,247,255]], [0.125, [112,175,255]], [0.25, [86,103,255]], [0.375, [100,62,241]], [0.5, [136,41,220]], [0.625, [172,19,198]], [0.75, [200,10,163]], [0.875, [225,5,124]], [1, [251,0,84]]],
  waterSurface: [[0, [87,65,227]], [0.125, [85,142,224]], [0.25, [86,215,217]], [0.375, [146,214,136]], [0.5, [206,214,56]], [0.625, [212,175,43]], [0.75, [219,136,31]], [0.875, [197,92,57]], [1, [173,46,85]]],
  froude: [[0, [179,205,227]], [0.125, [170,178,213]], [0.25, [158,139,194]], [0.375, [146,100,174]], [0.5, [179,0,0]], [0.625, [202,36,24]], [0.75, [225,72,49]], [0.875, [239,134,91]], [1, [252,199,134]]],
  dvProduct: [[0, [237,240,134]], [0.125, [130,165,113]], [0.25, [85,149,178]], [0.375, [143,149,159]], [0.5, [241,156,108]], [0.625, [242,138,115]], [0.75, [227,117,132]], [0.875, [212,97,148]], [1, [197,75,165]]],
  surcharge: [[0, [6,255,243]], [0.125, [73,255,123]], [0.25, [42,241,42]], [0.375, [0,208,0]], [0.5, [0,151,0]], [0.625, [0,119,0]], [0.75, [0,87,0]], [0.875, [50,51,0]], [1, [241,3,0]]],
};

// Dropdown options (key → label), in the SMS picker order.
export const RAMP_OPTIONS = [
  ["topography", "Topography"], ["depth", "Depth"], ["velocity", "Velocity"], ["shear", "Shear"],
  ["waterSurface", "Water Surface"], ["froude", "Froude"], ["dvProduct", "DV Product"], ["surcharge", "Surcharge"],
];

// Map a SMS parameter dataset name → display config (each gets its SMS-default
// ramp). Ranges always auto-scale to the data as it comes from SMS.
const PARAM_DEFS = [
  { match: /B_?Stress/i,  key: "shear",    label: "Shear",          units: "lb/ft²",  ramp: "shear" },
  { match: /Vel_?Mag/i,   key: "velocity", label: "Velocity",       units: "ft/s",    ramp: "velocity" },
  { match: /Water_?Depth/i, key: "depth",  label: "Water Depth",    units: "ft",      ramp: "depth" },
  { match: /Water_?Elev/i, key: "wse",     label: "Water Surface",  units: "ft",      ramp: "waterSurface" },
  { match: /Froude/i,     key: "froude",   label: "Froude",         units: "",        ramp: "froude" },
];

export function paramDef(datasetName) {
  return PARAM_DEFS.find((d) => d.match.test(datasetName)) ||
    { key: "scalar", label: datasetName, units: "", ramp: "velocity" };
}

// Interpolate a ramp at t∈[0,1] → [r,g,b].
export function rampColor(stops, t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [p0, c0] = stops[i - 1], [p1, c1] = stops[i];
      const f = p1 === p0 ? 0 : (t - p0) / (p1 - p0);
      return [0, 1, 2].map((k) => Math.round(c0[k] + f * (c1[k] - c0[k])));
    }
  }
  return stops[stops.length - 1][1];
}

// Build a color function for a parameter: value → "rgb(...)" or null when dry/outside.
// `range` overrides the default; `interval` snaps to discrete bands (blocky look).
export function makeColorFn(datasetName, { min, max, interval, ramp } = {}) {
  const def = paramDef(datasetName);
  const stops = RAMPS[ramp] || RAMPS[def.ramp];
  const lo = min ?? (def.range ? def.range[0] : 0);
  const hi = max ?? (def.range ? def.range[1] : 1);
  const step = interval ?? def.interval;
  return (v) => {
    if (v == null || !isFinite(v) || v <= -900) return null; // dry / no-data
    let x = v;
    if (step) x = Math.floor(v / step) * step + step / 2; // snap to band center
    const t = (x - lo) / (hi - lo || 1);
    const [r, g, b] = rampColor(stops, t);
    return `rgb(${r},${g},${b})`;
  };
}

// Legend swatches for a parameter (band ranges + colors).
export function legendBands(datasetName, { min, max, interval, ramp } = {}) {
  const def = paramDef(datasetName);
  const stops = RAMPS[ramp] || RAMPS[def.ramp];
  const lo = min ?? (def.range ? def.range[0] : 0);
  const hi = max ?? (def.range ? def.range[1] : 1);
  const step = interval ?? def.interval ?? (hi - lo) / 8;
  const out = [];
  for (let v = lo; v < hi - 1e-9; v += step) {
    const t = (v + step / 2 - lo) / (hi - lo || 1);
    out.push({ from: v, to: v + step, color: `rgb(${rampColor(stops, t).join(",")})` });
  }
  return { bands: out, lo, hi, label: def.label, units: def.units };
}
