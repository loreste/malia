// node:v8 shim
const ops = Deno.core.ops;

export function getHeapStatistics() {
  const mem = process.memoryUsage();
  return {
    total_heap_size: mem.heapTotal || 32 * 1024 * 1024,
    total_heap_size_executable: 4 * 1024 * 1024,
    total_physical_size: mem.rss || 64 * 1024 * 1024,
    total_available_size: 1024 * 1024 * 1024,
    used_heap_size: mem.heapUsed || 16 * 1024 * 1024,
    heap_size_limit: 2 * 1024 * 1024 * 1024,
    malloced_memory: mem.external || 1024 * 1024,
    peak_malloced_memory: (mem.external || 1024 * 1024) * 2,
    does_zap_garbage: 0,
    number_of_native_contexts: 1,
    number_of_detached_contexts: 0,
    total_global_handles_size: 1024 * 1024,
    used_global_handles_size: 512 * 1024,
    external_memory: mem.external || 0,
  };
}

export function getHeapSpaceStatistics() {
  const stats = getHeapStatistics();
  return [
    { space_name: "read_only_space", space_size: 0, space_used_size: 0, space_available_size: 0, physical_space_size: 0 },
    { space_name: "new_space", space_size: 16 * 1024 * 1024, space_used_size: 8 * 1024 * 1024, space_available_size: 8 * 1024 * 1024, physical_space_size: 16 * 1024 * 1024 },
    { space_name: "old_space", space_size: stats.total_heap_size, space_used_size: stats.used_heap_size, space_available_size: stats.total_available_size, physical_space_size: stats.total_heap_size },
    { space_name: "code_space", space_size: 4 * 1024 * 1024, space_used_size: 2 * 1024 * 1024, space_available_size: 2 * 1024 * 1024, physical_space_size: 4 * 1024 * 1024 },
    { space_name: "map_space", space_size: 2 * 1024 * 1024, space_used_size: 1 * 1024 * 1024, space_available_size: 1 * 1024 * 1024, physical_space_size: 2 * 1024 * 1024 },
    { space_name: "large_object_space", space_size: 0, space_used_size: 0, space_available_size: 0, physical_space_size: 0 },
  ];
}

export function setFlagsFromString(_flags) {
  // Accepted as no-op or handled by engine optimizer
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
  return 1;
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
