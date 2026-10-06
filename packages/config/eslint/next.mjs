import nextVitals from "eslint-config-next/core-web-vitals";
import react from "./react.mjs";

// Next d'abord, puis nos configs : le parser typescript-eslint (type-aware)
// doit passer après celui de eslint-config-next pour l'emporter.
export default [...nextVitals, ...react];
