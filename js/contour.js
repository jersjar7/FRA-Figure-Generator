// Fill a triangular mesh colored by a per-node scalar onto a 2D canvas context.
// Environment-agnostic (node-canvas or browser canvas). Triangles touching a dry
// node are skipped so only the wetted area is painted.

// Map projected coordinates (mx,my arrays, any linear units) to screen pixels,
// fitting [w×h] with `pad` px margin, equal aspect, Y flipped. Returns {sx,sy,fit}.
export function fitToScreen(mx, my, w, h, pad = 0) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < mx.length; i++) {
    if (mx[i] < x0) x0 = mx[i]; if (mx[i] > x1) x1 = mx[i];
    if (my[i] < y0) y0 = my[i]; if (my[i] > y1) y1 = my[i];
  }
  const s = Math.min((w - 2 * pad) / (x1 - x0), (h - 2 * pad) / (y1 - y0));
  const ox = (w - s * (x1 - x0)) / 2, oy = (h - s * (y1 - y0)) / 2;
  const n = mx.length, sx = new Float64Array(n), sy = new Float64Array(n);
  for (let i = 0; i < n; i++) { sx[i] = ox + s * (mx[i] - x0); sy[i] = h - (oy + s * (my[i] - y0)); }
  return { sx, sy, fit: { x0, x1, y0, y1, s, ox, oy, w, h } };
}

export function fillMesh(ctx, sx, sy, tris, values, colorFn) {
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t], b = tris[t + 1], c = tris[t + 2];
    const va = values[a], vb = values[b], vc = values[c];
    if (va <= -900 || vb <= -900 || vc <= -900) continue; // any dry vertex → skip
    const col = colorFn((va + vb + vc) / 3);
    if (!col) continue;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(sx[a], sy[a]); ctx.lineTo(sx[b], sy[b]); ctx.lineTo(sx[c], sy[c]);
    ctx.closePath();
    ctx.fill();
  }
}

// Count wetted (paintable) triangles — for tests / sanity.
export function wetTriangleCount(tris, values) {
  let n = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t], b = tris[t + 1], c = tris[t + 2];
    if (values[a] > -900 && values[b] > -900 && values[c] > -900) n++;
  }
  return n;
}

// Stroke the mesh triangulation (wireframe) for "Mesh elements" figures.
export function strokeMesh(ctx, sx, sy, tris, { color = "rgba(28,82,140,0.75)", width = 0.5 } = {}) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = "round";
  ctx.beginPath();
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t], b = tris[t + 1], c = tris[t + 2];
    ctx.moveTo(sx[a], sy[a]); ctx.lineTo(sx[b], sy[b]); ctx.lineTo(sx[c], sy[c]); ctx.closePath();
  }
  ctx.stroke();
  ctx.restore();
}
