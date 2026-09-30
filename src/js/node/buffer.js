// node:buffer shim.
const { Buffer } = globalThis;
export { Buffer };
export const kMaxLength = 2147483647;
export default { Buffer, kMaxLength };
