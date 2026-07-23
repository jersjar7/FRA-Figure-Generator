import * as h5wasm from "../vendor/h5wasm/hdf5_hl.js";
import shp, { combine, parseDbf, parseShp } from "shpjs";
import proj4 from "proj4";
import { readGeometry, readDatasets, finalTimestep, finalVector, isGeometryFile, isDatasetsFile } from "./h5.js";
import { toLonLat, lonLatToMerc } from "./geo.js";
import { fillMesh, strokeMesh } from "./contour.js";
import { drawBasemap, ESRI_WORLD_IMAGERY } from "./tiles.js";
import { drawOverlays, drawOverlayLabels, propKeys, describe, OVERLAY_PALETTE } from "./overlays.js";
import { rampColor, makeColorFn, legendBands, RAMP_OPTIONS } from "./ramps.js";
import { anchorBox, drawTitle, drawLegend, drawNorthArrow, drawScaleBar, drawAnnotations } from "./render.js";
import { parseSummary, formatStation } from "./parse.js";

const $ = (id) => document.getElementById(id);
const VALID = (v) => v != null && Number.isFinite(v) && v > -900;
const FRAMES = {
  landscape: { w: 1650, h: 1275, wIn: 11, hIn: 8.5 },
  portrait: { w: 1275, h: 1650, wIn: 8.5, hIn: 11 },
};
const R = 6378137;
const ANNO_NUDGE = 10;

let ready = false;
let conditions = new Map(); // EX/PR/DEFAULT -> { geom, proj, dFile, datasets }
let overlays = [];
let manualLines = [];
let lineOverrides = {};
let annotations = [];
let annoSeq = 0;
let overlaySeq = 0;
let manualLineSeq = 0;
let scene = null;
let chartRows = [];
let crossRows = [];
const MAP_ELEMENT_CONFIG = [
  { key: "title", label: "Title", anchor: "tc" },
  { key: "diffLegend", label: "WSE diff legend", anchor: "br" },
  { key: "topoLegend", label: "Topography legend", anchor: "tl" },
  { key: "wseLegend", label: "WSE legend", anchor: "ml" },
  { key: "north", label: "North arrow", anchor: "tr" },
  { key: "scale", label: "Scale bar", anchor: "bl" },
  { key: "wetDry", label: "Wet/dry key", anchor: "mr" },
];
const ANCHORS = [
  ["tl", "Top left"], ["tc", "Top center"], ["tr", "Top right"],
  ["ml", "Middle left"], ["mc", "Center"], ["mr", "Middle right"],
  ["bl", "Bottom left"], ["bc", "Bottom center"], ["br", "Bottom right"],
];
function defaultMapElementPositions() {
  return Object.fromEntries(MAP_ELEMENT_CONFIG.map((c) => [c.key, { anchor: c.anchor, offX: 0, offY: 0 }]));
}
let mapElementPos = defaultMapElementPositions();
let drawingLine = null;
let placingAnno = null;
let rotDeg = 0, zoom = 1, panX = 0, panY = 0;
let valueCache = new Map();

(async () => { await h5wasm.ready; ready = true; })();

