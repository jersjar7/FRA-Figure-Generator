// Esri / USGS XYZ imagery basemap, drawn into the rotated, full-bleed view so it
// aligns with the contours. Browser-only (fetches tiles). Fails gracefully — if
// a tile can't load the figure still renders without the aerial.

const R = 6378137, C = 2 * Math.PI * R;
export const ESRI_WORLD_IMAGERY =
  "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
export const USGS_IMAGERY =
  "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}";

const mercToGlobal = (mx, my, worldPx) => [
  (mx + Math.PI * R) / C * worldPx,
  (Math.PI * R - my) / C * worldPx,
];
const globalToMerc = (gx, gy, worldPx) => [
  gx / worldPx * C - Math.PI * R,
  Math.PI * R - gy / worldPx * C,
];

// Draws the aerial covering the whole (rotated) frame. The caller does NOT need
// to set up the rotation — this manages its own save/translate/rotate.
export async function drawBasemap(ctx, view, { url = ESRI_WORLD_IMAGERY } = {}) {
  // cap zoom at 19 — Esri/USGS imagery thins out past that in rural areas and
  // serves gray "no data" placeholders; capped tiles upscale but always cover.
  const z = Math.max(2, Math.min(19, Math.round(Math.log2(view.scale * C / 256))));
  const worldPx = 256 * 2 ** z;
  const bb = view.coverBbox();
  const [gx0, gy1] = mercToGlobal(bb.x0, bb.y0, worldPx); // sw → (small gx, large gy)
  const [gx1, gy0] = mercToGlobal(bb.x1, bb.y1, worldPx); // ne → (large gx, small gy)
  const tx0 = Math.floor(gx0 / 256), tx1 = Math.floor(gx1 / 256);
  const ty0 = Math.floor(gy0 / 256), ty1 = Math.floor(gy1 / 256);
  // guardrail against pathological tile counts
  if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > 400) return;

  ctx.save();
  ctx.translate(view.originX, view.originY);
  ctx.rotate(view.rotRad);
  const jobs = [];
  for (let tx = tx0; tx <= tx1; tx++)
    for (let ty = ty0; ty <= ty1; ty++)
      jobs.push(drawTile(ctx, url, z, tx, ty, worldPx, view));
  await Promise.all(jobs);
  ctx.restore();
}

async function drawTile(ctx, url, z, tx, ty, worldPx, view) {
  try {
    const u = url.replace("{z}", z).replace("{x}", tx).replace("{y}", ty);
    const res = await fetch(u, { mode: "cors" });
    if (!res.ok) return;
    const bmp = await createImageBitmap(await res.blob());
    const [mx0, my1] = globalToMerc(tx * 256, ty * 256, worldPx);       // tile NW corner
    const [mx1, my0] = globalToMerc((tx + 1) * 256, (ty + 1) * 256, worldPx); // tile SE corner
    const [lx, ly] = view.toLocal(mx0, my1);
    const lw = view.scale * (mx1 - mx0), lh = view.scale * (my1 - my0);
    ctx.drawImage(bmp, lx, ly, lw, lh);
    bmp.close?.();
  } catch { /* offline / blocked — skip */ }
}
