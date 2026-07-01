// Parsers for the two SMS clipboard pastes.

const NODATA = -9999;

// Split a pasted line into cells. Real SMS clipboard data is tab-delimited,
// which preserves empty cells. We fall back to whitespace runs if no tabs
// are present (e.g. data hand-pasted from a non-tab source).
function splitCells(line) {
  if (line.includes("\t")) return line.split("\t");
  return line.trim().split(/\s{2,}|\s+/);
}

const isNum = (s) => s !== undefined && s !== null && s !== "" && !isNaN(Number(s));

/**
 * Parse the "View Values" profile paste into an ordered list of dataset
 * columns. Each dataset = one {dist:[], val:[]} pair, blanks and -9999 removed.
 * The leading row-index column (1,2,3,...) is detected and dropped.
 */
export function parseProfile(text, { keepGaps = false } = {}) {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim() !== "");
  if (!lines.length) return { pairs: [], warnings: ["No data found."] };

  const warnings = [];
  const rows = lines.map(splitCells);

  // Drop a header row if the first row has no numeric data cells
  // (e.g. "Distance Value Distance Value ...").
  let start = 0;
  if (!rows[0].some(isNum)) start = 1;

  // Determine the widest row to know the column count.
  let maxCols = 0;
  for (let i = start; i < rows.length; i++) maxCols = Math.max(maxCols, rows[i].length);

  // Detect & drop a leading index column: present when (cols - 1) is even and
  // the first column counts up 1,2,3...
  let firstDataCol = 0;
  const firstColLooksLikeIndex =
    rows[start] && Number(rows[start][0]) === 1 && (maxCols - 1) % 2 === 0;
  if (firstColLooksLikeIndex) {
    firstDataCol = 1;
    maxCols -= 1;
  }
  if (maxCols % 2 !== 0) {
    warnings.push(`Odd number of data columns (${maxCols}); expected Distance/Value pairs.`);
    maxCols -= maxCols % 2;
  }

  const nPairs = maxCols / 2;
  const pairs = Array.from({ length: nPairs }, () => ({ dist: [], val: [] }));

  for (let r = start; r < rows.length; r++) {
    const row = rows[r];
    for (let p = 0; p < nPairs; p++) {
      const dCell = row[firstDataCol + p * 2];
      const vCell = row[firstDataCol + p * 2 + 1];
      if (!isNum(dCell) || !isNum(vCell)) continue;
      const d = Number(dCell);
      const v = Number(vCell);
      if (d === NODATA) continue;
      if (v === NODATA) {
        // keepGaps: preserve the station with a null value so lines break here
        // (e.g. a water surface that goes dry under a culvert); else drop it.
        if (keepGaps) { pairs[p].dist.push(d); pairs[p].val.push(null); }
        continue;
      }
      pairs[p].dist.push(d);
      pairs[p].val.push(v);
    }
  }

  // Drop trailing empty pairs (can appear from ragged paste width).
  while (pairs.length && pairs[pairs.length - 1].val.length === 0) pairs.pop();

  return { pairs, warnings };
}

/**
 * Parse the SMS Summary Table paste. Returns {rows:[{station, zmin}], warnings}.
 * Auto-detects the Station column (large, ~monotonic values) and the
 * Z-min column (elevation values). Non-numeric header rows are ignored.
 */
export function parseSummary(text) {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim() !== "");
  const warnings = [];
  const numericRows = [];
  for (const line of lines) {
    const cells = splitCells(line);
    const nums = cells.map((c) => (isNum(c) ? Number(c) : null));
    if (nums.some((n) => n !== null)) numericRows.push(nums);
  }
  if (!numericRows.length) return { rows: [], warnings: ["No numeric rows in summary table."] };

  const width = Math.max(...numericRows.map((r) => r.length));
  // Score each column: fraction numeric and average magnitude.
  const cols = [];
  for (let c = 0; c < width; c++) {
    const vals = numericRows.map((r) => r[c]).filter((v) => v !== null && v !== undefined);
    if (!vals.length) {
      cols.push(null);
      continue;
    }
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    cols.push({ c, count: vals.length, avg, vals });
  }
  const present = cols.filter((c) => c && c.count >= numericRows.length * 0.5);
  if (present.length < 2) {
    warnings.push("Could not find both Station and Z-min columns; check the paste.");
  }
  // Station = column with the largest average magnitude (stationing in feet).
  // Z-min = the next column (typically the elevation immediately after).
  const byMag = [...present].sort((a, b) => Math.abs(b.avg) - Math.abs(a.avg));
  const stationCol = byMag[0];
  // Prefer a Z column to the right of station; else the next-largest distinct.
  let zCol = present
    .filter((c) => c.c > (stationCol ? stationCol.c : -1))
    .sort((a, b) => a.c - b.c)[0];
  if (!zCol) zCol = byMag[1];

  const rows = [];
  for (const r of numericRows) {
    const station = stationCol ? r[stationCol.c] : null;
    const zmin = zCol ? r[zCol.c] : null;
    if (station === null || station === undefined) continue;
    rows.push({ station, zmin });
  }
  return { rows, warnings, stationCol: stationCol?.c, zCol: zCol?.c };
}

// Format a stationing value (feet) as "SS+FF".
export function formatStation(value, mode = "nearest") {
  let feet;
  if (mode === "up") feet = Math.ceil(value);
  else if (mode === "down") feet = Math.floor(value);
  else feet = Math.round(value);
  const sta = Math.floor(feet / 100);
  const plus = feet % 100;
  return `${sta}+${String(plus).padStart(2, "0")}`;
}
