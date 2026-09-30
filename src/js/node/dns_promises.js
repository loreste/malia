// node:dns/promises — Promise-based DNS resolution API.
import { promises } from "node:dns";

export const {
  lookup,
  lookupService,
  resolve,
  resolve4,
  resolve6,
  resolveCname,
  resolveMx,
  resolveNs,
  resolveTxt,
  resolveSrv,
  resolvePtr,
  reverse,
} = promises;

export default promises;
