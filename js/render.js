// Figure overlays: title, legend, north arrow, scale bar. Each is upright and
// placeable via an 8-way anchor + X/Y nudge, with a subtle panel so it reads
// over imagery. Environment-agnostic (browser or node canvas).

const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v % 1) < 1e-9 ? v.toFixed(0) : v.toFixed(1));

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Top-left of a w×h box, anchored in the frame (8 positions) + nudge.
export function anchorBox(anchor, w, h, frameW, frameH, M, offX = 0, offY = 0) {
  const ax = { l: M, c: (frameW - w) / 2, r: frameW - w - M };
  const ay = { t: M, m: (frameH - h) / 2, b: frameH - h - M };
  let x, y;
  if (anchor === "ml") { x = M; y = ay.m; }
  else if (anchor === "mr") { x = ax.r; y = ay.m; }
  else { x = ax[anchor[1]]; y = ay[anchor[0]]; }
  return [x + offX, y + offY];
}
const M = 18;

export function drawTitle(ctx, text, o) {
  const { frameW, frameH, anchor = "tc", offX = 0, offY = 0, fontSize = 24 } = o;
  ctx.save();
  ctx.font = `bold ${fontSize}px Arial, sans-serif`;
  const tw = ctx.measureText(text).width;
  const w = tw + 28, h = fontSize + 18;
  const [x, y] = anchorBox(anchor, w, h, frameW, frameH, M, offX, offY);
  ctx.fillStyle = "rgba(255,255,255,0.8)"; ctx.strokeStyle = "rgba(0,0,0,0.2)";
  roundRect(ctx, x, y, w, h, 8); ctx.fill(); ctx.stroke();
  ctx.fillStyle = "#111"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(text, x + w / 2, y + h / 2);
  ctx.restore();
}

// Colorbar legend: continuous stacked bar (lowest at bottom), one number per
// boundary. `legend` = {bands:[{color}], lo, hi, label, units}.
export function drawLegend(ctx, legend, o) {
  const { frameW, frameH, anchor = "tl", offX = 0, offY = 0, fontSize = 20 } = o;
  const n = legend.bands.length;
  const sw = Math.round(fontSize * 1.9);
  const blockH = Math.max(fontSize + 6, 20);
  const barH = n * blockH, titleH = fontSize + 14, pad = 12, gap = 8;

  const labels = [];
  for (let i = 0; i <= n; i++) labels.push(fmt(legend.lo + (i * (legend.hi - legend.lo)) / n));
  const title = `${legend.label}${legend.units ? " (" + legend.units + ")" : ""}`;

  ctx.save();
  ctx.font = `bold ${fontSize + 2}px Arial, sans-serif`;
  const titleW = ctx.measureText(title).width;
  ctx.font = `${fontSize}px Arial, sans-serif`;
  let maxLabelW = 0;
  for (const l of labels) maxLabelW = Math.max(maxLabelW, ctx.measureText(l).width);

  const w = Math.max(pad + sw + gap + 6 + maxLabelW + pad, pad + titleW + pad);
  const h = pad + titleH + barH + pad + fontSize / 2;
  const [px, py] = anchorBox(anchor, w, h, frameW, frameH, M, offX, offY);

  ctx.fillStyle = "rgba(255,255,255,0.82)"; ctx.strokeStyle = "rgba(0,0,0,0.22)";
  roundRect(ctx, px, py, w, h, 8); ctx.fill(); ctx.stroke();

  ctx.fillStyle = "#111"; ctx.font = `bold ${fontSize + 2}px Arial, sans-serif`;
  ctx.textAlign = "left"; ctx.textBaseline = "top";
  ctx.fillText(title, px + pad, py + pad);

  const barX = px + pad, barTop = py + pad + titleH, barBottom = barTop + barH;
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = legend.bands[i].color;
    ctx.fillRect(barX, barBottom - (i + 1) * blockH, sw, blockH);
  }
  ctx.strokeStyle = "rgba(0,0,0,0.5)"; ctx.lineWidth = 1;
  ctx.strokeRect(barX + 0.5, barTop + 0.5, sw, barH);

  ctx.fillStyle = "#111"; ctx.font = `${fontSize}px Arial, sans-serif`; ctx.textBaseline = "middle";
  for (let i = 0; i <= n; i++) {
    const y = barBottom - i * blockH;
    ctx.beginPath(); ctx.moveTo(barX + sw, y); ctx.lineTo(barX + sw + 5, y); ctx.stroke();
    ctx.fillText(labels[i], barX + sw + gap, y);
  }
  ctx.restore();
}

