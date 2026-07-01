// Draw uploaded shapefile overlays (centerline, stationing, boundaries, …) on
// the figure. shpjs returns GeoJSON already reprojected to WGS84 lon/lat, so we
// just go lon/lat → Web Mercator → view-local, the same path as the mesh. Drawn
// inside the rotated/zoomed/panned context, so overlays track the map.

const R = 6378137;
function toMerc(lon, lat) {
  return [lon * Math.PI / 180 * R, Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 180 / 2)) * R];
}
function project(view, lon, lat) {
  const [mx, my] = toMerc(lon, lat);
  return view.toLocal(mx, my);
}

export const OVERLAY_PALETTE = ["#e8112d", "#ffd400", "#00a3e0", "#8e44ad", "#ff7f0e", "#1abc9c"];

// overlays: [{ geojson, color, width, hidden }]. Call inside the rotated ctx.
export function drawOverlays(ctx, overlays, view) {
  for (const ov of overlays) {
    if (ov.hidden) continue;
    ctx.save();
    ctx.strokeStyle = ov.color;
    ctx.fillStyle = ov.color;
    ctx.lineWidth = ov.width;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const f of ov.geojson.features || []) if (f.geometry) drawGeom(ctx, f.geometry, view, ov);
    ctx.restore();
  }
}

function drawGeom(ctx, geom, view, ov) {
  const c = geom.coordinates;
  switch (geom.type) {
    case "Point": marker(ctx, project(view, c[0], c[1]), ov.width); break;
    case "MultiPoint": for (const p of c) marker(ctx, project(view, p[0], p[1]), ov.width); break;
    case "LineString": stroke(ctx, c, view, false); break;
    case "MultiLineString": for (const l of c) stroke(ctx, l, view, false); break;
    case "Polygon": for (const r of c) stroke(ctx, r, view, true); break;
    case "MultiPolygon": for (const poly of c) for (const r of poly) stroke(ctx, r, view, true); break;
  }
}

function stroke(ctx, coords, view, close) {
  ctx.beginPath();
  for (let i = 0; i < coords.length; i++) {
    const [x, y] = project(view, coords[i][0], coords[i][1]);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  if (close) ctx.closePath();
  ctx.stroke();
}

function marker(ctx, [x, y], w) {
  ctx.beginPath();
  ctx.arc(x, y, Math.max(2.5, w * 1.4), 0, Math.PI * 2);
  ctx.fill();
}

// ---- labels (drawn UPRIGHT in screen space, after the rotated layer) ----

// local (rotated-layer) coords → final screen pixel
function localToScreen(view, lx, ly) {
  const c = Math.cos(view.rotRad), s = Math.sin(view.rotRad);
  return [view.originX + lx * c - ly * s, view.originY + lx * s + ly * c];
}
function lonLatToScreen(view, lon, lat) {
  const [mx, my] = toMerc(lon, lat);
  const [lx, ly] = view.toLocal(mx, my);
  return localToScreen(view, lx, ly);
}
const mid = (a) => a[Math.floor(a.length / 2)];
function centroid(ring) {
  let x = 0, y = 0;
  for (const p of ring) { x += p[0]; y += p[1]; }
  return [x / ring.length, y / ring.length];
}
function labelAnchors(geom) {
  switch (geom.type) {
    case "Point": return [geom.coordinates];
    case "MultiPoint": return geom.coordinates;
    case "LineString": return [mid(geom.coordinates)];
    case "MultiLineString": return geom.coordinates.map(mid);
    case "Polygon": return [centroid(geom.coordinates[0])];
    case "MultiPolygon": return geom.coordinates.map((poly) => centroid(poly[0]));
    default: return [];
  }
}

const MAX_LABELS = 600; // guard against labeling a huge point set

export function drawOverlayLabels(ctx, overlays, view) {
  for (const ov of overlays) {
    if (ov.hidden || !ov.labelField) continue;
    const fs = ov.labelSize || 22;
    ctx.save();
    ctx.font = `${fs}px Arial, sans-serif`;
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.lineWidth = Math.max(3, fs * 0.2); ctx.strokeStyle = "rgba(255,255,255,0.92)";
    ctx.fillStyle = "#111";
    let drawn = 0;
    for (const f of ov.geojson.features || []) {
      if (drawn >= MAX_LABELS) break;
      if (!f.geometry || !f.properties) continue;
      const txt = f.properties[ov.labelField];
      if (txt == null || txt === "") continue;
      for (const [lon, lat] of labelAnchors(f.geometry)) {
        const [sx, sy] = lonLatToScreen(view, lon, lat);
        ctx.strokeText(String(txt), sx + fs * 0.45, sy);
        ctx.fillText(String(txt), sx + fs * 0.45, sy);
        if (++drawn >= MAX_LABELS) break;
      }
    }
    ctx.restore();
  }
}

// Attribute field names available for labeling (sampled from the features).
export function propKeys(geojson) {
  const keys = new Set();
  for (const f of (geojson.features || []).slice(0, 50)) if (f.properties) Object.keys(f.properties).forEach((k) => keys.add(k));
  return [...keys];
}

// A short human description of what's in a parsed shapefile (for the UI list).
export function describe(geojson) {
  const kinds = new Set((geojson.features || []).map((f) => f.geometry && f.geometry.type).filter(Boolean));
  const n = (geojson.features || []).length;
  const kind = [...kinds].map((k) => k.replace("Multi", "").toLowerCase()).join("/") || "feature";
  return `${n} ${kind}${n === 1 ? "" : "s"}`;
}
