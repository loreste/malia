// node:buffer shim.
const { Buffer } = globalThis;
export { Buffer };
export const kMaxLength = 2147483647;
export const kStringMaxLength = 536870888;
export const constants = {
  MAX_LENGTH: kMaxLength,
  MAX_STRING_LENGTH: kStringMaxLength,
};
if (Buffer) {
  Buffer.constants = constants;
  Buffer.kMaxLength = kMaxLength;
  Buffer.kStringMaxLength = kStringMaxLength;
}

export const Blob = globalThis.Blob;
export const File = globalThis.File;
export const atob = globalThis.atob;
export const btoa = globalThis.btoa;
export const isUtf8 = (val) => {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(val);
    return true;
  } catch {
    return false;
  }
};
export const isAscii = (val) => {
  if (val instanceof Uint8Array || (Buffer && Buffer.isBuffer(val))) {
    for (let i = 0; i < val.length; i++) {
      if (val[i] > 127) return false;
    }
    return true;
  }
  return false;
};

export default {
  Buffer,
  constants,
  kMaxLength,
  kStringMaxLength,
  Blob,
  File,
  atob,
  btoa,
  isUtf8,
  isAscii,
};
