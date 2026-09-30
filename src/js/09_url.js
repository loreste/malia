// URL and URLSearchParams globals. Parsing/serialization is delegated to the
// Rust `url` crate through ops (full WHATWG-URL correctness); URLSearchParams
// is pure JS following the application/x-www-form-urlencoded rules.
"use strict";

((globalThis) => {
  const ops = Deno.core.ops;

  // ---- URLSearchParams ------------------------------------------------------

  const HEX = "0123456789ABCDEF";
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // application/x-www-form-urlencoded percent-encode: alphanumerics and
  // * - . _ pass through, space becomes '+', everything else %XX (UTF-8).
  function urlEncode(str) {
    const bytes = encoder.encode(String(str));
    let out = "";
    for (const b of bytes) {
      const c = String.fromCharCode(b);
      if (
        (b >= 0x30 && b <= 0x39) || // 0-9
        (b >= 0x41 && b <= 0x5a) || // A-Z
        (b >= 0x61 && b <= 0x7a) || // a-z
        c === "*" || c === "-" || c === "." || c === "_"
      ) {
        out += c;
      } else if (b === 0x20) {
        out += "+";
      } else {
        out += "%" + HEX[b >> 4] + HEX[b & 15];
      }
    }
    return out;
  }

  function urlDecode(str) {
    const bytes = [];
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === "+") {
        bytes.push(0x20);
      } else if (c === "%" && i + 2 < s.length + 1 && /^[0-9a-fA-F]{2}/.test(s.slice(i + 1, i + 3))) {
        bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        // Re-encode the whole code point, not one UTF-16 unit, so astral
        // characters (emoji) are not split into lone surrogates.
        const cp = String.fromCodePoint(s.codePointAt(i));
        for (const b of encoder.encode(cp)) bytes.push(b);
        i += cp.length - 1;
      }
    }
    return decoder.decode(new Uint8Array(bytes));
  }

  // URL instances register a change callback here so mutating a URL's
  // searchParams keeps url.search in sync (per the WHATWG URL spec).
  const paramChangeCallbacks = new WeakMap();

  class URLSearchParams {
    #pairs = [];

    constructor(init) {
      if (init === undefined || init === null) {
        // empty
      } else if (typeof init === "string") {
        this.#parse(init.startsWith("?") ? init.slice(1) : init);
      } else if (typeof init[Symbol.iterator] === "function") {
        for (const pair of init) {
          if (typeof pair[Symbol.iterator] !== "function") {
            throw new TypeError("URLSearchParams: each pair must be iterable");
          }
          const [name, value, ...rest] = pair;
          if (rest.length > 0 || name === undefined) {
            throw new TypeError("URLSearchParams: each pair must be a name/value tuple");
          }
          this.#pairs.push([String(name), String(value)]);
        }
      } else if (typeof init === "object") {
        for (const key of Object.keys(init)) {
          this.#pairs.push([String(key), String(init[key])]);
        }
      } else {
        throw new TypeError("URLSearchParams: unsupported init");
      }
    }

    #parse(query) {
      if (query === "") return;
      for (const piece of query.split("&")) {
        if (piece === "") continue;
        const eq = piece.indexOf("=");
        if (eq === -1) {
          this.#pairs.push([urlDecode(piece), ""]);
        } else {
          this.#pairs.push([urlDecode(piece.slice(0, eq)), urlDecode(piece.slice(eq + 1))]);
        }
      }
    }

    #changed() {
      const onChange = paramChangeCallbacks.get(this);
      if (onChange) onChange(this.toString());
    }

    get size() {
      return this.#pairs.length;
    }

    append(name, value) {
      this.#pairs.push([String(name), String(value)]);
      this.#changed();
    }

    delete(name, value) {
      name = String(name);
      this.#pairs = this.#pairs.filter(
        ([n, v]) => n !== name || (value !== undefined && v !== String(value)),
      );
      this.#changed();
    }

    get(name) {
      name = String(name);
      const pair = this.#pairs.find(([n]) => n === name);
      return pair ? pair[1] : null;
    }

    getAll(name) {
      name = String(name);
      return this.#pairs.filter(([n]) => n === name).map(([, v]) => v);
    }

    has(name, value) {
      name = String(name);
      return this.#pairs.some(([n, v]) => n === name && (value === undefined || v === String(value)));
    }

    set(name, value) {
      name = String(name);
      value = String(value);
      let found = false;
      this.#pairs = this.#pairs.filter(([n]) => {
        if (n !== name) return true;
        if (found) return false;
        found = true;
        return true;
      });
      if (found) {
        const idx = this.#pairs.findIndex(([n]) => n === name);
        this.#pairs[idx] = [name, value];
      } else {
        this.#pairs.push([name, value]);
      }
      this.#changed();
    }

    sort() {
      this.#pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      this.#changed();
    }

    toString() {
      return this.#pairs.map(([n, v]) => urlEncode(n) + "=" + urlEncode(v)).join("&");
    }

    *entries() {
      for (const [n, v] of this.#pairs) yield [n, v];
    }

    *keys() {
      for (const [n] of this.#pairs) yield n;
    }

    *values() {
      for (const [, v] of this.#pairs) yield v;
    }

    forEach(cb, thisArg) {
      for (const [n, v] of this.#pairs) cb.call(thisArg, v, n, this);
    }

    [Symbol.iterator]() {
      return this.entries();
    }
  }

  // ---- URL -------------------------------------------------------------------

  class URL {
    #href;
    #parts;
    #searchParams = null;

    constructor(href, base) {
      if (href === undefined) throw new TypeError("URL: href argument is required");
      this.#parts = ops.op_url_parse(String(href), base === undefined ? undefined : String(base));
      this.#href = this.#parts.href;
    }

    #setPart(part, value) {
      this.#href = ops.op_url_set_part(this.#href, part, String(value));
      // Re-parse so normalizations (default ports, case, etc.) are reflected.
      this.#parts = ops.op_url_parse(this.#href, undefined);
      this.#searchParams = null;
    }

    get href() {
      return this.#href;
    }
    set href(value) {
      this.#parts = ops.op_url_parse(String(value), undefined);
      this.#href = this.#parts.href;
      this.#searchParams = null;
    }
    get protocol() {
      return this.#parts.protocol;
    }
    set protocol(value) {
      this.#setPart("protocol", value);
    }
    get username() {
      return this.#parts.username;
    }
    set username(value) {
      this.#setPart("username", value);
    }
    get password() {
      return this.#parts.password;
    }
    set password(value) {
      this.#setPart("password", value);
    }
    get host() {
      return this.#parts.host;
    }
    set host(value) {
      this.#setPart("host", value);
    }
    get hostname() {
      return this.#parts.hostname;
    }
    set hostname(value) {
      this.#setPart("hostname", value);
    }
    get port() {
      return this.#parts.port;
    }
    set port(value) {
      this.#setPart("port", value);
    }
    get pathname() {
      return this.#parts.pathname;
    }
    set pathname(value) {
      this.#setPart("pathname", value);
    }
    get search() {
      return this.#parts.search;
    }
    set search(value) {
      this.#setPart("search", value);
    }
    get hash() {
      return this.#parts.hash;
    }
    set hash(value) {
      this.#setPart("hash", value);
    }
    get origin() {
      return this.#parts.origin;
    }

    get searchParams() {
      if (this.#searchParams === null) {
        const params = new URLSearchParams(this.#parts.search);
        paramChangeCallbacks.set(params, (query) => {
          // Keep the URL in sync when its searchParams are mutated.
          this.#href = ops.op_url_set_part(this.#href, "search", query);
          this.#parts = ops.op_url_parse(this.#href, undefined);
        });
        this.#searchParams = params;
      }
      return this.#searchParams;
    }

    toString() {
      return this.#href;
    }

    toJSON() {
      return this.#href;
    }

    static parse(href, base) {
      try {
        return new URL(href, base);
      } catch {
        return null;
      }
    }

    static canParse(href, base) {
      try {
        ops.op_url_parse(String(href), base === undefined ? undefined : String(base));
        return true;
      } catch {
        return false;
      }
    }
  }

  globalThis.URL = URL;
  globalThis.URLSearchParams = URLSearchParams;
})(globalThis);
