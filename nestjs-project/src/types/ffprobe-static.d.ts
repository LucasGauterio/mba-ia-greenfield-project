// `ffprobe-static` ships no type declarations (its `index.js` only does
// `exports.path = ...`). Minimal shim for the single field the worker uses.
declare module 'ffprobe-static' {
  export const path: string;
}
