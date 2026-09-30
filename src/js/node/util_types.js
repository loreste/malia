// node:util/types shim
const toString = Object.prototype.toString;

export function isAnyArrayBuffer(v) {
  return (
    v instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== "undefined" && v instanceof SharedArrayBuffer)
  );
}

export function isArrayBuffer(v) {
  return v instanceof ArrayBuffer;
}

export function isArgumentsObject(v) {
  return toString.call(v) === "[object Arguments]";
}

export function isArrayBufferView(v) {
  return ArrayBuffer.isView(v);
}

export function isAsyncFunction(v) {
  return toString.call(v) === "[object AsyncFunction]";
}

export function isBigInt64Array(v) {
  return typeof BigInt64Array !== "undefined" && v instanceof BigInt64Array;
}

export function isBigUint64Array(v) {
  return typeof BigUint64Array !== "undefined" && v instanceof BigUint64Array;
}

export function isBooleanObject(v) {
  return typeof v === "object" && v !== null && toString.call(v) === "[object Boolean]";
}

export function isBoxedPrimitive(v) {
  return (
    isBooleanObject(v) ||
    isNumberObject(v) ||
    isStringObject(v) ||
    isSymbolObject(v) ||
    isBigIntObject(v)
  );
}

export function isBigIntObject(v) {
  return typeof v === "object" && v !== null && toString.call(v) === "[object BigInt]";
}

export function isDataView(v) {
  return v instanceof DataView;
}

export function isDate(v) {
  return v instanceof Date;
}

export function isFloat32Array(v) {
  return v instanceof Float32Array;
}

export function isFloat64Array(v) {
  return v instanceof Float64Array;
}

export function isGeneratorFunction(v) {
  return toString.call(v) === "[object GeneratorFunction]";
}

export function isGeneratorObject(v) {
  return typeof v === "object" && v !== null && toString.call(v) === "[object Generator]";
}

export function isInt8Array(v) {
  return v instanceof Int8Array;
}

export function isInt16Array(v) {
  return v instanceof Int16Array;
}

export function isInt32Array(v) {
  return v instanceof Int32Array;
}

export function isMap(v) {
  return v instanceof Map;
}

export function isMapIterator(v) {
  return toString.call(v) === "[object Map Iterator]";
}

export function isModuleNamespaceObject(v) {
  return toString.call(v) === "[object Module]";
}

export function isNativeError(v) {
  return v instanceof Error;
}

export function isNumberObject(v) {
  return typeof v === "object" && v !== null && toString.call(v) === "[object Number]";
}

export function isPromise(v) {
  return (
    v instanceof Promise ||
    (v !== null && typeof v === "object" && typeof v.then === "function" && typeof v.catch === "function")
  );
}

export function isProxy(_v) {
  return false;
}

export function isRegExp(v) {
  return v instanceof RegExp;
}

export function isSet(v) {
  return v instanceof Set;
}

export function isSetIterator(v) {
  return toString.call(v) === "[object Set Iterator]";
}

export function isSharedArrayBuffer(v) {
  return typeof SharedArrayBuffer !== "undefined" && v instanceof SharedArrayBuffer;
}

export function isStringObject(v) {
  return typeof v === "object" && v !== null && toString.call(v) === "[object String]";
}

export function isSymbolObject(v) {
  return typeof v === "object" && v !== null && toString.call(v) === "[object Symbol]";
}

export function isTypedArray(v) {
  return ArrayBuffer.isView(v) && !(v instanceof DataView);
}

export function isUint8Array(v) {
  return v instanceof Uint8Array;
}

export function isUint8ClampedArray(v) {
  return v instanceof Uint8ClampedArray;
}

export function isUint16Array(v) {
  return v instanceof Uint16Array;
}

export function isUint32Array(v) {
  return v instanceof Uint32Array;
}

export function isWeakMap(v) {
  return v instanceof WeakMap;
}

export function isWeakSet(v) {
  return v instanceof WeakSet;
}

export function isKeyObject(_v) {
  return false;
}

export function isCryptoKey(v) {
  return typeof CryptoKey !== "undefined" && v instanceof CryptoKey;
}

export default {
  isAnyArrayBuffer,
  isArrayBuffer,
  isArgumentsObject,
  isArrayBufferView,
  isAsyncFunction,
  isBigInt64Array,
  isBigUint64Array,
  isBooleanObject,
  isBoxedPrimitive,
  isBigIntObject,
  isDataView,
  isDate,
  isFloat32Array,
  isFloat64Array,
  isGeneratorFunction,
  isGeneratorObject,
  isInt8Array,
  isInt16Array,
  isInt32Array,
  isMap,
  isMapIterator,
  isModuleNamespaceObject,
  isNativeError,
  isNumberObject,
  isPromise,
  isProxy,
  isRegExp,
  isSet,
  isSetIterator,
  isSharedArrayBuffer,
  isStringObject,
  isSymbolObject,
  isTypedArray,
  isUint8Array,
  isUint8ClampedArray,
  isUint16Array,
  isUint32Array,
  isWeakMap,
  isWeakSet,
  isKeyObject,
  isCryptoKey,
};