// North arrow in a CIRCLE. The needle + N are centered and rotate by rotRad, so
// they stay inside the circle at any orientation.
export function drawNorthArrow(ctx, o) {
  const { frameW, frameH, anchor = "br", offX = 0, offY = 0, radius = 46, rotRad = 0 } = o;
  const d = radius * 2;
  const [x, y] = anchorBox(anchor, d, d, frameW, frameH, M, offX, offY);
  const cx = x + radius, cy = y + radius;

  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.82)"; ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.28)"; ctx.lineWidth = 1.5; ctx.stroke();

  ctx.translate(cx, cy);
  ctx.rotate(rotRad);
  // glyph (N + needle) is laid out symmetric about y=0 — its long axis spans
  // [-A, +A], so it rotates about its own middle and stays clear of the rim.
  // arrow geometry (tip up), with the N tucked just above the tip; then shift
  // the whole glyph so its vertical extent is symmetric about 0 — i.e. it
  // rotates about its true middle.
  const r = radius, fN = Math.round(r * 0.4), halfN = fN * 0.45, gap = 0.05 * r;
  const tip = -0.28 * r, base = 0.84 * r, notch = 0.42 * r, halfW = 0.27 * r;
  const nCenter = tip - gap - halfN;                 // N just above the tip
  const dy = -((nCenter - halfN) + base) / 2;        // recenter on the glyph's middle
  ctx.fillStyle = "#111";
  ctx.beginPath();                                   // needle points north (up)
  ctx.moveTo(0, tip + dy);
  ctx.lineTo(halfW, base + dy);
  ctx.lineTo(0, notch + dy);
  ctx.lineTo(-halfW, base + dy);
  ctx.closePath(); ctx.fill();
  ctx.font = `bold ${fN}px Arial, sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("N", 0, nCenter + dy);
  ctx.restore();
}

// Scale bar in feet. `sizeScale` enlarges the bar + text together.
const niceRound = (v) => {
  if (!isFinite(v) || v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  return [1, 2, 5, 10].map((m) => m * p).reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
};

// Compartmented scale bar in feet: `segments` equal divisions (alternating
// black/white) with a round number at each boundary. `sizeScale` scales it all.
export function drawScaleBar(ctx, o) {
  const { frameW, frameH, anchor = "bl", offX = 0, offY = 0, ftPerPixel, sizeScale = 1.4, segments = 4 } = o;
  const segs = Math.max(1, Math.min(8, Math.round(segments)));
  const VIS = 1.5;                                   // fixed visual scale — text, bar thickness & padding stay constant
  const unitFt = niceRound((140 * sizeScale * ftPerPixel) / segs); // sizeScale controls only the bar's longitudinal length
  const totalPx = (unitFt * segs) / ftPerPixel;
  const segPx = totalPx / segs;
  const barH = Math.round(7 * VIS), font = Math.round(13 * VIS);
  const pad = 12 * VIS, tick = 5 * VIS, lw = Math.max(1, VIS);

  const w = totalPx + pad * 2, h = pad * 0.7 + barH + tick + (font + 4) + (font + 4);
  const [x, y] = anchorBox(anchor, w, h, frameW, frameH, M, offX, offY);
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.82)"; ctx.strokeStyle = "rgba(0,0,0,0.22)";
  roundRect(ctx, x, y, w, h, 6); ctx.fill(); ctx.stroke();

  const bx = x + pad, by = y + pad * 0.7;
  ctx.strokeStyle = "#111"; ctx.fillStyle = "#111"; ctx.lineWidth = lw;
  for (let i = 0; i < segs; i++) {                 // alternating filled compartments
    if (i % 2 === 0) ctx.fillRect(bx + i * segPx, by, segPx, barH);
  }
  ctx.strokeRect(bx + 0.5, by + 0.5, totalPx, barH);

  ctx.font = `${font}px Arial, sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "top";
  const ty = by + barH;
  for (let i = 0; i <= segs; i++) {                // ticks + round labels at boundaries
    const sx = bx + i * segPx;
    ctx.beginPath(); ctx.moveTo(sx, ty); ctx.lineTo(sx, ty + tick); ctx.stroke();
    ctx.fillText(String(Math.round(i * unitFt)), sx, ty + tick + 2);
  }
  ctx.fillText("ft (U.S. Survey)", bx + totalPx / 2, ty + tick + 2 + font + 4);
  ctx.restore();
}

// Relative luminance of a #rrggbb color (0..1), for picking a contrasting halo.
function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return 1;
  const n = parseInt(m[1], 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

// User annotations (text labels + simple arrows), anchored to map coordinates so
// they track pan/zoom/rotate and land identically on every report figure (shared
// extent). Drawn in screen space — text stays upright regardless of map rotation.
// Each: { type:'label'|'arrow', ax, ay (merc anchor), ox, oy (screen-px nudge),
//   text, fontSize, color, length, angle (deg), thickness, visible }.
export function drawAnnotations(ctx, view, annos) {
  if (!annos || !annos.length) return;
  const cos = Math.cos(view.rotRad), sin = Math.sin(view.rotRad);
  const project = (a) => {
    const [lx, ly] = view.toLocal(a.ax, a.ay);
    return [view.originX + lx * cos - ly * sin + (a.ox || 0), view.originY + lx * sin + ly * cos + (a.oy || 0)];
  };
  for (const a of annos) {
    if (a.visible === false) continue;
    const [sx, sy] = project(a);
    ctx.save();
    if (a.type === "arrow") {
      const ang = ((a.angle || 0) * Math.PI) / 180;
      const len = Math.max(4, a.length || 120);
      const th = Math.max(1, a.thickness || 4);
      const ex = sx + Math.cos(ang) * len, ey = sy + Math.sin(ang) * len;
      ctx.strokeStyle = a.color; ctx.fillStyle = a.color; ctx.lineWidth = th; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
      const hl = th * 3 + 7, hw = th * 1.8 + 4;          // arrowhead at the tip
      const ux = Math.cos(ang), uy = Math.sin(ang), nx = -uy, ny = ux;
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - ux * hl + nx * hw, ey - uy * hl + ny * hw);
      ctx.lineTo(ex - ux * hl - nx * hw, ey - uy * hl - ny * hw);
      ctx.closePath(); ctx.fill();
    } else {
      const fs = Math.max(6, a.fontSize || 28);
      ctx.font = `600 ${fs}px Arial, sans-serif`;
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      if (a.halo) {                                     // optional contrast halo
        ctx.lineJoin = "round"; ctx.miterLimit = 2;
        ctx.strokeStyle = luminance(a.color) > 0.5 ? "rgba(0,0,0,0.85)" : "rgba(255,255,255,0.92)";
        ctx.lineWidth = Math.max(2, fs / 6);
        ctx.strokeText(a.text || "", sx, sy);
      }
      ctx.fillStyle = a.color; ctx.fillText(a.text || "", sx, sy);
    }
    ctx.restore();
  }
}
