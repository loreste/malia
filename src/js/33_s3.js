// malia.s3 -- built-in S3 client. Eliminates @aws-sdk/client-s3.
// Works with AWS S3, Cloudflare R2, MinIO, DigitalOcean Spaces.
(function (globalThis) {
  const ops = Deno.core.ops;

  function connect(options) {
    const endpoint = options.endpoint || `https://s3.${options.region || "us-east-1"}.amazonaws.com`;
    const bucket = options.bucket;
    const region = options.region || "us-east-1";
    const accessKey = options.accessKeyId || process.env.AWS_ACCESS_KEY_ID || "";
    const secretKey = options.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY || "";

    if (!bucket) throw new TypeError("S3 client requires a bucket name");

    const id = ops.op_s3_connect(endpoint, bucket, region, accessKey, secretKey);

    return {
      get(key) {
        const result = ops.op_s3_get(id, String(key));
        return result.body;
      },

      getJSON(key) {
        return JSON.parse(this.get(key));
      },

      put(key, data) {
        const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
        return ops.op_s3_put(id, String(key), bytes);
      },

      putJSON(key, value) {
        return this.put(key, JSON.stringify(value));
      },

      delete(key) {
        return ops.op_s3_delete(id, String(key));
      },

      presign(key, expiresIn) {
        return ops.op_s3_presign(id, String(key), expiresIn || 3600);
      },

      // Convenience: check if object exists (HEAD via GET with range)
      exists(key) {
        try {
          this.get(key);
          return true;
        } catch {
          return false;
        }
      },
    };
  }

  globalThis.jse = globalThis.jse || {};
  globalThis.jse.s3 = connect;
  globalThis.malia = globalThis.malia || globalThis.jse;
})(globalThis);
