// node:stream/consumers shim — WHATWG & Node stream consumer utilities
import { Buffer } from "node:buffer";

export async function buffer(stream) {
  if (stream == null) {
    throw new TypeError("The 'stream' argument must be specified");
  }
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export async function text(stream, encoding = "utf8") {
  const buf = await buffer(stream);
  return buf.toString(encoding);
}

export async function json(stream) {
  const str = await text(stream);
  return JSON.parse(str);
}

export async function arrayBuffer(stream) {
  const buf = await buffer(stream);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

export async function blob(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return new Blob(chunks);
}

export default {
  buffer,
  text,
  json,
  arrayBuffer,
  blob,
};
