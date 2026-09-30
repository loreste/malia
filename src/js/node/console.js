// node:console shim.
const con = globalThis.console;
export const log = con.log;
export const info = con.info;
export const warn = con.warn;
export const error = con.error;
export const debug = con.debug;
export const trace = con.trace;
export const assert = con.assert;
export const dir = con.dir;
export default con;
