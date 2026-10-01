// node:v8 shim
const ops = Deno.core.ops;

export function getHeapStatistics() { return ops.op_v8_heap_statistics(); }
export function getHeapSpaceStatistics() { return ops.op_v8_heap_spaces(); }
export function setFlagsFromString() {
  const error = new Error('V8 flags must be configured before isolate startup');
  error.code = 'ERR_NOT_SUPPORTED'; throw error;
}

export function serialize(value) {
  if (typeof ops.op_serialize === "function") {
    try {
      return Buffer.from(ops.op_serialize(value, undefined, undefined, false, undefined));
    } catch (_) {}
  }
  return Buffer.from(JSON.stringify(value));
}

export function deserialize(buffer) {
  if (typeof ops.op_deserialize === "function") {
    try {
      return ops.op_deserialize(buffer, undefined, undefined, undefined, false);
    } catch (_) {}
  }
  return JSON.parse(buffer.toString());
}

export class Serializer {
  writeHeader() {}
  writeValue(val) {
    this._buffer = serialize(val);
  }
  releaseBuffer() {
    return this._buffer || Buffer.alloc(0);
  }
}

export class Deserializer {
  constructor(buffer) {
    this._buffer = buffer;
  }
  readHeader() { return true; }
  readValue() {
    return deserialize(this._buffer);
  }
}

export function cachedDataVersionTag() {
  const error = new Error('V8 cached-data version tags are not exposed');
  error.code = 'ERR_NOT_SUPPORTED'; throw error;
}

export default {
  getHeapStatistics,
  getHeapSpaceStatistics,
  setFlagsFromString,
  serialize,
  deserialize,
  Serializer,
  Deserializer,
  cachedDataVersionTag,
};
