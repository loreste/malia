// node:dns — comprehensive DNS resolution and lookup module.
const ops = Deno.core.ops;

// Standard DNS error codes
export const NODATA = "ENODATA";
export const FORMERR = "EFORMERR";
export const SERVFAIL = "ESERVFAIL";
export const NOTFOUND = "ENOTFOUND";
export const NOTIMP = "ENOTIMP";
export const REFUSED = "EREFUSED";
export const BADQUERY = "EBADQUERY";
export const BADNAME = "EBADNAME";
export const BADFAMILY = "EBADFAMILY";
export const BADRESP = "EBADRESP";
export const CONNREFUSED = "ECONNREFUSED";
export const TIMEOUT = "ETIMEOUT";
export const EOF = "EOF";
export const FILE = "EFILE";
export const NOMEM = "ENOMEM";
export const DESTRUCTION = "EDESTRUCTION";
export const BADSTR = "EBADSTR";
export const BADFLAGS = "EBADFLAGS";
export const NONAME = "ENONAME";
export const BADHINTS = "EBADHINTS";
export const NOTINITIALIZED = "ENOTINITIALIZED";
export const LOADIPHLPAPI = "ELOADIPHLPAPI";
export const ADDRGETNETWORKPARAMS = "EADDRGETNETWORKPARAMS";
export const CANCELLED = "ECANCELLED";

export const ADDRCONFIG = 1;
export const V4MAPPED = 2;
export const ALL = 4;

function makeDnsError(code, syscall, hostname) {
  const err = new Error(`${syscall} ${code} ${hostname}`);
  err.code = code;
  err.syscall = syscall;
  err.hostname = hostname;
  return err;
}

export function lookup(hostname, options, cb) {
  if (typeof options === "function") {
    cb = options;
    options = undefined;
  }
  const family = typeof options === "number" ? options : options?.family;
  const all = !!(options && typeof options === "object" && options.all);

  const promise = ops.op_dns_lookup(String(hostname)).then((addrs) => {
    let list = addrs;
    if (family === 4 || family === 6) list = list.filter((entry) => entry.family === family);
    if (list.length === 0) {
      throw makeDnsError("ENOTFOUND", "getaddrinfo", hostname);
    }
    if (all) return list.map((entry) => ({ address: entry.address, family: entry.family }));
    return { address: list[0].address, family: list[0].family };
  });

  if (typeof cb === "function") {
    promise.then(
      (result) =>
        queueMicrotask(() => {
          if (all) cb(null, result);
          else cb(null, result.address, result.family);
        }),
      (err) => queueMicrotask(() => cb(err)),
    );
    return undefined;
  }
  return promise;
}

export function lookupService(address, port, cb) {
  if (typeof port !== "number" || port < 0 || port > 65535) {
    throw new RangeError(`Port must be >= 0 and <= 65535: ${port}`);
  }
  const promise = ops.op_dns_lookup_service(String(address), port).catch((e) => {
    const err = makeDnsError("ENOTFOUND", "getnameinfo", address);
    err.message = `getnameinfo ${address}: ${e.message || e}`;
    throw err;
  });

  if (typeof cb === "function") {
    promise.then(
      (res) => queueMicrotask(() => cb(null, res.hostname, res.service)),
      (err) => queueMicrotask(() => cb(err)),
    );
    return undefined;
  }
  return promise;
}

export function resolve(hostname, rrtype, cb) {
  if (typeof rrtype === "function") {
    cb = rrtype;
    rrtype = "A";
  }
  rrtype = rrtype || "A";
  const promise = ops.op_dns_resolve(String(hostname), String(rrtype)).catch((e) => {
    const msg = e.message || String(e);
    const code = msg.includes("ENOTFOUND") ? "ENOTFOUND" : msg.includes("ENODATA") ? "ENODATA" : "ESERVFAIL";
    throw makeDnsError(code, `query${rrtype}`, hostname);
  });

  if (typeof cb === "function") {
    promise.then(
      (res) => queueMicrotask(() => cb(null, res)),
      (err) => queueMicrotask(() => cb(err)),
    );
    return undefined;
  }
  return promise;
}

