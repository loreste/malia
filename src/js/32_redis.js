// malia.redis -- built-in Redis client. Eliminates ioredis (13M/week).
(function (globalThis) {
  const ops = Deno.core.ops;

  function connect(url) {
    url = url || process.env.REDIS_URL || "redis://localhost:6379";
    const id = ops.op_redis_connect(String(url));

    function cmd(...args) {
      return ops.op_redis_command(id, args.map(String));
    }

    return {
      // Core commands
      get: (key) => cmd("GET", key),
      set: (key, value, ...opts) => cmd("SET", key, value, ...opts),
      del: (...keys) => cmd("DEL", ...keys),
      exists: (...keys) => cmd("EXISTS", ...keys),
      mget: (...keys) => cmd("MGET", ...keys),
      mset: (...pairs) => cmd("MSET", ...pairs),
      incr: (key) => cmd("INCR", key),
      incrby: (key, n) => cmd("INCRBY", key, n),
      decr: (key) => cmd("DECR", key),
      expire: (key, secs) => cmd("EXPIRE", key, secs),
      ttl: (key) => cmd("TTL", key),
      keys: (pattern) => cmd("KEYS", pattern || "*"),

      // Lists
      lpush: (key, ...vals) => cmd("LPUSH", key, ...vals),
      rpush: (key, ...vals) => cmd("RPUSH", key, ...vals),
      lpop: (key) => cmd("LPOP", key),
      rpop: (key) => cmd("RPOP", key),
      lrange: (key, start, stop) => cmd("LRANGE", key, start, stop),
      llen: (key) => cmd("LLEN", key),

      // Hashes
      hset: (key, field, value) => cmd("HSET", key, field, value),
      hget: (key, field) => cmd("HGET", key, field),
      hgetall: (key) => cmd("HGETALL", key),
      hdel: (key, ...fields) => cmd("HDEL", key, ...fields),

      // Sets
      sadd: (key, ...members) => cmd("SADD", key, ...members),
      smembers: (key) => cmd("SMEMBERS", key),
      srem: (key, ...members) => cmd("SREM", key, ...members),

      // Pub/Sub
      publish: (channel, message) => cmd("PUBLISH", channel, message),

      // Pipeline: batch multiple commands
      pipeline: (commands) => ops.op_redis_pipeline(id, commands),

      // Raw command
      command: cmd,

      // Info
      ping: () => cmd("PING"),
      info: (section) => section ? cmd("INFO", section) : cmd("INFO"),
      dbsize: () => cmd("DBSIZE"),
      flushdb: () => cmd("FLUSHDB"),
    };
  }

  globalThis.jse = globalThis.jse || {};
  globalThis.jse.redis = connect;
  globalThis.malia = globalThis.malia || globalThis.jse;
  if (globalThis.malia !== globalThis.jse) globalThis.malia.redis = connect;
})(globalThis);
