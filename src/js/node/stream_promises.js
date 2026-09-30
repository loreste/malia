// node:stream/promises — pipeline, finished, and consumers promise-based helpers.
export { pipeline, finished, consumers } from "node:stream";
import { pipeline, finished, consumers } from "node:stream";
export const buffer = consumers.buffer;
export const text = consumers.text;
export const json = consumers.json;
export const arrayBuffer = consumers.arrayBuffer;
export const blob = consumers.blob;
export default { pipeline, finished, ...consumers };