function msg(text, type = "ok") {
  const div = document.createElement("div");
  div.className = `toast ${type}`;
  div.setAttribute("role", type === "err" ? "alert" : "status");
  const body = document.createElement("span");
  body.textContent = text;
  const close = document.createElement("button");
  close.className = "toast-close";
  close.type = "button";
  close.setAttribute("aria-label", "Close notification");
  close.textContent = "x";
  div.append(body, close);
  const remove = () => {
    div.classList.add("out");
    setTimeout(() => div.remove(), 180);
  };
  close.addEventListener("click", remove);
  $("toastStack").appendChild(div);
  setTimeout(remove, type === "err" ? 10000 : 6500);
}
function setMessages(items) {
  $("toastStack").innerHTML = "";
  items.forEach((m) => msg(m.text, m.type));
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/`/g, "&#96;");
}

function conditionToken(text) {
  const s = String(text || "");
  const hasExisting = /(^|[^a-z0-9])(existing|ex)(?=[^a-z0-9]|$)/i.test(s);
  const hasProposed = /(^|[^a-z0-9])(proposed|pr)(?=[^a-z0-9]|$)/i.test(s);
  if (hasExisting && !hasProposed) return "EX";
  if (hasProposed && !hasExisting) return "PR";
  return null;
}
function condKey(name, fileName = "") {
  const fromFileName = conditionToken(fileName);
  if (fromFileName) return fromFileName;
  const fromH5Name = conditionToken(name);
  if (fromH5Name) return fromH5Name;
  return "DEFAULT";
}
const condLabel = (k) => k === "EX" ? "Existing" : k === "PR" ? "Proposed" : "Mesh";
const runLabel = (s) => String(s || "").replace(/\(SRH-2D\)/i, "").replace(/^EX\b/i, "Existing").replace(/^PR\b/i, "Proposed").trim();

function getCond(k) {
  if (!conditions.has(k)) conditions.set(k, {});
  return conditions.get(k);
}
function usableConditions() {
  const named = [...conditions].filter(([k]) => k !== "DEFAULT");
  return named.length ? named : [...conditions];
}
function allRunOptions(k) {
  const c = conditions.get(k);
  if (!c?.proj || !c?.datasets) return [];
  return c.datasets.runs.map((run, idx) => ({ key: k, cond: c, run, idx }));
}
function selectedRun(which) {
  const val = $(which).value;
  if (!val) return null;
  const [key, idxRaw] = val.split(":");
  const c = conditions.get(key);
  const idx = Number(idxRaw);
  const run = c?.datasets?.runs?.[idx];
  return c && run ? { key, cond: c, run, idx } : null;
}

function bboxFromArrays(mx, my) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < mx.length; i++) {
    if (mx[i] < x0) x0 = mx[i];
    if (mx[i] > x1) x1 = mx[i];
    if (my[i] < y0) y0 = my[i];
    if (my[i] > y1) y1 = my[i];
  }
  return { x0, x1, y0, y1 };
}
function bboxFromXY(xy) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < xy.length / 2; i++) {
    const x = xy[i * 2], y = xy[i * 2 + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x0, x1, y0, y1 };
}
function projectMesh(g) {
  const { lon, lat } = toLonLat(g.xy, g.wkt);
  const { mx, my } = lonLatToMerc(lon, lat);
  const mercBbox = bboxFromArrays(mx, my);
  const xyBbox = bboxFromXY(g.xy);
  const latRad = lat.length ? (lat.reduce((a, b) => a + b, 0) / lat.length) * Math.PI / 180 : 0;
  const ftPerMercX = (xyBbox.x1 - xyBbox.x0) / (mercBbox.x1 - mercBbox.x0 || 1);
  const ftPerMercY = (xyBbox.y1 - xyBbox.y0) / (mercBbox.y1 - mercBbox.y0 || 1);
  return {
    name: g.meshName, N: g.N, xy: g.xy, z: g.z, tris: g.tris, wkt: g.wkt,
    lon, lat, mx, my, bbox: mercBbox, xyBbox, latRad,
    ftPerMerc: Math.abs((ftPerMercX + ftPerMercY) / 2),
    toXY: proj4(g.wkt, "WGS84"),
  };
}
function commonBbox() {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [, c] of usableConditions()) {
    const b = c.proj?.bbox;
    if (!b) continue;
    x0 = Math.min(x0, b.x0); x1 = Math.max(x1, b.x1);
    y0 = Math.min(y0, b.y0); y1 = Math.max(y1, b.y1);
  }
  if (!isFinite(x0)) return { x0: -1, x1: 1, y0: -1, y1: 1 };
  const padX = (x1 - x0) * 0.08, padY = (y1 - y0) * 0.08;
  return { x0: x0 - padX, x1: x1 + padX, y0: y0 - padY, y1: y1 + padY };
}

function makeView(bbox, frame) {
  const cx = (bbox.x0 + bbox.x1) / 2;
  const cy = (bbox.y0 + bbox.y1) / 2;
  const scale = Math.min(frame.w / (bbox.x1 - bbox.x0 || 1), frame.h / (bbox.y1 - bbox.y0 || 1)) * 0.88 * zoom;
  const originX = frame.w / 2 + panX;
  const originY = frame.h / 2 + panY;
  const rotRad = rotDeg * Math.PI / 180;
  const c = Math.cos(rotRad), s = Math.sin(rotRad);
  return {
    scale, originX, originY, rotRad, centerX: cx, centerY: cy,
    toLocal(mx, my) { return [(mx - cx) * scale, -(my - cy) * scale]; },
    screenToMerc(x, y) {
      const dx = x - originX, dy = y - originY;
      const lx = dx * c + dy * s;
      const ly = -dx * s + dy * c;
      return { x: cx + lx / scale, y: cy - ly / scale };
    },
    coverBbox() {
      const pts = [
        this.screenToMerc(0, 0), this.screenToMerc(frame.w, 0),
        this.screenToMerc(0, frame.h), this.screenToMerc(frame.w, frame.h),
      ];
      return {
        x0: Math.min(...pts.map((p) => p.x)), x1: Math.max(...pts.map((p) => p.x)),
        y0: Math.min(...pts.map((p) => p.y)), y1: Math.max(...pts.map((p) => p.y)),
      };
    },
  };
}
function localToScreen(view, lx, ly) {
  const c = Math.cos(view.rotRad), s = Math.sin(view.rotRad);
  return [view.originX + lx * c - ly * s, view.originY + lx * s + ly * c];
}
function mercToLonLat(mx, my) {
  return [
    mx / R * 180 / Math.PI,
    (2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) * 180 / Math.PI,
  ];
}
function mercToXY(proj, mx, my) {
  const [lon, lat] = mercToLonLat(mx, my);
  return proj.toXY.inverse([lon, lat]);
}

function wireDropzone(zoneId, inputId, onFiles, accept) {
  const zone = $(zoneId), input = $(inputId);
  input.addEventListener("change", (e) => { onFiles([...e.target.files]); input.value = ""; });
  ["dragenter", "dragover"].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add("drag"); }));
  ["dragleave", "dragend", "drop"].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove("drag"); }));
  zone.addEventListener("drop", (e) => {
    const files = [...(e.dataTransfer?.files || [])].filter((f) => accept.test(f.name));
    if (files.length) onFiles(files);
  });
}

async function ingestH5Files(files) {
  if (!ready) await h5wasm.ready;
  const notes = [];
  for (const file of files) {
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const fname = file.name.replace(/[^\w.]/g, "_");
      try { h5wasm.FS.unlink(fname); } catch {}
      h5wasm.FS.writeFile(fname, buf);
      const h = new h5wasm.File(fname, "r");
      if (isGeometryFile(h)) {
        const geom = readGeometry(h);
        const key = condKey(geom.meshName, file.name);
        getCond(key).geom = geom;
        getCond(key).proj = projectMesh(geom);
        notes.push(`${file.name}: ${condLabel(key)} geometry (${geom.N.toLocaleString()} nodes)`);
      } else if (isDatasetsFile(h)) {
        const datasets = readDatasets(h);
        const key = condKey(datasets.runs[0]?.name || "", file.name);
        const c = getCond(key);
        c.dFile = h;
        c.datasets = datasets;
        notes.push(`${file.name}: ${condLabel(key)} datasets (${datasets.runs.length} run${datasets.runs.length === 1 ? "" : "s"})`);
      } else {
        notes.push(`${file.name}: not recognized as SMS geometry or datasets`);
      }
    } catch (err) {
      notes.push(`${file.name}: ${err.message}`);
    }
  }
  valueCache = new Map();
  refreshH5Status();
  populateRunSelectors();
  setMessages(notes.map((text) => ({ type: text.includes("not recognized") ? "warn" : "ok", text })));
}

function refreshH5Status() {
  const badge = (on, text) => `<span class="badge ${on ? "on" : ""}">${on ? "ok " : ""}${text}</span>`;
  const rows = [];
  for (const key of ["EX", "PR", "DEFAULT"].filter((k) => conditions.has(k))) {
    const c = conditions.get(key);
    rows.push(`<div class="cond-row"><span class="cond-name">${condLabel(key)}</span>${badge(!!c.proj, c.proj ? `${c.proj.N.toLocaleString()} nodes` : "geometry")}${badge(!!c.datasets, c.datasets ? `${c.datasets.runs.length} runs` : "datasets")}</div>`);
  }
  $("h5Status").innerHTML = rows.length ? rows.join("") : `<div class="hint">No H5 files loaded yet.</div>`;
}
function populateRunSelectors() {
  const ex = allRunOptions("EX");
  const pr = allRunOptions("PR");
  $("existingRun").innerHTML = ex.map((r) => `<option value="${r.key}:${r.idx}">${escapeHtml(runLabel(r.run.name))}</option>`).join("");
  $("proposedRun").innerHTML = pr.map((r) => `<option value="${r.key}:${r.idx}">${escapeHtml(runLabel(r.run.name))}</option>`).join("");
  $("runBlock").hidden = !ex.length || !pr.length;
}

async function ingestOverlayFiles(files) {
  for (const file of files) {
    try {
      const { res, usedMeshCrs } = await readOverlayZip(file);
      for (const fc of (Array.isArray(res) ? res : [res])) {
        overlays.push({
          id: ++overlaySeq,
          name: (fc.fileName || file.name).replace(/\.zip$/i, "").split("/").pop(),
          geojson: fc,
          color: OVERLAY_PALETTE[overlays.length % OVERLAY_PALETTE.length],
          width: 3,
          hidden: false,
          role: "context",
          labelField: "",
          labelSize: 20,
          fields: propKeys(fc),
          open: false,
        });
      }
      if (usedMeshCrs) msg(`Read ${file.name} using the loaded mesh CRS because its shapefile projection is not supported directly.`, "warn");
    } catch (err) {
      msg(`Could not read ${file.name}: ${overlayErrorText(err)}`, "err");
    }
  }
  renderOverlayList();
  renderLineList();
  if (scene) await renderMap();
}

function overlayMeshWkt() {
  for (const [, c] of usableConditions()) if (c.proj?.wkt) return c.proj.wkt;
  return null;
}

const zipU16 = (a, i) => a[i] | (a[i + 1] << 8);
const zipU32 = (a, i) => (a[i] | (a[i + 1] << 8) | (a[i + 2] << 16) | (a[i + 3] << 24)) >>> 0;
function ignorePrjEntriesInZip(buf) {
  const out = new Uint8Array(buf);
  const dec = new TextDecoder();
  let changed = false;
  for (let i = 0; i < out.length - 4; i++) {
    const sig = zipU32(out, i);
    let lenAt = -1, nameAt = -1;
    if (sig === 0x04034b50 && i + 30 <= out.length) { lenAt = i + 26; nameAt = i + 30; }
    else if (sig === 0x02014b50 && i + 46 <= out.length) { lenAt = i + 28; nameAt = i + 46; }
    if (lenAt < 0) continue;
    const nameLen = zipU16(out, lenAt), nameEnd = nameAt + nameLen;
    if (nameEnd > out.length) continue;
    const name = dec.decode(out.slice(nameAt, nameEnd));
    if (/\.prj$/i.test(name)) {
      out[nameEnd - 1] = name.endsWith("PRJ") ? 88 : 120; // .prj -> .prx, same length
      changed = true;
    }
  }
  return { bytes: out, changed };
}

function sliceArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function inflateZipData(method, data, name) {
  if (method === 0) return data;
  if (method !== 8) throw new Error(`${name}: unsupported zip compression method ${method}`);
  if (typeof DecompressionStream !== "function") throw new Error(`${name}: this browser cannot decompress deflated zip entries`);
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzipEntries(buf) {
  const src = new Uint8Array(buf);
  const dec = new TextDecoder();
  const entries = new Map();
  for (let i = 0; i < src.length - 46; i++) {
    if (zipU32(src, i) !== 0x02014b50) continue;
    const method = zipU16(src, i + 10);
    const compSize = zipU32(src, i + 20);
    const nameLen = zipU16(src, i + 28);
    const extraLen = zipU16(src, i + 30);
    const commentLen = zipU16(src, i + 32);
    const localOff = zipU32(src, i + 42);
    const name = dec.decode(src.slice(i + 46, i + 46 + nameLen));
    i += 45 + nameLen + extraLen + commentLen;
    if (!name || name.endsWith("/")) continue;
    if (zipU32(src, localOff) !== 0x04034b50) throw new Error(`${name}: invalid zip local header`);
    const localNameLen = zipU16(src, localOff + 26);
    const localExtraLen = zipU16(src, localOff + 28);
    const dataStart = localOff + 30 + localNameLen + localExtraLen;
    const comp = src.slice(dataStart, dataStart + compSize);
    entries.set(name.toLowerCase(), { name, data: await inflateZipData(method, comp, name) });
  }
  return entries;
}

async function readRawShapefilesFromZip(buf) {
  const entries = await unzipEntries(buf);
  const bases = new Map();
  for (const [name, entry] of entries) {
    const m = name.match(/^(.*)\.(shp|dbf)$/i);
    if (!m) continue;
    if (!bases.has(m[1])) bases.set(m[1], {});
    bases.get(m[1])[m[2].toLowerCase()] = entry;
  }
  const out = [];
  for (const [, group] of bases) {
    if (!group.shp) continue;
    const geoms = parseShp(sliceArrayBuffer(group.shp.data));
    let props = [];
    if (group.dbf) {
      try { props = parseDbf(sliceArrayBuffer(group.dbf.data)); }
      catch { props = []; }
    }
    if (!Array.isArray(props) || props.length !== geoms.length) props = geoms.map(() => ({}));
    const fc = combine([geoms, props]);
    fc.fileName = (group.shp.name || "").replace(/\.shp$/i, "");
    out.push(fc);
  }
  if (!out.length) throw new Error("No .shp geometry found in the zip.");
  return out.length === 1 ? out[0] : out;
}

function reprojectRawOverlayWithMeshCrs(fc, wkt) {
  const xy = [], refs = [];
  const visit = (coords) => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === "number" && typeof coords[1] === "number") {
      refs.push(coords);
      xy.push(coords[0], coords[1]);
    } else {
      for (const c of coords) visit(c);
    }
  };
  for (const f of fc.features || []) if (f.geometry) visit(f.geometry.coordinates);
  if (!refs.length) return fc;
  const { lon, lat } = toLonLat(Float64Array.from(xy), wkt);
  refs.forEach((coord, i) => { coord[0] = lon[i]; coord[1] = lat[i]; });
  return fc;
}

function overlayCoordsNeedMeshCrs(res) {
  let seen = 0;
  let projected = false;
  const visit = (coords) => {
    if (projected || !Array.isArray(coords)) return;
    if (typeof coords[0] === "number" && typeof coords[1] === "number") {
      seen++;
      if (Number.isFinite(coords[0]) && Number.isFinite(coords[1]) && (Math.abs(coords[0]) > 180 || Math.abs(coords[1]) > 90)) projected = true;
    } else {
      for (const c of coords) visit(c);
    }
  };
  for (const fc of (Array.isArray(res) ? res : [res])) {
    for (const f of fc?.features || []) if (f.geometry) visit(f.geometry.coordinates);
  }
  return seen > 0 && projected;
}

function reprojectOverlayResultWithMeshCrs(res, wkt) {
  const list = Array.isArray(res) ? res : [res];
  for (const fc of list) reprojectRawOverlayWithMeshCrs(fc, wkt);
  return Array.isArray(res) ? list : list[0];
}

async function readOverlayZip(file) {
  const buffer = await file.arrayBuffer();
  const meshWkt = overlayMeshWkt();
  try {
    const res = await shp(buffer);
    if (meshWkt && overlayCoordsNeedMeshCrs(res)) {
      const retry = ignorePrjEntriesInZip(buffer);
      let rawRes = retry.changed ? null : res;
      if (retry.changed) {
        try { rawRes = await shp(retry.bytes); }
        catch { rawRes = await readRawShapefilesFromZip(buffer); }
      }
      return { res: reprojectOverlayResultWithMeshCrs(rawRes, meshWkt), usedMeshCrs: true };
    }
    return { res, usedMeshCrs: false };
  } catch (primaryErr) {
    const retry = ignorePrjEntriesInZip(buffer);
    if (meshWkt && retry.changed) {
      let res;
      try { res = await shp(retry.bytes); }
      catch { res = await readRawShapefilesFromZip(buffer); }
      return { res: reprojectOverlayResultWithMeshCrs(res, meshWkt), usedMeshCrs: true, primaryErr };
    }
    throw primaryErr;
  }
}

function overlayErrorText(err) {
  const text = typeof err === "string" ? err : (err?.message || String(err ?? "Unknown error"));
  if (/Affine Post Process|Could not get projection name|PROJCS\[|s is not a function/i.test(text)) {
    return "unsupported shapefile projection. Load the matching Existing/Proposed mesh .h5 files first so the app can use the mesh CRS, or export the shapefile in WGS84.";
  }
  return text.length > 220 ? `${text.slice(0, 220)}...` : text;
}

function renderOverlayList() {
  const host = $("overlayList");
  host.innerHTML = "";
  overlays.forEach((ov, i) => {
    const fields = ['<option value="">No labels</option>'].concat(ov.fields.map((f) => `<option value="${escapeAttr(f)}"${f === ov.labelField ? " selected" : ""}>${escapeHtml(f)}</option>`));
    const li = document.createElement("li");
    li.className = "overlay-card";
    li.innerHTML = `
      <div class="overlay-head">
        <input class="ov-vis" type="checkbox" ${ov.hidden ? "" : "checked"} title="Show overlay" />
        <input class="ov-color" type="color" value="${ov.color}" />
        <strong title="${escapeAttr(ov.name)}">${escapeHtml(ov.name)}</strong>
        <button class="ov-expand mini" type="button">${ov.open ? "Hide" : "Style"}</button>
        <button class="ov-del mini" type="button">Delete</button>
      </div>
      <div class="ov-body"${ov.open ? "" : " hidden"}>
        <span class="hint">${describe(ov.geojson)}</span>
        <label>Layer role
          <select class="ov-role">
            <option value="context"${ov.role === "context" ? " selected" : ""}>Context overlay</option>
            <option value="observation"${ov.role === "observation" ? " selected" : ""}>Observation lines</option>
          </select>
        </label>
        <div class="row2">
          <label class="inline">Width <input class="ov-width" type="number" min="1" max="14" step="1" value="${ov.width}" /></label>
          <label class="inline">Label size <input class="ov-lsize" type="number" min="8" max="60" step="1" value="${ov.labelSize}" /></label>
        </div>
        <label>Label field <select class="ov-label">${fields.join("")}</select></label>
      </div>`;
    const rerender = async () => { renderLineList(); if (scene) await renderMap(); };
    li.querySelector(".ov-vis").addEventListener("change", async (e) => { ov.hidden = !e.target.checked; await rerender(); });
    li.querySelector(".ov-color").addEventListener("input", async (e) => { ov.color = e.target.value; await rerender(); });
    li.querySelector(".ov-expand").addEventListener("click", () => { ov.open = !ov.open; renderOverlayList(); });
    li.querySelector(".ov-del").addEventListener("click", async () => { overlays.splice(i, 1); renderOverlayList(); await rerender(); });
    li.querySelector(".ov-role").addEventListener("change", async (e) => { ov.role = e.target.value; await rerender(); });
    li.querySelector(".ov-width").addEventListener("input", async (e) => { ov.width = parseFloat(e.target.value) || 3; await rerender(); });
    li.querySelector(".ov-lsize").addEventListener("input", async (e) => { ov.labelSize = parseFloat(e.target.value) || 20; await rerender(); });
    li.querySelector(".ov-label").addEventListener("change", async (e) => { ov.labelField = e.target.value; await rerender(); });
    host.appendChild(li);
  });
}

function coordsToMerc(coords) {
  return coords.map(([lon, lat]) => {
    const mx = (lon * Math.PI / 180) * R;
    const my = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * R;
    return [mx, my];
  });
}
function featureLines(ov) {
  const lines = [];
  let featureIndex = 0;
  for (const f of ov.geojson.features || []) {
    const g = f.geometry;
    if (!g) continue;
    const baseLabel = ov.labelField && f.properties ? f.properties[ov.labelField] : "";
    if (g.type === "LineString") {
      lines.push({ id: `ov${ov.id}:${featureIndex}:0`, source: ov.name, coords: coordsToMerc(g.coordinates), label: baseLabel || `Line ${lines.length + 1}`, color: ov.color });
    } else if (g.type === "MultiLineString") {
      g.coordinates.forEach((part, partIndex) => lines.push({ id: `ov${ov.id}:${featureIndex}:${partIndex}`, source: ov.name, coords: coordsToMerc(part), label: baseLabel || `Line ${lines.length + 1}`, color: ov.color }));
    }
    featureIndex++;
  }
  return lines;
}
function allObservationLines() {
  const out = [];
  for (const ov of overlays) {
    if (ov.hidden || ov.role !== "observation") continue;
    out.push(...featureLines(ov));
  }
  out.push(...manualLines.map((l) => ({ ...l, source: "Manual" })));
  return out.map((l, i) => {
    const over = lineOverrides[l.id] || {};
    return { ...l, index: i, label: over.label || l.label || `Line ${i + 1}`, station: over.station || "" };
  });
}
function renderLineList() {
  const lines = allObservationLines();
  $("lineEmpty").hidden = lines.length > 0;
  const host = $("lineList");
  host.innerHTML = "";
  lines.forEach((line, i) => {
    const li = document.createElement("li");
    li.className = "line-card";
    li.innerHTML = `
      <div class="line-head">
        <strong>${escapeHtml(line.label)}</strong>
        <span class="badge">${escapeHtml(line.source || "")}</span>
        ${String(line.id).startsWith("m") ? `<button class="line-del mini" type="button">Delete</button>` : ""}
      </div>
      <div class="line-body">
        <label>Label <input class="line-label" type="text" value="${escapeAttr(line.label)}" /></label>
        <label>Station <input class="line-station" type="text" value="${escapeAttr(line.station)}" placeholder="30+00" /></label>
      </div>`;
    li.querySelector(".line-label").addEventListener("input", async (e) => { lineOverrides[line.id] = { ...(lineOverrides[line.id] || {}), label: e.target.value }; if (scene) await renderMap(); });
    li.querySelector(".line-station").addEventListener("input", (e) => { lineOverrides[line.id] = { ...(lineOverrides[line.id] || {}), station: e.target.value }; });
    const del = li.querySelector(".line-del");
    if (del) del.addEventListener("click", async () => {
      manualLines = manualLines.filter((m) => m.id !== line.id);
      delete lineOverrides[line.id];
      renderLineList();
      if (scene) await renderMap();
    });
    host.appendChild(li);
  });
}
function applyStationLabels() {
  const rows = parseSummary($("summaryPaste").value || "").rows.sort((a, b) => a.station - b.station);
  const lines = allObservationLines();
  if (!rows.length) return msg("No station rows found in the Summary Table paste.", "warn");
  if (!lines.length) return msg("Add observation lines before applying station labels.", "warn");
  const n = Math.min(rows.length, lines.length);
  for (let i = 0; i < n; i++) {
    const label = formatStation(rows[i].station);
    lineOverrides[lines[i].id] = { ...(lineOverrides[lines[i].id] || {}), station: label, label: label };
  }
  renderLineList();
  msg(`Applied ${n} station label${n === 1 ? "" : "s"} by observation-line order.`, "ok");
}

function niceBounds(lo, hi, target = 8) {
  if (!isFinite(lo) || !isFinite(hi) || lo === hi) return { min: 0, max: 1, step: 0.1 };
  const span = hi - lo;
  const raw = span / target;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * p).find((v) => v >= raw) || 10 * p;
  return { min: Math.floor(lo / step) * step, max: Math.ceil(hi / step) * step, step };
}
function stats(values) {
  let lo = Infinity, hi = -Infinity, maxAbs = 0, valid = 0;
  for (const v of values) {
    if (!VALID(v)) continue;
    valid++;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    maxAbs = Math.max(maxAbs, Math.abs(v));
  }
  return { lo, hi, maxAbs, valid };
}
function findParam(run, pattern) {
  return Object.keys(run.params).find((p) => pattern.test(p));
}
function cacheKey(sel, param, kind = "scalar") {
  return `${sel.key}:${sel.idx}:${param}:${kind}`;
}
function scalarValues(sel, param) {
  const key = cacheKey(sel, param);
  if (!valueCache.has(key)) valueCache.set(key, finalTimestep(sel.cond.dFile, sel.run.name, param));
  return valueCache.get(key);
}
function vectorValues(sel, param) {
  const key = cacheKey(sel, param, "vector");
  if (!valueCache.has(key)) valueCache.set(key, finalVector(sel.cond.dFile, sel.run.name, param));
  return valueCache.get(key);
}

function buildIndex(proj) {
  if (proj.index) return proj.index;
  const b = proj.bbox;
  const cell = Math.max((b.x1 - b.x0), (b.y1 - b.y0)) / Math.max(20, Math.sqrt(proj.N) / 2);
  const grid = new Map();
  for (let i = 0; i < proj.N; i++) {
    const cx = Math.floor((proj.mx[i] - b.x0) / cell);
    const cy = Math.floor((proj.my[i] - b.y0) / cell);
    const k = `${cx},${cy}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  }
  proj.index = { b, cell, grid };
  return proj.index;
}
function nearestNodeInfo(proj, mx, my) {
  const ix = buildIndex(proj);
  const cx = Math.floor((mx - ix.b.x0) / ix.cell);
  const cy = Math.floor((my - ix.b.y0) / ix.cell);
  let best = -1, bestD = Infinity;
  for (let r = 0; r <= 5; r++) {
    let searched = 0;
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const arr = ix.grid.get(`${cx + dx},${cy + dy}`);
        if (!arr) continue;
        searched += arr.length;
        for (const i of arr) {
          const x = proj.mx[i] - mx, y = proj.my[i] - my;
          const d = x * x + y * y;
          if (d < bestD) { bestD = d; best = i; }
        }
      }
    }
    if (best >= 0 && searched) break;
  }
  return { index: best, distance2: bestD };
}
function nearestNode(proj, mx, my) {
  return nearestNodeInfo(proj, mx, my).index;
}
function meshMatchTolerance2(proj) {
  if (proj.matchTolerance2) return proj.matchTolerance2;
  const lengths = [];
  for (let t = 0; t < proj.tris.length; t += 3) {
    const ids = [proj.tris[t], proj.tris[t + 1], proj.tris[t + 2]];
    for (let e = 0; e < 3; e++) {
      const a = ids[e], b = ids[(e + 1) % 3];
      lengths.push(Math.hypot(proj.mx[a] - proj.mx[b], proj.my[a] - proj.my[b]));
    }
  }
  lengths.sort((a, b) => a - b);
  const medianEdge = lengths[Math.floor(lengths.length / 2)] || buildIndex(proj).cell;
  const tol = Math.max(medianEdge * 2.25, buildIndex(proj).cell * 0.75);
  proj.matchTolerance2 = tol * tol;
  return proj.matchTolerance2;
}
function buildXYIndex(proj) {
  if (proj.xyIndex) return proj.xyIndex;
  const b = proj.xyBbox;
  const cell = Math.max((b.x1 - b.x0), (b.y1 - b.y0)) / Math.max(20, Math.sqrt(proj.N) / 2);
  const grid = new Map();
  for (let i = 0; i < proj.N; i++) {
    const x = proj.xy[i * 2], y = proj.xy[i * 2 + 1];
    const cx = Math.floor((x - b.x0) / cell);
    const cy = Math.floor((y - b.y0) / cell);
    const k = `${cx},${cy}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  }
  proj.xyIndex = { b, cell, grid };
  return proj.xyIndex;
}
function nearestNodeXY(proj, x, y) {
  const ix = buildXYIndex(proj);
  const cx = Math.floor((x - ix.b.x0) / ix.cell);
  const cy = Math.floor((y - ix.b.y0) / ix.cell);
  let best = -1, bestD = Infinity;
  for (let r = 0; r <= 5; r++) {
    let searched = 0;
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const arr = ix.grid.get(`${cx + dx},${cy + dy}`);
        if (!arr) continue;
        searched += arr.length;
        for (const i of arr) {
          const px = proj.xy[i * 2] - x, py = proj.xy[i * 2 + 1] - y;
          const d = px * px + py * py;
          if (d < bestD) { bestD = d; best = i; }
        }
      }
    }
    if (best >= 0 && searched) break;
  }
  return best;
}

function maskedWetValues(values, depth, dry) {
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    out[i] = VALID(values[i]) && VALID(depth[i]) && depth[i] > dry ? values[i] : -999;
  }
  return out;
}
function buildComparisonData(exSel, prSel) {
  const exWseP = findParam(exSel.run, /Water_?Elev/i);
  const prWseP = findParam(prSel.run, /Water_?Elev/i);
  const exDepthP = findParam(exSel.run, /Water_?Depth/i);
  const prDepthP = findParam(prSel.run, /Water_?Depth/i);
  if (!exWseP || !prWseP || !exDepthP || !prDepthP) throw new Error("Both runs need Water_Elev_ft and Water_Depth_ft.");

  const exWse = scalarValues(exSel, exWseP);
  const prWse = scalarValues(prSel, prWseP);
  const exDepth = scalarValues(exSel, exDepthP);
  const prDepth = scalarValues(prSel, prDepthP);
  const diff = new Float32Array(exSel.cond.proj.N);
  const wetDry = new Int8Array(exSel.cond.proj.N);
  const prWetDry = new Int8Array(prSel.cond.proj.N);
  const dry = parseFloat($("dryDepth").value) || 0;
  const prWseWet = maskedWetValues(prWse, prDepth, dry);
  const exMatchTol2 = meshMatchTolerance2(exSel.cond.proj);
  for (let i = 0; i < exSel.cond.proj.N; i++) {
    const j = nearestNode(prSel.cond.proj, exSel.cond.proj.mx[i], exSel.cond.proj.my[i]);
    const ew = exWse[i], pw = j >= 0 ? prWse[j] : -999;
    if (VALID(ew) && VALID(pw)) diff[i] = pw - ew;
    else diff[i] = -999;
    const exWet = VALID(exDepth[i]) && exDepth[i] > dry;
    const prWet = j >= 0 && VALID(prDepth[j]) && prDepth[j] > dry;
    wetDry[i] = !exWet && prWet ? 1 : exWet && !prWet ? -1 : 0;
  }
  for (let j = 0; j < prSel.cond.proj.N; j++) {
    const info = nearestNodeInfo(exSel.cond.proj, prSel.cond.proj.mx[j], prSel.cond.proj.my[j]);
    const comparable = info.index >= 0 && info.distance2 <= exMatchTol2;
    const exHasResult = comparable && VALID(exDepth[info.index]);
    const prWet = VALID(prDepth[j]) && prDepth[j] > dry;
    prWetDry[j] = !exHasResult && prWet ? 1 : 0;
  }
  return { exWse, prWse, exDepth, prDepth, diff, wetDry, prWetDry, prWseWet, exWseP, prWseP };
}

function diffColor(maxAbs) {
  const stops = [
    [0, [0, 31, 176]],
    [0.25, [99, 169, 213]],
    [0.48, [236, 245, 248]],
    [0.52, [255, 255, 210]],
    [0.75, [246, 173, 55]],
    [1, [197, 32, 32]],
  ];
  return (v) => {
    if (!VALID(v)) return null;
    const t = (v + maxAbs) / (2 * maxAbs || 1);
    return `rgb(${rampColor(stops, t).join(",")})`;
  };
}
function diffLegend(maxAbs, interval = null) {
  const n = interval && interval > 0
    ? Math.max(1, Math.min(80, Math.round((2 * maxAbs) / interval)))
    : 8;
  const bands = [];
  const fn = diffColor(maxAbs);
  const step = (2 * maxAbs) / n;
  for (let i = 0; i < n; i++) {
    const from = -maxAbs + i * step, to = from + step;
    bands.push({ from, to, color: fn((from + to) / 2) });
  }
  return { bands, lo: -maxAbs, hi: maxAbs, label: "WSE Difference", units: "ft" };
}
function fillWetDry(ctx, lx, ly, tris, wetDry) {
  ctx.save();
  const colors = wetDryColors(0.5);
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t], b = tris[t + 1], c = tris[t + 2];
    const s = wetDry[a] + wetDry[b] + wetDry[c];
    if (s === 0) continue;
    ctx.fillStyle = s > 0 ? colors.wet : colors.dry;
    ctx.beginPath();
    ctx.moveTo(lx[a], ly[a]); ctx.lineTo(lx[b], ly[b]); ctx.lineTo(lx[c], ly[c]);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}
function drawContours(ctx, lx, ly, tris, values, interval, color = "#cf2e2e", width = 1.4) {
  if (!interval || interval <= 0) return;
  const st = stats(values);
  if (!st.valid) return;
  const first = Math.ceil(st.lo / interval) * interval;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.globalAlpha = 0.88;
  for (let level = first; level <= st.hi + 1e-9; level += interval) {
    ctx.beginPath();
    for (let t = 0; t < tris.length; t += 3) {
      const ids = [tris[t], tris[t + 1], tris[t + 2]];
      const pts = [];
      for (let e = 0; e < 3; e++) {
        const i = ids[e], j = ids[(e + 1) % 3];
        const vi = values[i], vj = values[j];
        if (!VALID(vi) || !VALID(vj) || vi === vj) continue;
        if ((level >= Math.min(vi, vj)) && (level <= Math.max(vi, vj))) {
          const f = (level - vi) / (vj - vi);
          pts.push([lx[i] + (lx[j] - lx[i]) * f, ly[i] + (ly[j] - ly[i]) * f]);
        }
      }
      if (pts.length === 2) { ctx.moveTo(pts[0][0], pts[0][1]); ctx.lineTo(pts[1][0], pts[1][1]); }
    }
    ctx.stroke();
  }
  ctx.restore();
}

function frame() {
  return FRAMES[$("orientation").value] || FRAMES.landscape;
}
function activeProj() {
  const pr = selectedRun("proposedRun");
  const ex = selectedRun("existingRun");
  return (scene?.proj || pr?.cond?.proj || ex?.cond?.proj || usableConditions()[0]?.[1]?.proj);
}
function ftPerPixel(view) {
  const p = activeProj();
  return (p?.ftPerMerc || 3.28084) / view.scale;
}
function mapElementOptions(key, extra = {}) {
  const defaults = defaultMapElementPositions()[key] || { anchor: "br", offX: 0, offY: 0 };
  return { ...defaults, ...(mapElementPos[key] || {}), ...extra };
}
function optionalNum(id) {
  const el = $(id);
  if (!el) return null;
  const v = parseFloat(el.value);
  return Number.isFinite(v) ? v : null;
}
function colorVal(id, fallback) {
  return $(id)?.value || fallback;
}
function hexToRgba(hex, alpha) {
  const clean = String(hex || "").trim().replace("#", "");
  const short = /^[0-9a-f]{3}$/i.test(clean);
  const full = /^[0-9a-f]{6}$/i.test(clean);
  if (!short && !full) return hex;
  const expanded = short ? clean.split("").map((c) => c + c).join("") : clean;
  const r = parseInt(expanded.slice(0, 2), 16);
  const g = parseInt(expanded.slice(2, 4), 16);
  const b = parseInt(expanded.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
function wetDryColors(alpha) {
  return {
    wet: hexToRgba(colorVal("wetDryWetColor", "#28c985"), alpha),
    dry: hexToRgba(colorVal("wetDryDryColor", "#ee7e6f"), alpha),
  };
}
function legendFont(defaultSize) {
  const v = optionalNum("legendFont");
  return v && v > 0 ? v : defaultSize;
}
function scalarLegendControls(prefix, fallback, defaultRamp) {
  const minInput = optionalNum(`${prefix}Min`);
  const maxInput = optionalNum(`${prefix}Max`);
  const stepInput = optionalNum(`${prefix}Step`);
  const ramp = $(`${prefix}Ramp`)?.value || defaultRamp;
  const stepDefault = fallback.step || Math.max((fallback.max - fallback.min) / 8, 1);
  let min = minInput ?? fallback.min;
  let max = maxInput ?? fallback.max;
  let step = stepInput && stepInput > 0 ? stepInput : stepDefault;
  if (!Number.isFinite(min)) min = 0;
  if (!Number.isFinite(max) || max <= min) max = min + step;
  if ((max - min) / step > 160) step = (max - min) / 160;
  return { min, max, step, ramp };
}
function diffLegendControls(defaultMaxAbs) {
  const bound = optionalNum("diffLegendAbs");
  const step = optionalNum("diffLegendStep");
  return {
    maxAbs: Math.max(0.01, bound && bound > 0 ? bound : defaultMaxAbs),
    step: step && step > 0 ? step : null,
  };
}
function contourColor() {
  return $("contourColor")?.value || "#d92727";
}
function localCoordsFor(proj, view) {
  const lx = new Float64Array(proj.N), ly = new Float64Array(proj.N);
  for (let i = 0; i < proj.N; i++) {
    const pt = view.toLocal(proj.mx[i], proj.my[i]);
    lx[i] = pt[0]; ly[i] = pt[1];
  }
  return { lx, ly };
}

async function composeMap(ctx, fig, frameObj) {
  const view = makeView(commonBbox(), frameObj);
  ctx.clearRect(0, 0, frameObj.w, frameObj.h);
  ctx.fillStyle = "#e8edf3";
  ctx.fillRect(0, 0, frameObj.w, frameObj.h);
  await drawBasemap(ctx, view, { url: ESRI_WORLD_IMAGERY });
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.fillRect(0, 0, frameObj.w, frameObj.h);

  ctx.save();
  ctx.translate(view.originX, view.originY);
  ctx.rotate(view.rotRad);
  const p = fig.proj;
  const { lx, ly } = localCoordsFor(p, view);
  const diffScale = fig.type === "diff" ? diffLegendControls(fig.maxAbs) : null;

  if (fig.type === "diff") {
    fillMesh(ctx, lx, ly, p.tris, fig.diff, diffColor(diffScale.maxAbs));
    if ($("showWetDry").checked) {
      fillWetDry(ctx, lx, ly, p.tris, fig.wetDry);
      if (fig.prProj && fig.prWetDry) {
        const prLocal = localCoordsFor(fig.prProj, view);
        fillWetDry(ctx, prLocal.lx, prLocal.ly, fig.prProj.tris, fig.prWetDry);
      }
    }
    if ($("showContours").checked && fig.prProj && fig.prWseWet) {
      const prLocal = localCoordsFor(fig.prProj, view);
      drawContours(ctx, prLocal.lx, prLocal.ly, fig.prProj.tris, fig.prWseWet, parseFloat($("contourInterval").value), contourColor(), 1.5);
    }
  } else {
    const topoScale = scalarLegendControls("topoLegend", fig.groundBounds, "topography");
    const wseScale = scalarLegendControls("wseLegend", fig.wseBounds, "waterSurface");
    fillMesh(ctx, lx, ly, p.tris, p.z, makeColorFn("Topography", { min: topoScale.min, max: topoScale.max, interval: topoScale.step, ramp: topoScale.ramp }));
    ctx.save();
    ctx.globalAlpha = 0.9;
    fillMesh(ctx, lx, ly, p.tris, fig.wseWet, makeColorFn("Water_Elev_ft", { min: wseScale.min, max: wseScale.max, interval: wseScale.step, ramp: wseScale.ramp }));
    ctx.restore();
    if ($("showContours").checked) drawContours(ctx, lx, ly, p.tris, fig.wseWet, parseFloat($("contourInterval").value), contourColor(), 1.2);
    strokeMesh(ctx, lx, ly, p.tris, { color: "rgba(30,30,30,0.18)", width: 0.35 });
  }
  if ($("showOverlays").checked) drawOverlays(ctx, overlays, view);
  drawObservationLines(ctx, view, true);
  ctx.restore();

  if ($("showOverlays").checked) drawOverlayLabels(ctx, overlays, view);
  drawObservationLines(ctx, view, false);
  if ($("showAnnos").checked) drawAnnotations(ctx, view, annotations);

  const mapTitle = resolveTitle(fig);
  if ($("showTitle").checked) drawTitle(ctx, mapTitle, mapElementOptions("title", { frameW: frameObj.w, frameH: frameObj.h, fontSize: 26 }));
  if ($("showLegend").checked) {
    if (fig.type === "diff") drawLegend(ctx, diffLegend(diffScale.maxAbs, diffScale.step), mapElementOptions("diffLegend", { frameW: frameObj.w, frameH: frameObj.h, fontSize: legendFont(19) }));
    else {
      const topoScale = scalarLegendControls("topoLegend", fig.groundBounds, "topography");
      const wseScale = scalarLegendControls("wseLegend", fig.wseBounds, "waterSurface");
      drawLegend(ctx, legendBands("Topography", { min: topoScale.min, max: topoScale.max, interval: topoScale.step, ramp: topoScale.ramp }), mapElementOptions("topoLegend", { frameW: frameObj.w, frameH: frameObj.h, fontSize: legendFont(18) }));
      drawLegend(ctx, legendBands("Water_Elev_ft", { min: wseScale.min, max: wseScale.max, interval: wseScale.step, ramp: wseScale.ramp }), mapElementOptions("wseLegend", { frameW: frameObj.w, frameH: frameObj.h, fontSize: legendFont(18) }));
    }
  }
  if ($("showNorth").checked) drawNorthArrow(ctx, mapElementOptions("north", { frameW: frameObj.w, frameH: frameObj.h, radius: 46, rotRad: view.rotRad }));
  if ($("showScale").checked) drawScaleBar(ctx, mapElementOptions("scale", { frameW: frameObj.w, frameH: frameObj.h, ftPerPixel: ftPerPixel(view), sizeScale: 1.5, segments: 4 }));
  if (fig.type === "diff" && $("showWetDry").checked) drawWetDryKey(ctx, frameObj, mapElementOptions("wetDry", { frameW: frameObj.w, frameH: frameObj.h, fontSize: legendFont(18) }));
}
function fillWetDepth(ctx, lx, ly, tris, depth) {
  ctx.save();
  ctx.fillStyle = "rgba(30, 145, 210, 0.42)";
  const dry = parseFloat($("dryDepth").value) || 0;
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t], b = tris[t + 1], c = tris[t + 2];
    if ((VALID(depth[a]) && depth[a] > dry) || (VALID(depth[b]) && depth[b] > dry) || (VALID(depth[c]) && depth[c] > dry)) {
      ctx.beginPath();
      ctx.moveTo(lx[a], ly[a]); ctx.lineTo(lx[b], ly[b]); ctx.lineTo(lx[c], ly[c]);
      ctx.closePath(); ctx.fill();
    }
  }
  ctx.restore();
}
function drawWetDryKey(ctx, frameObj, o = {}) {
  const { anchor = "mr", offX = 0, offY = 0, fontSize = 18 } = o;
  const colors = wetDryColors(0.85);
  const titleSize = Math.max(10, fontSize);
  const labelSize = Math.max(9, fontSize - 2);
  const pad = Math.max(10, Math.round(fontSize * 0.75));
  const sw = Math.round(labelSize * 1.6);
  ctx.save();
  ctx.font = `bold ${titleSize}px Arial`;
  const titleW = ctx.measureText("Wet/Dry Change").width;
  ctx.font = `${labelSize}px Arial`;
  const labelW = Math.max(ctx.measureText("Newly inundated").width, ctx.measureText("Newly dry").width);
  const rowH = Math.max(labelSize + 8, 20);
  const w = Math.ceil(Math.max(titleW, sw + 8 + labelW) + pad * 2);
  const h = Math.ceil(pad * 2 + titleSize + 8 + rowH * 2);
  const [x, y] = anchorBox(anchor, w, h, frameObj.w, frameObj.h, 18, offX, offY);
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.strokeStyle = "rgba(0,0,0,0.25)";
  ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h);
  ctx.font = `bold ${titleSize}px Arial`;
  ctx.fillStyle = "#111";
  ctx.fillText("Wet/Dry Change", x + pad, y + pad + titleSize);
  ctx.fillStyle = colors.wet;
  const row1Y = y + pad + titleSize + 14;
  const row2Y = row1Y + rowH;
  ctx.fillRect(x + pad, row1Y, sw, Math.max(10, labelSize - 2));
  ctx.fillStyle = "#111";
  ctx.font = `${labelSize}px Arial`;
  ctx.fillText("Newly inundated", x + pad + sw + 8, row1Y + labelSize - 1);
  ctx.fillStyle = colors.dry;
  ctx.fillRect(x + pad, row2Y, sw, Math.max(10, labelSize - 2));
  ctx.fillStyle = "#111";
  ctx.fillText("Newly dry", x + pad + sw + 8, row2Y + labelSize - 1);
  ctx.restore();
}
function drawObservationLines(ctx, view, rotated) {
  const lines = allObservationLines();
  if (!lines.length) return;
  if (rotated) {
    ctx.save();
    ctx.strokeStyle = "#e00000";
    ctx.lineWidth = 3;
    ctx.setLineDash([12, 8]);
    for (const line of lines) {
      ctx.beginPath();
      line.coords.forEach(([mx, my], i) => {
        const [x, y] = view.toLocal(mx, my);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
    }
    ctx.restore();
  } else {
    ctx.save();
    ctx.font = "bold 22px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const line of lines) {
      const mid = line.coords[Math.floor(line.coords.length / 2)];
      if (!mid) continue;
      const [lx, ly] = view.toLocal(mid[0], mid[1]);
      const [sx, sy] = localToScreen(view, lx, ly);
      const label = line.station || line.label;
      const tw = ctx.measureText(label).width + 14;
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.strokeStyle = "#e00000";
      ctx.lineWidth = 1.5;
      ctx.fillRect(sx - tw / 2, sy - 16, tw, 28);
      ctx.strokeRect(sx - tw / 2, sy - 16, tw, 28);
      ctx.fillStyle = "#111";
      ctx.fillText(label, sx, sy - 1);
    }
    ctx.restore();
  }
}
function resolveTitle(fig) {
  const tpl = $("titleText").value || "{type} - {existing} vs {proposed}";
  const map = {
    type: fig.type === "diff" ? "WSE Difference Map" : "Proposed WSE, Inundation, and Ground Map",
    existing: runLabel(selectedRun("existingRun")?.run?.name || "Existing"),
    proposed: runLabel(selectedRun("proposedRun")?.run?.name || "Proposed"),
  };
  return tpl.replace(/\{(\w+)\}/g, (m, k) => map[k] ?? m).replace(/\s{2,}/g, " ").trim();
}

async function generateMap() {
  const exSel = selectedRun("existingRun");
  const prSel = selectedRun("proposedRun");
  if (!exSel || !prSel) return msg("Load Existing and Proposed H5 files and select runs first.", "warn");
  const type = $("figureType").value;
  try {
    if (type === "diff") {
      const cmp = buildComparisonData(exSel, prSel);
      const st = stats(cmp.diff);
      const maxAbs = Math.max(0.25, niceBounds(0, st.maxAbs, 6).max);
      scene = { type: "diff", proj: exSel.cond.proj, prProj: prSel.cond.proj, ...cmp, maxAbs };
    } else {
      const wseP = findParam(prSel.run, /Water_?Elev/i);
      const depthP = findParam(prSel.run, /Water_?Depth/i);
      if (!wseP || !depthP) throw new Error("Proposed run needs Water_Elev_ft and Water_Depth_ft.");
      const wse = scalarValues(prSel, wseP);
      const depth = scalarValues(prSel, depthP);
      const dry = parseFloat($("dryDepth").value) || 0;
      const wseWet = maskedWetValues(wse, depth, dry);
      const wseStats = stats(wseWet);
      if (!wseStats.valid) throw new Error("Proposed run has no wet Water_Elev_ft values at the selected dry-depth threshold.");
      const zStats = stats(prSel.cond.proj.z);
      scene = {
        type: "proposed",
        proj: prSel.cond.proj,
        wse,
        wseWet,
        depth,
        wseBounds: niceBounds(wseStats.lo, wseStats.hi, 8),
        groundBounds: niceBounds(zStats.lo, zStats.hi, 8),
      };
    }
    await renderMap();
    $("downloadMap").disabled = false;
    msg(type === "diff" ? "WSE difference map generated." : "Proposed WSE/inundation map generated.", "ok");
  } catch (err) {
    msg(err.message, "err");
  }
}
async function renderMap() {
  if (!scene) return;
  const cv = $("mapCanvas");
  const f = frame();
  cv.width = f.w; cv.height = f.h;
  cv.hidden = false;
  $("downloadMap").disabled = false;
  $("placeholder").hidden = true;
  await composeMap(cv.getContext("2d"), scene, f);
}

function lineSamples(line, proj, spacing = 2) {
  const pts = [];
  let total = 0;
  for (let si = 0; si < line.coords.length - 1; si++) {
    const a = line.coords[si], b = line.coords[si + 1];
    const ax = mercToXY(proj, a[0], a[1]);
    const bx = mercToXY(proj, b[0], b[1]);
    const dx = bx[0] - ax[0], dy = bx[1] - ax[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const steps = Math.max(1, Math.ceil(len / spacing));
    for (let k = 0; k <= steps; k++) {
      if (si > 0 && k === 0) continue;
      const f = k / steps;
      pts.push({
        mx: a[0] + (b[0] - a[0]) * f,
        my: a[1] + (b[1] - a[1]) * f,
        x: total + len * f,
        tx: dx / len,
        ty: dy / len,
      });
    }
    total += len;
  }
  return pts;
}
function weightedAverage(samples, wseArr, depthArr, vec, idxKey) {
  let sum = 0, wsum = 0, lenSum = 0, lenW = 0;
  for (const s of samples) {
    const idx = s[idxKey];
    const wse = wseArr[idx];
    if (!VALID(wse)) continue;
    const depth = depthArr && VALID(depthArr[idx]) ? Math.max(0, depthArr[idx]) : 0;
    let w = 0;
    if (vec && depth > 0) {
      const vx = vec.vx[idx], vy = vec.vy[idx];
      if (VALID(vx) && VALID(vy)) {
        const nx = -s.ty, ny = s.tx;
        w = depth * Math.abs(vx * nx + vy * ny);
      }
    }
    if (w > 1e-6) { sum += wse * w; wsum += w; }
    lenSum += wse; lenW++;
  }
  if (wsum > 1e-6) return { value: sum / wsum, method: "discharge-weighted" };
  return { value: lenW ? lenSum / lenW : null, method: "length-weighted" };
}
function profileForLine(line, exSel, prSel) {
  const exWseP = findParam(exSel.run, /Water_?Elev/i);
  const prWseP = findParam(prSel.run, /Water_?Elev/i);
  const exDepthP = findParam(exSel.run, /Water_?Depth/i);
  const prDepthP = findParam(prSel.run, /Water_?Depth/i);
  const exVelP = findParam(exSel.run, /^Velocity/i);
  const prVelP = findParam(prSel.run, /^Velocity/i);
  if (!exWseP || !prWseP) throw new Error("Water_Elev_ft is required for observation charts.");
  const exWse = scalarValues(exSel, exWseP), prWse = scalarValues(prSel, prWseP);
  const exDepth = exDepthP ? scalarValues(exSel, exDepthP) : null;
  const prDepth = prDepthP ? scalarValues(prSel, prDepthP) : null;
  const exVec = exVelP ? vectorValues(exSel, exVelP) : null;
  const prVec = prVelP ? vectorValues(prSel, prVelP) : null;
  const samples = lineSamples(line, exSel.cond.proj, 2);
  const dry = parseFloat($("dryDepth").value) || 0;
  for (const s of samples) {
    s.exIdx = nearestNode(exSel.cond.proj, s.mx, s.my);
    s.prIdx = nearestNode(prSel.cond.proj, s.mx, s.my);
    s.exGround = exSel.cond.proj.z[s.exIdx];
    s.prGround = prSel.cond.proj.z[s.prIdx];
    s.exWse = exWse[s.exIdx];
    s.prWse = prWse[s.prIdx];
    s.exDepth = exDepth ? exDepth[s.exIdx] : null;
    s.prDepth = prDepth ? prDepth[s.prIdx] : null;
    const exWet = VALID(s.exDepth) && s.exDepth > dry;
    const prWet = VALID(s.prDepth) && s.prDepth > dry;
    s.change = !exWet && prWet ? 1 : exWet && !prWet ? -1 : 0;
  }
  const exAvg = weightedAverage(samples, exWse, exDepth, exVec, "exIdx");
  const prAvg = weightedAverage(samples, prWse, prDepth, prVec, "prIdx");
  return { line, samples, exAvg, prAvg, diff: exAvg.value != null && prAvg.value != null ? prAvg.value - exAvg.value : null, method: exAvg.method === "discharge-weighted" && prAvg.method === "discharge-weighted" ? "discharge-weighted" : "length-weighted" };
}

function renderProfileChart(canvas, result) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
  const P = { l: 82, r: 26, t: 42, b: 78 };
  const vals = [];
  for (const s of result.samples) vals.push(s.exGround, s.prGround, s.exWse, s.prWse);
  const valid = vals.filter(VALID);
  const yb = niceBounds(Math.min(...valid), Math.max(...valid), 8);
  const xMax = Math.max(...result.samples.map((s) => s.x), 1);
  const xTo = (x) => P.l + x / xMax * (W - P.l - P.r);
  const yTo = (y) => H - P.b - (y - yb.min) / (yb.max - yb.min || 1) * (H - P.t - P.b);
  ctx.strokeStyle = "#d5dce5"; ctx.lineWidth = 1;
  ctx.font = "14px Arial";
  ctx.fillStyle = "#5a6575";
  for (let y = yb.min; y <= yb.max + 1e-9; y += yb.step) {
    const py = yTo(y);
    ctx.beginPath(); ctx.moveTo(P.l, py); ctx.lineTo(W - P.r, py); ctx.stroke();
    ctx.fillText(y.toFixed(Math.abs(y) >= 100 ? 0 : 1), 16, py + 5);
  }
  const xStep = niceBounds(0, xMax, 6).step;
  for (let x = 0; x <= xMax + 1e-9; x += xStep) {
    const px = xTo(x);
    ctx.beginPath(); ctx.moveTo(px, P.t); ctx.lineTo(px, H - P.b); ctx.stroke();
    ctx.fillText(String(Math.round(x)), px - 8, H - P.b + 26);
  }
  ctx.strokeStyle = "#111"; ctx.lineWidth = 1.5;
  ctx.strokeRect(P.l, P.t, W - P.l - P.r, H - P.t - P.b);

  for (let i = 0; i < result.samples.length - 1; i++) {
    const s = result.samples[i], n = result.samples[i + 1];
    if (!s.change) continue;
    ctx.fillStyle = s.change > 0 ? "rgba(40,201,133,0.14)" : "rgba(238,126,111,0.14)";
    ctx.fillRect(xTo(s.x), P.t, xTo(n.x) - xTo(s.x), H - P.t - P.b);
  }

  function line(key, color, dash, width = 2.5) {
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash || []);
    let open = false;
    ctx.beginPath();
    for (const s of result.samples) {
      const v = s[key];
      if (!VALID(v)) { open = false; continue; }
      const x = xTo(s.x), y = yTo(v);
      if (!open) { ctx.moveTo(x, y); open = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }
  line("exGround", "#a87900", [8, 5], 2.5);
  line("prGround", "#6f5300", [], 2.8);
  line("exWse", "#00a6e8", [14, 8], 2.6);
  line("prWse", "#416fd1", [14, 8], 2.6);
  function avgLine(avg, color, labelY) {
    if (avg.value == null) return;
    const y = yTo(avg.value);
    ctx.strokeStyle = color; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(P.l, y); ctx.lineTo(W - P.r, y); ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.strokeStyle = color;
    const txt = `${labelY} = ${avg.value.toFixed(2)} ft`;
    ctx.font = "bold 16px Arial";
    const tw = ctx.measureText(txt).width + 18;
    const bx = W * 0.45, by = y - 38;
    ctx.fillRect(bx, by, tw, 28); ctx.strokeRect(bx, by, tw, 28);
    ctx.fillStyle = color; ctx.fillText(txt, bx + 9, by + 19);
  }
  avgLine(result.exAvg, "#00a6e8", "Avg Existing 100-year WSE");
  avgLine(result.prAvg, "#416fd1", "Avg Proposed 100-year WSE");
  ctx.save();
  ctx.font = "bold 18px Arial";
  ctx.fillStyle = "#3f4856";
  ctx.textAlign = "center";
  ctx.fillText("Distance along Observation Line (ft)", W / 2, H - 22);
  ctx.translate(24, H / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText("Elevation (ft, NAVD88)", 0, 0);
  ctx.restore();
  drawChartLegend(ctx, W, P.t + 8);
  ctx.font = "bold 16px Arial";
  ctx.textAlign = "right";
  ctx.fillStyle = "#111";
  const title = `${result.line.station || result.line.label} - Looking downstream`;
  ctx.fillText(title, W - 36, H - 40);
}
function drawChartLegend(ctx, W, y) {
  const items = [
    ["Existing Ground", "#a87900", [8, 5]],
    ["Existing 100-year WSE", "#00a6e8", [14, 8]],
    ["Proposed Ground", "#6f5300", []],
    ["Proposed 100-year WSE", "#416fd1", [14, 8]],
  ];
  const x = W - 360, h = 28 * items.length + 16;
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.92)"; ctx.strokeStyle = "#333";
  ctx.fillRect(x, y, 330, h); ctx.strokeRect(x, y, 330, h);
  ctx.font = "15px Arial";
  items.forEach((it, i) => {
    const yy = y + 22 + i * 28;
    ctx.strokeStyle = it[1]; ctx.lineWidth = 2.5; ctx.setLineDash(it[2]);
    ctx.beginPath(); ctx.moveTo(x + 18, yy); ctx.lineTo(x + 78, yy); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = "#333"; ctx.fillText(it[0], x + 90, yy + 5);
  });
  ctx.restore();
}

function parseStationValue(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const sta = s.match(/^(-?\d+)\s*\+\s*(\d+(?:\.\d+)?)/);
  if (sta) {
    const whole = parseFloat(sta[1]);
    const off = parseFloat(sta[2]);
    return whole < 0 ? whole * 100 - off : whole * 100 + off;
  }
  const n = s.match(/-?\d+(?:\.\d+)?/);
  return n ? parseFloat(n[0]) : null;
}
function stationListFromControls() {
  const text = $("xsStations").value.trim();
  let rows = [];
  if (text) {
    rows = text.split(/\r?\n/).map((line) => {
      const station = parseStationValue(line);
      return station == null ? null : { station, label: formatStation(station) };
    }).filter(Boolean);
  } else {
    rows = parseSummary($("summaryPaste").value || "").rows
      .map((r) => ({ station: r.station, label: formatStation(r.station) }));
  }
  const seen = new Set();
  return rows.filter((r) => {
    const key = r.station.toFixed(3);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.station - b.station);
}
function parseCrossSectionCulverts() {
  return ($("xsCulverts").value || "").split(/\r?\n/).map((line) => {
    const parts = line.split(/[,\t ]+/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 5) return null;
    const station = parseStationValue(parts[0]);
    const left = parseFloat(parts[1]);
    const bottom = parseFloat(parts[2]);
    const width = parseFloat(parts[3]);
    const height = parseFloat(parts[4]);
    if ([station, left, bottom, width, height].some((v) => v == null || !isFinite(v))) return null;
    return { station, left, bottom, width, height };
  }).filter(Boolean);
}
function primaryCenterline() {
  const obs = allObservationLines();
  if (obs.length) return obs[0];
  for (const ov of overlays) {
    if (ov.hidden) continue;
    const lines = featureLines(ov);
    if (lines.length) return lines[0];
  }
  return null;
}
function centerlineXY(line, proj) {
  const pts = line.coords.map(([mx, my]) => mercToXY(proj, mx, my));
  const segs = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    segs.push({ a, b, len, start: total, tx: dx / len, ty: dy / len });
    total += len;
  }
  return { segs, total };
}
function stationPoint(line, proj, station, startStation, reverseStationing = false) {
  const chain = centerlineXY(line, proj);
  let dist = station - startStation;
  if (reverseStationing) dist = chain.total - dist;
  if (!chain.segs.length || dist < -1e-6 || dist > chain.total + 1e-6) return null;
  const clamped = Math.max(0, Math.min(chain.total, dist));
  const seg = chain.segs.find((s) => clamped <= s.start + s.len + 1e-6) || chain.segs[chain.segs.length - 1];
  const f = Math.max(0, Math.min(1, (clamped - seg.start) / seg.len));
  return {
    x: seg.a[0] + (seg.b[0] - seg.a[0]) * f,
    y: seg.a[1] + (seg.b[1] - seg.a[1]) * f,
    tx: seg.tx,
    ty: seg.ty,
    centerlineLength: chain.total,
  };
}
function eventRank(label) {
  if (/2\s*[-_ ]?\s*y/i.test(label)) return 0;
  if (/100/i.test(label) && !/2080/i.test(label)) return 1;
  if (/500/i.test(label)) return 2;
  if (/2080/i.test(label)) return 3;
  return 10;
}
function crossEventLabel(name) {
  const s = runLabel(name).replace(/^FHD[_\s-]*/i, "").replace(/_/g, " ").trim();
  if (/2080/i.test(s) && /100/i.test(s)) return "2080 100-year";
  if (/2\s*Y/i.test(s) || /\b2\b/i.test(s)) return "2-year";
  if (/500/i.test(s)) return "500-year";
  if (/100/i.test(s)) return "100-year";
  return s || runLabel(name);
}
function crossEventStyle(label) {
  if (/2-year/i.test(label)) return { color: "#2c7bc9", dash: [], width: 2.1 };
  if (/100-year/i.test(label) && !/2080/i.test(label)) return { color: "#2fbf5f", dash: [], width: 2.1 };
  if (/500-year/i.test(label)) return { color: "#d336ff", dash: [12, 8], width: 2.0 };
  if (/2080/i.test(label)) return { color: "#f5a623", dash: [12, 8], width: 2.0 };
  return { color: "#6b7280", dash: [], width: 1.8 };
}
function proposedCrossEvents() {
  return allRunOptions("PR").map((opt) => {
    const wseParam = findParam(opt.run, /Water_?Elev/i);
    if (!wseParam) return null;
    const label = crossEventLabel(opt.run.name);
    return { ...opt, wseParam, label, ...crossEventStyle(label), rank: eventRank(label) };
  }).filter(Boolean).sort((a, b) => a.rank - b.rank || a.idx - b.idx);
}
function buildCrossSectionRow(sta, line, prCond, events, culverts) {
  const startStation = parseFloat($("xsStartStation").value) || 0;
  const width = Math.max(5, parseFloat($("xsWidth").value) || 60);
  const spacing = Math.max(0.5, parseFloat($("xsSpacing").value) || 1);
  const center = stationPoint(line, prCond.proj, sta.station, startStation, $("xsReverseStationing").checked);
  if (!center) throw new Error(`${sta.label} is outside the centerline station range.`);
  let nx = -center.ty, ny = center.tx;
  if ($("xsFlip").checked) { nx *= -1; ny *= -1; }
  const steps = Math.max(2, Math.ceil(width / spacing));
  const eventValues = events.map((ev) => ({ ev, values: scalarValues(ev, ev.wseParam) }));
  const samples = [];
  for (let i = 0; i <= steps; i++) {
    const along = i / steps * width;
    const off = along - width / 2;
    const x = center.x + nx * off;
    const y = center.y + ny * off;
    const idx = nearestNodeXY(prCond.proj, x, y);
    const wse = {};
    for (const item of eventValues) wse[item.ev.label] = idx >= 0 ? item.values[idx] : null;
    samples.push({
      x: along,
      ground: idx >= 0 ? prCond.proj.z[idx] : null,
      wse,
    });
  }
  const nearCulverts = culverts.filter((c) => Math.abs(c.station - sta.station) < 0.51);
  return { station: sta.station, label: sta.label, width, samples, events, culverts: nearCulverts };
}
function generateCrossSections() {
  const prCond = conditions.get("PR");
  if (!prCond?.proj || !prCond?.datasets) return msg("Load Proposed geometry and datasets before generating cross sections.", "warn");
  const line = primaryCenterline();
  if (!line) return msg("Add a centerline shapefile or observation line before generating cross sections.", "warn");
  const stations = stationListFromControls();
  if (!stations.length) return msg("Enter cross-section stations, or paste an SMS Summary Table with station rows.", "warn");
  const events = proposedCrossEvents();
  if (!events.length) return msg("Proposed datasets need Water_Elev_ft runs for cross sections.", "warn");
  const culverts = parseCrossSectionCulverts();
  try {
    crossRows = stations.map((sta) => buildCrossSectionRow(sta, line, prCond, events, culverts));
    renderCrossSections();
    switchView("crossSections");
    msg(`Generated ${crossRows.length} proposed-condition cross section${crossRows.length === 1 ? "" : "s"}.`, "ok");
  } catch (err) {
    msg(err.message, "err");
  }
}
function fillBetweenSeries(ctx, samples, xTo, yTo, topFn, bottomFn, fillStyle) {
  let chunk = [];
  const flush = () => {
    if (chunk.length < 2) { chunk = []; return; }
    ctx.beginPath();
    chunk.forEach((p, i) => { i ? ctx.lineTo(xTo(p.x), yTo(p.top)) : ctx.moveTo(xTo(p.x), yTo(p.top)); });
    for (let i = chunk.length - 1; i >= 0; i--) ctx.lineTo(xTo(chunk[i].x), yTo(chunk[i].bottom));
    ctx.closePath();
    ctx.fillStyle = fillStyle;
    ctx.fill();
    chunk = [];
  };
  for (const s of samples) {
    const top = topFn(s), bottom = bottomFn(s);
    if (VALID(top) && VALID(bottom) && top > bottom) chunk.push({ x: s.x, top, bottom });
    else flush();
  }
  flush();
}
function drawSeries(ctx, samples, xTo, yTo, valueFn, style) {
  ctx.save();
  ctx.strokeStyle = style.color;
  ctx.lineWidth = style.width || 2;
  ctx.setLineDash(style.dash || []);
  ctx.beginPath();
  let open = false;
  for (const s of samples) {
    const v = valueFn(s);
    if (!VALID(v)) { open = false; continue; }
    const x = xTo(s.x), y = yTo(v);
    if (!open) { ctx.moveTo(x, y); open = true; }
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}
function renderCrossSectionChart(canvas, row) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  const P = { l: 72, r: 32, t: 38, b: 70 };
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);
  const vals = [];
  row.samples.forEach((s) => {
    vals.push(s.ground);
    row.events.forEach((ev) => vals.push(s.wse[ev.label]));
  });
  row.culverts.forEach((c) => vals.push(c.bottom, c.bottom + c.height));
  const valid = vals.filter(VALID);
  const yb = niceBounds(Math.min(...valid), Math.max(...valid), 7);
  const xTo = (x) => P.l + x / row.width * (W - P.l - P.r);
  const yTo = (y) => H - P.b - (y - yb.min) / (yb.max - yb.min || 1) * (H - P.t - P.b);
  ctx.strokeStyle = "#e1e5ea";
  ctx.lineWidth = 1;
  ctx.font = "16px Arial";
  ctx.fillStyle = "#5f6672";
  for (let y = yb.min; y <= yb.max + 1e-9; y += yb.step) {
    const py = yTo(y);
    ctx.beginPath(); ctx.moveTo(P.l, py); ctx.lineTo(W - P.r, py); ctx.stroke();
    ctx.fillText(y.toFixed(Math.abs(y) >= 100 ? 0 : 1), 18, py + 5);
  }
  const xb = niceBounds(0, row.width, 6);
  for (let x = xb.min; x <= row.width + 1e-9; x += xb.step) {
    if (x < -1e-9) continue;
    const px = xTo(x);
    ctx.beginPath(); ctx.moveTo(px, P.t); ctx.lineTo(px, H - P.b); ctx.stroke();
    ctx.fillText(String(Math.round(x)), px - 8, H - P.b + 28);
  }
  ctx.strokeStyle = "#222";
  ctx.lineWidth = 1.2;
  ctx.strokeRect(P.l, P.t, W - P.l - P.r, H - P.t - P.b);

  ctx.fillStyle = "rgba(202, 176, 130, 0.20)";
  ctx.beginPath();
  row.samples.forEach((s, i) => { i ? ctx.lineTo(xTo(s.x), yTo(s.ground)) : ctx.moveTo(xTo(s.x), yTo(s.ground)); });
  ctx.lineTo(xTo(row.width), H - P.b);
  ctx.lineTo(xTo(0), H - P.b);
  ctx.closePath();
  ctx.fill();
  const fillEvent = row.events.find((ev) => /2-year/i.test(ev.label)) || row.events[0];
  if (fillEvent) fillBetweenSeries(ctx, row.samples, xTo, yTo, (s) => s.wse[fillEvent.label], (s) => s.ground, "rgba(96, 164, 224, 0.25)");

  drawSeries(ctx, row.samples, xTo, yTo, (s) => s.ground, { color: "#7b5b35", width: 2.4, dash: [] });
  row.events.forEach((ev) => drawSeries(ctx, row.samples, xTo, yTo, (s) => s.wse[ev.label], ev));

  ctx.save();
  ctx.strokeStyle = "#111";
  ctx.lineWidth = 2;
  row.culverts.forEach((c) => {
    ctx.strokeRect(xTo(c.left), yTo(c.bottom + c.height), xTo(c.left + c.width) - xTo(c.left), yTo(c.bottom) - yTo(c.bottom + c.height));
  });
  ctx.restore();

  const groundSamples = row.samples.filter((s) => VALID(s.ground));
  const thalweg = groundSamples.reduce((best, s) => !best || s.ground < best.ground ? s : best, null);
  if (thalweg) {
    const tx = xTo(thalweg.x), ty = yTo(thalweg.ground);
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#7b5b35";
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(tx, ty, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.font = "16px Arial";
    ctx.fillStyle = "#555";
    ctx.fillText(`Thalweg ${thalweg.ground.toFixed(2)}`, tx + 8, ty + 18);
  }

  drawCrossSectionLegend(ctx, row, W, P.t + 8);
  ctx.font = "18px Arial";
  ctx.fillStyle = "#333";
  ctx.textAlign = "center";
  ctx.fillText("Distance (feet)", W / 2, H - 22);
  ctx.save();
  ctx.translate(24, H / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("Elevation (feet, NAVD88)", 0, 0);
  ctx.restore();
  ctx.textAlign = "left";
  ctx.font = "16px Arial";
  const note = "Cross Section is looking downstream";
  const nw = ctx.measureText(note).width + 12;
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.strokeStyle = "#c8ced6";
  ctx.fillRect(P.l + 8, H - P.b - 30, nw, 26);
  ctx.strokeRect(P.l + 8, H - P.b - 30, nw, 26);
  ctx.fillStyle = "#333";
  ctx.fillText(note, P.l + 14, H - P.b - 11);
}
function drawCrossSectionLegend(ctx, row, W, y) {
  const items = [["Proposed Ground", "#7b5b35", [], 2.4]].concat(row.events.map((ev) => [ev.label, ev.color, ev.dash, ev.width]));
  if (row.culverts.length) items.push(["Culvert", "#111", [], 2]);
  const x = W - 300, h = 27 * items.length + 14;
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.90)";
  ctx.strokeStyle = "#c8ced6";
  ctx.fillRect(x, y, 270, h);
  ctx.strokeRect(x, y, 270, h);
  ctx.font = "16px Arial";
  items.forEach((it, i) => {
    const yy = y + 21 + i * 27;
    ctx.strokeStyle = it[1];
    ctx.lineWidth = it[3] || 2;
    ctx.setLineDash(it[2] || []);
    ctx.beginPath(); ctx.moveTo(x + 14, yy); ctx.lineTo(x + 52, yy); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#333";
    ctx.fillText(it[0], x + 62, yy + 5);
  });
  ctx.restore();
}
function renderCrossSections() {
  const host = $("crossSections");
  host.innerHTML = "";
  $("crossSectionsEmpty").hidden = crossRows.length > 0;
  crossRows.forEach((r, i) => {
    const card = document.createElement("div");
    card.className = "chart-card";
    card.innerHTML = `<div class="chart-head"><strong>Proposed Conditions, Cross Section at Station ${escapeHtml(r.label)}</strong><button type="button" class="ghost">Download PNG</button></div><canvas width="1300" height="772"></canvas>`;
    const cv = card.querySelector("canvas");
    renderCrossSectionChart(cv, r);
    card.querySelector("button").addEventListener("click", () => downloadCanvas(cv, `FRA_Cross_Section_${safeName(r.label)}.png`));
    host.appendChild(card);
  });
}

function generateCharts() {
  const exSel = selectedRun("existingRun");
  const prSel = selectedRun("proposedRun");
  if (!exSel || !prSel) return msg("Load Existing and Proposed H5 files and select runs first.", "warn");
  const lines = allObservationLines();
  if (!lines.length) return msg("Add observation lines before generating charts/table.", "warn");
  try {
    chartRows = lines.map((line) => profileForLine(line, exSel, prSel));
    renderCharts();
    renderSummaryTable();
    switchView("charts");
    msg(`Generated ${chartRows.length} observation-line chart${chartRows.length === 1 ? "" : "s"} and WSE table.`, "ok");
  } catch (err) {
    msg(err.message, "err");
  }
}
function renderCharts() {
  const host = $("charts");
  host.innerHTML = "";
  $("chartsEmpty").hidden = chartRows.length > 0;
  chartRows.forEach((r, i) => {
    const card = document.createElement("div");
    card.className = "chart-card";
    card.innerHTML = `<div class="chart-head"><strong>${escapeHtml(r.line.station || r.line.label)}</strong><button type="button" class="ghost">Download PNG</button></div><canvas width="1220" height="820"></canvas>`;
    const cv = card.querySelector("canvas");
    renderProfileChart(cv, r);
    card.querySelector("button").addEventListener("click", () => downloadCanvas(cv, `FRA_Observation_${i + 1}_${safeName(r.line.station || r.line.label)}.png`));
    host.appendChild(card);
  });
}
function renderSummaryTable() {
  $("tableEmpty").hidden = chartRows.length > 0;
  $("copyTable").disabled = $("downloadTable").disabled = chartRows.length === 0;
  if (!chartRows.length) { $("summaryTable").innerHTML = ""; return; }
  const rows = chartRows.map((r, i) => ({
    no: i + 1,
    label: r.line.label,
    station: r.line.station || "",
    ex: r.exAvg.value,
    pr: r.prAvg.value,
    diff: r.diff,
    method: r.method,
  }));
  $("summaryTable").innerHTML = `<table><thead><tr><th>No.</th><th>Observation line</th><th>Station</th><th>Existing WSE (ft)</th><th>Proposed WSE (ft)</th><th>Difference (ft)</th><th>Method</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${r.no}</td><td>${escapeHtml(r.label)}</td><td>${escapeHtml(r.station)}</td><td>${fmt(r.ex)}</td><td>${fmt(r.pr)}</td><td>${fmt(r.diff)}</td><td>${escapeHtml(r.method)}</td></tr>`).join("")}</tbody></table>`;
}
function tableCsv() {
  const lines = [["No","Observation line","Station","Existing WSE (ft)","Proposed WSE (ft)","Difference (ft)","Method"]];
  chartRows.forEach((r, i) => lines.push([i + 1, r.line.label, r.line.station || "", fmt(r.exAvg.value), fmt(r.prAvg.value), fmt(r.diff), r.method]));
  return lines.map((row) => row.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
}
const fmt = (v) => v == null || !isFinite(v) ? "" : Number(v).toFixed(2);
const safeName = (s) => String(s || "figure").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "figure";
function downloadCanvas(cv, name) {
  const a = document.createElement("a");
  a.download = name;
  a.href = cv.toDataURL("image/png");
  a.click();
}
function downloadText(text, name, type = "text/plain") {
  const a = document.createElement("a");
  a.download = name;
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function switchView(view) {
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
  $(`${view}Panel`).classList.add("active");
}

function beginDrawingLine() {
  if (!scene) return msg("Generate a map first, then draw observation lines on it.", "warn");
  drawingLine = { start: null };
  $("mapCanvas").classList.add("drawing");
  switchView("map");
  msg("Click the map for the line start, then click again for the line end.", "ok");
}
async function handleMapClick(e) {
  const cv = $("mapCanvas");
  if (cv.hidden || !scene) return;
  const rect = cv.getBoundingClientRect();
  const f = frame();
  const x = (e.clientX - rect.left) * (cv.width / rect.width);
  const y = (e.clientY - rect.top) * (cv.height / rect.height);
  const view = makeView(commonBbox(), f);
  const m = view.screenToMerc(x, y);
  if (placingAnno != null) {
    const a = annotations.find((item) => item.id === placingAnno);
    if (a) { a.ax = m.x; a.ay = m.y; a.ox = 0; a.oy = 0; }
    placingAnno = null;
    cv.classList.remove("placing");
    renderAnnoList();
    await renderMap();
    return;
  }
  if (drawingLine) {
    if (!drawingLine.start) {
      drawingLine.start = [m.x, m.y];
      msg("Line start set. Click the map for the line end.", "ok");
    } else {
      const id = `m${++manualLineSeq}`;
      manualLines.push({ id, coords: [drawingLine.start, [m.x, m.y]], label: `Observation ${manualLineSeq}`, color: "#e00000" });
      drawingLine = null;
      cv.classList.remove("drawing");
      renderLineList();
      await renderMap();
      msg("Observation line added.", "ok");
    }
  }
}

function addAnnotation(type) {
  const bb = commonBbox();
  const base = { id: ++annoSeq, type, ax: (bb.x0 + bb.x1) / 2, ay: (bb.y0 + bb.y1) / 2, ox: 0, oy: 0, visible: true, open: true };
  annotations.unshift(type === "arrow"
    ? { ...base, color: "#ff2b20", length: 150, angle: 0, thickness: 5 }
    : { ...base, color: "#111111", text: "Label", fontSize: 28, halo: true });
  renderAnnoList();
  if (scene) renderMap();
}
function addBulkLabels(csv) {
  const labels = (csv || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!labels.length) return msg("Type one or more labels separated by commas.", "warn");
  const bb = commonBbox();
  labels.reverse().forEach((text, i) => {
    annotations.unshift({ id: ++annoSeq, type: "label", ax: (bb.x0 + bb.x1) / 2, ay: (bb.y0 + bb.y1) / 2, ox: i * 18, oy: i * 18, visible: true, open: false, color: "#111111", text, fontSize: 28, halo: true });
  });
  $("bulkLabels").value = "";
  renderAnnoList();
  if (scene) renderMap();
}
function renderAnnoList() {
  const host = $("annoList");
  host.innerHTML = "";
  $("annoEmpty").hidden = annotations.length > 0;
  annotations.forEach((a, i) => {
    const li = document.createElement("li");
    li.className = "anno-card";
    const isArrow = a.type === "arrow";
    li.innerHTML = `
      <div class="anno-head">
        <input class="anno-vis" type="checkbox" ${a.visible === false ? "" : "checked"} />
        <input class="anno-color" type="color" value="${a.color}" />
        <strong>${isArrow ? "Arrow" : escapeHtml(a.text || "Label")}</strong>
        <button class="anno-toggle mini" type="button">${a.open ? "Hide" : "Edit"}</button>
        <button class="anno-del mini" type="button">Delete</button>
      </div>
      <div class="anno-body"${a.open ? "" : " hidden"}>
        ${isArrow ? `
          <div class="row2">
            <label class="inline">Length <input class="anno-len" type="number" value="${a.length}" step="10" /></label>
            <label class="inline">Angle <input class="anno-ang" type="number" value="${a.angle}" step="5" /></label>
          </div>
          <label class="inline">Thickness <input class="anno-th" type="number" value="${a.thickness}" step="1" min="1" /></label>`
        : `
          <label>Text <input class="anno-text" type="text" value="${escapeAttr(a.text || "")}" /></label>
          <div class="row2">
            <label class="inline">Size <input class="anno-font" type="number" value="${a.fontSize}" step="1" min="6" /></label>
            <label class="chk"><input class="anno-halo" type="checkbox" ${a.halo ? "checked" : ""} /> Halo</label>
          </div>`}
        <div class="ctrl-row">
          <button class="anno-place mini" type="button">Place on map</button>
          <button class="nL mini" type="button">Left</button>
          <button class="nR mini" type="button">Right</button>
          <button class="nU mini" type="button">Up</button>
          <button class="nD mini" type="button">Down</button>
        </div>
      </div>`;
    const update = async () => { renderAnnoList(); if (scene) await renderMap(); };
    li.querySelector(".anno-vis").addEventListener("change", async (e) => { a.visible = e.target.checked; if (scene) await renderMap(); });
    li.querySelector(".anno-color").addEventListener("input", async (e) => { a.color = e.target.value; if (scene) await renderMap(); });
    li.querySelector(".anno-toggle").addEventListener("click", () => { a.open = !a.open; renderAnnoList(); });
    li.querySelector(".anno-del").addEventListener("click", async () => { annotations.splice(i, 1); await update(); });
    li.querySelector(".anno-place").addEventListener("click", () => { placingAnno = a.id; $("mapCanvas").classList.add("placing"); switchView("map"); msg("Click the map to place this item.", "ok"); });
    li.querySelector(".nL").addEventListener("click", async () => { a.ox -= ANNO_NUDGE; if (scene) await renderMap(); });
    li.querySelector(".nR").addEventListener("click", async () => { a.ox += ANNO_NUDGE; if (scene) await renderMap(); });
    li.querySelector(".nU").addEventListener("click", async () => { a.oy -= ANNO_NUDGE; if (scene) await renderMap(); });
    li.querySelector(".nD").addEventListener("click", async () => { a.oy += ANNO_NUDGE; if (scene) await renderMap(); });
    if (isArrow) {
      li.querySelector(".anno-len").addEventListener("input", async (e) => { a.length = parseFloat(e.target.value) || a.length; if (scene) await renderMap(); });
      li.querySelector(".anno-ang").addEventListener("input", async (e) => { a.angle = parseFloat(e.target.value) || 0; if (scene) await renderMap(); });
      li.querySelector(".anno-th").addEventListener("input", async (e) => { a.thickness = parseFloat(e.target.value) || a.thickness; if (scene) await renderMap(); });
    } else {
      li.querySelector(".anno-text").addEventListener("input", async (e) => { a.text = e.target.value; if (scene) await renderMap(); });
      li.querySelector(".anno-font").addEventListener("input", async (e) => { a.fontSize = parseFloat(e.target.value) || a.fontSize; if (scene) await renderMap(); });
      li.querySelector(".anno-halo").addEventListener("change", async (e) => { a.halo = e.target.checked; if (scene) await renderMap(); });
    }
    host.appendChild(li);
  });
}
function renderMapElementControls() {
  const host = $("mapElementPositions");
  if (!host) return;
  host.innerHTML = "";
  const defaults = defaultMapElementPositions();
  MAP_ELEMENT_CONFIG.forEach((cfg) => {
    const pos = { ...defaults[cfg.key], ...(mapElementPos[cfg.key] || {}) };
    const card = document.createElement("div");
    card.className = "map-pos-card";
    card.innerHTML = `
      <div class="map-pos-head">
        <strong>${escapeHtml(cfg.label)}</strong>
        <button class="mini map-pos-reset" type="button">Reset</button>
      </div>
      <label>Anchor
        <select class="map-pos-anchor">
          ${ANCHORS.map(([value, label]) => `<option value="${value}"${value === pos.anchor ? " selected" : ""}>${label}</option>`).join("")}
        </select>
      </label>
      <div class="map-pos-nudges">
        <button class="mini map-pos-nudge" type="button" data-dx="-20" data-dy="0">Left</button>
        <button class="mini map-pos-nudge" type="button" data-dx="20" data-dy="0">Right</button>
        <button class="mini map-pos-nudge" type="button" data-dx="0" data-dy="-20">Up</button>
        <button class="mini map-pos-nudge" type="button" data-dx="0" data-dy="20">Down</button>
        <span class="map-pos-offset">x ${Math.round(pos.offX || 0)}, y ${Math.round(pos.offY || 0)}</span>
      </div>`;
    const apply = async () => { renderMapElementControls(); if (scene) await renderMap(); };
    card.querySelector(".map-pos-anchor").addEventListener("change", async (e) => {
      mapElementPos[cfg.key] = { ...pos, anchor: e.target.value };
      await apply();
    });
    card.querySelector(".map-pos-reset").addEventListener("click", async () => {
      mapElementPos[cfg.key] = { ...defaults[cfg.key] };
      await apply();
    });
    card.querySelectorAll(".map-pos-nudge").forEach((btn) => btn.addEventListener("click", async () => {
      const cur = { ...defaults[cfg.key], ...(mapElementPos[cfg.key] || {}) };
      mapElementPos[cfg.key] = {
        ...cur,
        offX: (cur.offX || 0) + parseFloat(btn.dataset.dx || "0"),
        offY: (cur.offY || 0) + parseFloat(btn.dataset.dy || "0"),
      };
      await apply();
    }));
    host.appendChild(card);
  });
}

const LEGEND_VALUE_IDS = [
  "legendFont",
  "diffLegendAbs", "diffLegendStep",
  "topoLegendMin", "topoLegendMax", "topoLegendStep", "topoLegendRamp",
  "wseLegendMin", "wseLegendMax", "wseLegendStep", "wseLegendRamp",
  "wetDryWetColor", "wetDryDryColor",
];
function initLegendRampSelects() {
  for (const [id, def] of [["topoLegendRamp", "topography"], ["wseLegendRamp", "waterSurface"]]) {
    const el = $(id);
    if (!el) continue;
    el.innerHTML = RAMP_OPTIONS.map(([key, label]) => `<option value="${key}">${escapeHtml(label)}</option>`).join("");
    el.value = def;
  }
}
function resetLegendScales() {
  for (const id of LEGEND_VALUE_IDS) {
    const el = $(id);
    if (!el) continue;
    if (id === "legendFont") el.value = "18";
    else if (id === "topoLegendRamp") el.value = "topography";
    else if (id === "wseLegendRamp") el.value = "waterSurface";
    else if (id === "wetDryWetColor") el.value = "#28c985";
    else if (id === "wetDryDryColor") el.value = "#ee7e6f";
    else el.value = "";
  }
  if (scene) renderMap();
}

function projectState() {
  return {
    version: 1,
    overlays, manualLines, lineOverrides, annotations, annoSeq, manualLineSeq, overlaySeq,
    controls: {
      orientation: $("orientation").value, figureType: $("figureType").value, dryDepth: $("dryDepth").value,
      contourInterval: $("contourInterval").value, contourColor: $("contourColor").value, showWetDry: $("showWetDry").checked,
      showContours: $("showContours").checked, titleText: $("titleText").value,
      showTitle: $("showTitle").checked, showLegend: $("showLegend").checked, showNorth: $("showNorth").checked,
      showScale: $("showScale").checked, showOverlays: $("showOverlays").checked, showAnnos: $("showAnnos").checked,
      xsStations: $("xsStations").value, xsStartStation: $("xsStartStation").value, xsWidth: $("xsWidth").value,
      xsSpacing: $("xsSpacing").value, xsFlip: $("xsFlip").checked, xsReverseStationing: $("xsReverseStationing").checked,
      xsCulverts: $("xsCulverts").value,
      legendFont: $("legendFont").value, diffLegendAbs: $("diffLegendAbs").value, diffLegendStep: $("diffLegendStep").value,
      topoLegendMin: $("topoLegendMin").value, topoLegendMax: $("topoLegendMax").value, topoLegendStep: $("topoLegendStep").value, topoLegendRamp: $("topoLegendRamp").value,
      wseLegendMin: $("wseLegendMin").value, wseLegendMax: $("wseLegendMax").value, wseLegendStep: $("wseLegendStep").value, wseLegendRamp: $("wseLegendRamp").value,
      wetDryWetColor: $("wetDryWetColor").value, wetDryDryColor: $("wetDryDryColor").value,
      mapElementPos,
      rotDeg, zoom, panX, panY,
    },
    summaryPaste: $("summaryPaste").value,
  };
}
function saveProject() {
  downloadText(JSON.stringify(projectState(), null, 2), "FRA_Figure_Project.frafig", "application/json");
}
async function loadProjectFile(file) {
  try {
    const data = JSON.parse(await file.text());
    overlays = Array.isArray(data.overlays) ? data.overlays : [];
    manualLines = Array.isArray(data.manualLines) ? data.manualLines : [];
    lineOverrides = data.lineOverrides || {};
    annotations = Array.isArray(data.annotations) ? data.annotations : [];
    annoSeq = data.annoSeq || 0;
    manualLineSeq = data.manualLineSeq || 0;
    overlaySeq = data.overlaySeq || overlays.reduce((m, o) => Math.max(m, o.id || 0), 0);
    $("summaryPaste").value = data.summaryPaste || "";
    const c = data.controls || {};
    for (const id of ["orientation", "figureType", "dryDepth", "contourInterval", "contourColor", "titleText", "xsStations", "xsStartStation", "xsWidth", "xsSpacing", "xsCulverts", ...LEGEND_VALUE_IDS]) if (id in c) $(id).value = c[id];
    for (const id of ["showWetDry", "showContours", "showTitle", "showLegend", "showNorth", "showScale", "showOverlays", "showAnnos", "xsFlip", "xsReverseStationing"]) if (id in c) $(id).checked = !!c[id];
    mapElementPos = { ...defaultMapElementPositions(), ...(c.mapElementPos || {}) };
    rotDeg = c.rotDeg || 0; zoom = c.zoom || 1; panX = c.panX || 0; panY = c.panY || 0; $("rot").value = rotDeg;
    renderOverlayList(); renderLineList(); renderAnnoList(); renderMapElementControls();
    if (scene) await renderMap();
    msg("Project loaded. Re-drop H5 files if needed to rebuild figures.", "ok");
  } catch (err) {
    msg(`Could not load project: ${err.message}`, "err");
  }
}

initLegendRampSelects();
wireDropzone("dropH5", "h5Files", ingestH5Files, /\.h5$/i);
wireDropzone("dropOverlay", "overlayFiles", ingestOverlayFiles, /\.zip$/i);
$("generateMap").addEventListener("click", generateMap);
$("generateCharts").addEventListener("click", generateCharts);
$("generateCrossSections").addEventListener("click", generateCrossSections);
$("downloadMap").addEventListener("click", () => downloadCanvas($("mapCanvas"), `FRA_${safeName(scene?.type || "map")}.png`));
$("drawLine").addEventListener("click", beginDrawingLine);
$("applyStations").addEventListener("click", applyStationLabels);
$("mapCanvas").addEventListener("click", handleMapClick);
$("copyTable").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(tableCsv());
    msg("Table copied to clipboard.", "ok");
  } catch {
    downloadText(tableCsv(), "FRA_WSE_Comparison_Table.csv", "text/csv");
    msg("Clipboard access was blocked, so the table was downloaded as CSV.", "warn");
  }
});
$("downloadTable").addEventListener("click", () => downloadText(tableCsv(), "FRA_WSE_Comparison_Table.csv", "text/csv"));
$("saveProject").addEventListener("click", saveProject);
$("loadProject").addEventListener("click", () => $("projectFile").click());
$("projectFile").addEventListener("change", (e) => { if (e.target.files[0]) loadProjectFile(e.target.files[0]); e.target.value = ""; });
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));
$("addLabel").addEventListener("click", () => addAnnotation("label"));
$("addArrow").addEventListener("click", () => addAnnotation("arrow"));
$("addBulkLabels").addEventListener("click", () => addBulkLabels($("bulkLabels").value));
$("bulkLabels").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addBulkLabels($("bulkLabels").value); } });
$("resetMapElements").addEventListener("click", () => {
  mapElementPos = defaultMapElementPositions();
  renderMapElementControls();
  if (scene) renderMap();
});
$("resetLegendScales").addEventListener("click", resetLegendScales);

