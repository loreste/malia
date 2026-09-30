// node:timers/promises — Promise-based timers API.
import { promises } from "node:timers";

export const {
  setTimeout,
  setImmediate,
  setInterval,
} = promises;

export default promises;