export function resolve4(hostname, options, cb) {
  if (typeof options === "function") {
    cb = options;
    options = undefined;
  }
  const promise = resolve(hostname, "A").then((records) => {
    if (options && options.ttl) {
      return records.map((address) => ({ address, ttl: 60 }));
    }
    return records;
  });

  if (typeof cb === "function") {
    promise.then(
      (res) => queueMicrotask(() => cb(null, res)),
      (err) => queueMicrotask(() => cb(err)),
    );
    return undefined;
  }
  return promise;
}

export function resolve6(hostname, options, cb) {
  if (typeof options === "function") {
    cb = options;
    options = undefined;
  }
  const promise = resolve(hostname, "AAAA").then((records) => {
    if (options && options.ttl) {
      return records.map((address) => ({ address, ttl: 60 }));
    }
    return records;
  });

  if (typeof cb === "function") {
    promise.then(
      (res) => queueMicrotask(() => cb(null, res)),
      (err) => queueMicrotask(() => cb(err)),
    );
    return undefined;
  }
  return promise;
}

export function resolveCname(hostname, cb) {
  return resolve(hostname, "CNAME", cb);
}

export function resolveMx(hostname, cb) {
  return resolve(hostname, "MX", cb);
}

export function resolveNs(hostname, cb) {
  return resolve(hostname, "NS", cb);
}

export function resolveTxt(hostname, cb) {
  return resolve(hostname, "TXT", cb);
}

export function resolveSrv(hostname, cb) {
  return resolve(hostname, "SRV", cb);
}

export function resolvePtr(hostname, cb) {
  return resolve(hostname, "PTR", cb);
}

export function reverse(ip, cb) {
  return resolve(ip, "PTR", cb);
}

export function getServers() {
  return ["1.1.1.1", "8.8.8.8"];
}

export function setServers(servers) {
  // Accepted for compatibility
}

export const promises = {
  lookup(hostname, options) {
    return lookup(hostname, options);
  },
  lookupService(address, port) {
    return lookupService(address, port);
  },
  resolve(hostname, rrtype) {
    return resolve(hostname, rrtype);
  },
  resolve4(hostname, options) {
    return resolve4(hostname, options);
  },
  resolve6(hostname, options) {
    return resolve6(hostname, options);
  },
  resolveCname(hostname) {
    return resolveCname(hostname);
  },
  resolveMx(hostname) {
    return resolveMx(hostname);
  },
  resolveNs(hostname) {
    return resolveNs(hostname);
  },
  resolveTxt(hostname) {
    return resolveTxt(hostname);
  },
  resolveSrv(hostname) {
    return resolveSrv(hostname);
  },
  resolvePtr(hostname) {
    return resolvePtr(hostname);
  },
  reverse(ip) {
    return reverse(ip);
  },
};

export default {
  lookup,
  lookupService,
  resolve,
  resolve4,
  resolve6,
  resolveCname,
  resolveMx,
  resolveNs,
  resolveTxt,
  resolveSrv,
  resolvePtr,
  reverse,
  getServers,
  setServers,
  promises,
  NODATA,
  FORMERR,
  SERVFAIL,
  NOTFOUND,
  NOTIMP,
  REFUSED,
  BADQUERY,
  BADNAME,
  BADFAMILY,
  BADRESP,
  CONNREFUSED,
  TIMEOUT,
  EOF,
  FILE,
  NOMEM,
  DESTRUCTION,
  BADSTR,
  BADFLAGS,
  NONAME,
  BADHINTS,
  NOTINITIALIZED,
  LOADIPHLPAPI,
  ADDRGETNETWORKPARAMS,
  CANCELLED,
  ADDRCONFIG,
  V4MAPPED,
  ALL,
};
