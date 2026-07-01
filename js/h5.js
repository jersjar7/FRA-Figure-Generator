// Read SRH-2D XMDF exports. Environment-agnostic: the caller opens the file with
// h5wasm (node or browser) and passes the File object in. Node order is identical
// across the geometry and datasets files, so Values[t][i] ↔ node i.

// ---- geometry .h5 (the "Mesh as h5" export) ----
// Returns { meshName, N, xy:Float64[2N], z:Float32[N], tris:Uint32[3T], wkt }.
function hasMeshGeometry(file, base) {
  try {
    const nodes = file.get(`${base}/Nodes/NodeLocs`);
    const elems = file.get(`${base}/Elements/Nodeids`);
    return nodes.shape?.[1] >= 2 && elems.shape?.[1] >= 3;
  } catch {
    return false;
  }
}

function findMeshGroup(file) {
  const mm = file.get("2DMeshModule");
  return mm.keys().find((k) => hasMeshGeometry(file, `2DMeshModule/${k}`));
}

export function readGeometry(file) {
  const meshName = findMeshGroup(file);
  if (!meshName) throw new Error("No mesh group with Nodes/NodeLocs and Elements/Nodeids found — is this the mesh-geometry .h5?");
  const base = `2DMeshModule/${meshName}`;

  const nl = file.get(`${base}/Nodes/NodeLocs`);
  const N = nl.shape[0];
  const locs = nl.value; // flattened N×3 (x,y,z)
  const xy = new Float64Array(N * 2), z = new Float32Array(N);
  for (let i = 0; i < N; i++) { xy[i * 2] = locs[i * 3]; xy[i * 2 + 1] = locs[i * 3 + 1]; z[i] = locs[i * 3 + 2]; }

  // Elements: node ids are 1-based, padded with -1 (triangles in a 4-wide table).
  const el = file.get(`${base}/Elements/Nodeids`);
  const ev = el.value, M = el.shape[0], W = el.shape[1];
  const tris = [];
  for (let e = 0; e < M; e++) {
    const v = [];
    for (let k = 0; k < W; k++) { const id = ev[e * W + k]; if (id > 0) v.push(id - 1); }
    if (v.length >= 3) { tris.push(v[0], v[1], v[2]); if (v.length === 4) tris.push(v[0], v[2], v[3]); }
  }

  let wkt = null;
  try { wkt = String(file.get(`${base}/Coordinates`).attrs.WKT.value); } catch { /* no CRS */ }

  return { meshName, N, xy, z, tris: new Uint32Array(tris), wkt };
}

export function isGeometryFile(file) {
  try { return !!findMeshGroup(file); }
  catch { return false; }
}

// ---- datasets .h5 (the "export all datasets" export) ----
// Returns { runs:[{ name, params:{ <Param>: {shape, scalar:bool} } }] }. Values are
// read lazily (final timestep) via finalTimestep() to avoid loading every step.
export function readDatasets(file) {
  const ds = file.get("Datasets");
  const runs = [];
  for (const name of ds.keys()) {
    if (name === "Z" || name === "Guid") continue;
    const g = file.get(`Datasets/${name}`);
    if (!g.keys) continue;
    const params = {};
    for (const p of g.keys()) {
      const pg = file.get(`Datasets/${name}/${p}`);
      if (!pg.keys || !pg.keys().includes("Values")) continue;
      const shape = file.get(`Datasets/${name}/${p}/Values`).shape;
      params[p] = { shape, vector: shape.length === 3 }; // Velocity_* is N×2 vector
    }
    if (Object.keys(params).length) runs.push({ name, params });
  }
  return { runs };
}

export function isDatasetsFile(file) {
  try { return file.get("Datasets").keys().some((k) => k !== "Z" && k !== "Guid"); }
  catch { return false; }
}

// Final (converged) timestep of one scalar param → Float32Array(N).
export function finalTimestep(file, runName, paramName) {
  const d = file.get(`Datasets/${runName}/${paramName}/Values`);
  const [T, N] = d.shape;
  const all = d.value; // flattened T×N
  return all.slice((T - 1) * N, T * N);
}

// Final-timestep velocity vector → { vx:Float32[N], vy:Float32[N] } for flow arrows.
export function finalVector(file, runName, paramName) {
  const d = file.get(`Datasets/${runName}/${paramName}/Values`);
  const [T, N] = d.shape; // T×N×2
  const all = d.value;
  const off = (T - 1) * N * 2;
  const vx = new Float32Array(N), vy = new Float32Array(N);
  for (let i = 0; i < N; i++) { vx[i] = all[off + i * 2]; vy[i] = all[off + i * 2 + 1]; }
  return { vx, vy };
}

// SMS no-data / dry sentinel.
export const NODATA = -999;
