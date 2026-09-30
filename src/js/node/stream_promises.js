// node:stream/promises
import { promises } from "node:stream";

export const { pipeline, finished } = promises;
export default promises;