for (const id of ["orientation", "figureType", "dryDepth", "contourInterval", "contourColor", "showWetDry", "showContours", "showTitle", "showLegend", "showNorth", "showScale", "showOverlays", "showAnnos", "titleText", ...LEGEND_VALUE_IDS]) {
  $(id).addEventListener("input", () => scene && renderMap());
  $(id).addEventListener("change", () => scene && renderMap());
}
$("rot").addEventListener("input", () => { rotDeg = parseFloat($("rot").value) || 0; scene && renderMap(); });
$("rotCCW").addEventListener("click", () => { rotDeg -= 90; $("rot").value = rotDeg; scene && renderMap(); });
$("rotCW").addEventListener("click", () => { rotDeg += 90; $("rot").value = rotDeg; scene && renderMap(); });
$("zoomIn").addEventListener("click", () => { zoom *= 1.18; scene && renderMap(); });
$("zoomOut").addEventListener("click", () => { zoom /= 1.18; scene && renderMap(); });
$("panU").addEventListener("click", () => { panY -= 60; scene && renderMap(); });
$("panD").addEventListener("click", () => { panY += 60; scene && renderMap(); });
$("panL").addEventListener("click", () => { panX -= 60; scene && renderMap(); });
$("panR").addEventListener("click", () => { panX += 60; scene && renderMap(); });
$("viewReset").addEventListener("click", () => { rotDeg = 0; zoom = 1; panX = 0; panY = 0; $("rot").value = 0; scene && renderMap(); });
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  drawingLine = null;
  placingAnno = null;
  $("mapCanvas").classList.remove("drawing", "placing");
});

refreshH5Status();
renderOverlayList();
renderLineList();
renderAnnoList();
renderMapElementControls();
