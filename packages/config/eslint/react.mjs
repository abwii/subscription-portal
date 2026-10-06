import reactHooks from "eslint-plugin-react-hooks";
import base from "./base.mjs";

export default [
  ...base,
  reactHooks.configs.flat.recommended,
];
