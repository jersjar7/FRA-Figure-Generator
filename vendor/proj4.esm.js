// ESM shim over the vendored proj4 UMD build: running it as a module attaches
// `proj4` to the global, which we re-export as the default. Keeps js/geo.js's
// `import proj4 from "proj4"` working in the browser (via the import map) and in
// Node (via node_modules) with the same source.
import "./proj4.js";
export default globalThis.proj4;
