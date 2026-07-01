// Reproject mesh node coordinates (custom WA State Plane "ground" feet, from the
// mesh WKT) to lon/lat (WGS84) and Web Mercator meters, for overlaying tiles.
import proj4 from "proj4";

// xy: Float64[2N] of projected feet. Returns {lon,lat} Float64[N] each.
export function toLonLat(xy, wkt) {
  const toLL = proj4(wkt, "WGS84");
  const n = xy.length / 2;
  const lon = new Float64Array(n), lat = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = toLL.forward([xy[i * 2], xy[i * 2 + 1]]);
    lon[i] = r[0]; lat[i] = r[1];
  }
  return { lon, lat };
}

const R = 6378137; // Web Mercator sphere radius (m)
export function lonLatToMerc(lon, lat) {
  const n = lon.length;
  const mx = new Float64Array(n), my = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    mx[i] = (lon[i] * Math.PI / 180) * R;
    my[i] = Math.log(Math.tan(Math.PI / 4 + (lat[i] * Math.PI / 180) / 2)) * R;
  }
  return { mx, my };
}

// bounds helper for an array
export function bounds(a) {
  let lo = Infinity, hi = -Infinity;
  for (const v of a) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return [lo, hi];
}
