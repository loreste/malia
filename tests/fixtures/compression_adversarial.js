// Adversarial test suite for node:zlib compression & decompression
import assert from "node:assert";
import zlib, {
  gzipSync,
  gunzipSync,
  deflateSync,
  inflateSync,
  unzipSync,
  unzip,
  createUnzip,
  createGzip,
  createDeflate,
  crc32,
  brotliCompressSync,
  brotliDecompressSync,
  createBrotliCompress,
  createBrotliDecompress,
  constants,
} from "node:zlib";
import { Readable } from "node:stream";

console.log("=== COMPRESSION & ZLIB ADVERSARIAL TEST ===");

// 1. CRC32 Checksums (RFC 1952 / IEEE 802.3 standard vectors)
console.log("1. Testing crc32...");
assert.strictEqual(crc32(""), 0, "Empty CRC32 must be 0");
assert.strictEqual(crc32("hello"), 907060870, "CRC32('hello') must match vector");
assert.strictEqual(
  crc32("The quick brown fox jumps over the lazy dog"),
  1095738169,
  "CRC32 standard sentence vector",
);

// Test running/chained CRC32
const part1 = "Hello, ";
const part2 = "World! This is jse compression testing.";
const combined = part1 + part2;
const crcCombined = crc32(combined);
const crcChained = crc32(part2, crc32(part1));
assert.strictEqual(crcChained, crcCombined, "Chained CRC32 must equal combined CRC32");

// 2. UnzipSync (Auto-detection of Gzip vs Deflate headers)
console.log("2. Testing unzipSync auto-detection...");
const sampleText = "The fast, lightweight JavaScript & TypeScript engine built for extreme concurrency.".repeat(50);
const sampleBuf = Buffer.from(sampleText, "utf8");

// Gzip compression roundtrip via unzipSync
const gzipped = gzipSync(sampleBuf);
assert.strictEqual(gzipped[0], 0x1f, "Gzip byte 0");
assert.strictEqual(gzipped[1], 0x8b, "Gzip byte 1");
const unzippedGzip = unzipSync(gzipped);
assert.strictEqual(unzippedGzip.toString("utf8"), sampleText, "unzipSync must unpack GZIP");

// Deflate compression roundtrip via unzipSync
const deflated = deflateSync(sampleBuf);
// Deflate header does NOT have 0x1f 0x8b
assert.ok(deflated[0] !== 0x1f || deflated[1] !== 0x8b, "Deflate magic header check");
const unzippedDeflate = unzipSync(deflated);
assert.strictEqual(unzippedDeflate.toString("utf8"), sampleText, "unzipSync must unpack DEFLATE");

// 3. Callback unzip
console.log("3. Testing callback unzip...");
await new Promise((resolve, reject) => {
  unzip(gzipped, (err, res) => {
    if (err) return reject(err);
    assert.strictEqual(res.toString("utf8"), sampleText, "Callback unzip GZIP");
    unzip(deflated, (err2, res2) => {
      if (err2) return reject(err2);
      assert.strictEqual(res2.toString("utf8"), sampleText, "Callback unzip DEFLATE");
      resolve();
    });
  });
});

// 4. Stream transform createUnzip
console.log("4. Testing createUnzip streaming...");
async function streamRoundTrip(compressTransform, uncompressTransform, inputBuf) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const source = Readable.from([inputBuf]);
    const compressor = compressTransform();
    const decompressor = uncompressTransform();

    source
      .pipe(compressor)
      .pipe(decompressor)
      .on("data", (chunk) => chunks.push(chunk))
      .on("end", () => resolve(Buffer.concat(chunks)))
      .on("error", reject);
  });
}

const streamGzipResult = await streamRoundTrip(createGzip, createUnzip, sampleBuf);
assert.strictEqual(streamGzipResult.toString("utf8"), sampleText, "createUnzip streaming GZIP");

const streamDeflateResult = await streamRoundTrip(createDeflate, createUnzip, sampleBuf);
assert.strictEqual(streamDeflateResult.toString("utf8"), sampleText, "createUnzip streaming DEFLATE");

// 5. Brotli compression & decompression
console.log("5. Testing Brotli sync & streaming...");
const brotliCompressed = brotliCompressSync(sampleBuf);
assert.ok(brotliCompressed.length < sampleBuf.length, "Brotli must compress text");
const brotliDecompressed = brotliDecompressSync(brotliCompressed);
assert.strictEqual(brotliDecompressed.toString("utf8"), sampleText, "Brotli round-trip sync");

const streamBrotliResult = await streamRoundTrip(createBrotliCompress, createBrotliDecompress, sampleBuf);
assert.strictEqual(streamBrotliResult.toString("utf8"), sampleText, "Brotli round-trip stream");

// 6. Verify constants
console.log("6. Testing constants...");
assert.strictEqual(constants.Z_OK, 0);
assert.strictEqual(constants.Z_STREAM_END, 1);
assert.strictEqual(constants.Z_BEST_COMPRESSION, 9);
assert.strictEqual(constants.BROTLI_OPERATION_PROCESS, 0);
assert.strictEqual(constants.BROTLI_OPERATION_FINISH, 2);

console.log("COMPRESSION & ZLIB ADVERSARIAL: ALL PASS");
