// 18_trace.js -- OpenTelemetry-compatible W3C distributed tracing engine
(function () {
  function randomHex(bytes) {
    const arr = new Uint8Array(bytes);
    crypto.getRandomValues(arr);
    let hex = "";
    for (let i = 0; i < arr.length; i++) {
      hex += arr[i].toString(16).padStart(2, "0");
    }
    return hex;
  }

  function attributeValue(value) {
    if (typeof value === "boolean") return { boolValue: value };
    if (typeof value === "number" && Number.isFinite(value)) {
      return Number.isSafeInteger(value) ? { intValue: String(value) } : { doubleValue: value };
    }
    if (Array.isArray(value)) return { arrayValue: { values: value.map(attributeValue) } };
    return { stringValue: String(value) };
  }

  class Span {
    constructor(name, options = {}) {
      this.name = String(name);
      this.traceId = options.traceId || randomHex(16);
      this.spanId = options.spanId || randomHex(8);
      this.parentSpanId = options.parentSpanId || null;
      this.flags = options.flags ?? "01";
      this.startTime = options.startTime || Date.now();
      this.endTime = null;
      this.durationMs = null;
      this.attributes = { ...(options.attributes || {}) };
      this.events = [];
      this.status = { code: "UNSET", message: "" };
    }

    setAttribute(key, value) {
      this.attributes[key] = value;
      return this;
    }

    setAttributes(attrs) {
      Object.assign(this.attributes, attrs);
      return this;
    }

    addEvent(name, attributes = {}) {
      this.events.push({
        name: String(name),
        time: Date.now(),
        attributes,
      });
      return this;
    }

    setStatus(code, message = "") {
      this.status = { code: String(code).toUpperCase(), message: String(message) };
      return this;
    }

    recordException(err) {
      this.setStatus("ERROR", err?.message || String(err));
      this.addEvent("exception", {
        "exception.type": err?.name || "Error",
        "exception.message": err?.message || String(err),
        "exception.stacktrace": err?.stack || "",
      });
      return this;
    }

    end() {
      if (this.endTime === null) {
        this.endTime = Date.now();
        this.durationMs = Math.max(0, this.endTime - this.startTime);
        traceEngine._recordCompletedSpan(this);
      }
      return this;
    }

    toTraceparent() {
      return `00-${this.traceId}-${this.spanId}-${this.flags}`;
    }
  }

  const completedSpans = [];
  const MAX_SPANS = 2000;
  const context = new Deno.core.AsyncVariable();

  const traceEngine = {
    _recordCompletedSpan(span) {
      if (completedSpans.length >= MAX_SPANS) {
        completedSpans.shift();
      }
      completedSpans.push(span);
    },

    startSpan(name, fnOrOptions, fn) {
      let options = {};
      let callback = fnOrOptions;
      if (typeof fnOrOptions === "object" && fnOrOptions !== null) {
        options = { ...fnOrOptions };
        callback = fn;
      }

      const activeSpan = context.get();
      if (!options.root && !options.traceId && !options.parentSpanId && activeSpan) {
        options.parentSpanId = activeSpan.spanId;
        options.traceId = activeSpan.traceId;
        options.flags = activeSpan.flags;
      }

      const span = new Span(name, options);
      if (typeof callback !== "function") {
        return span;
      }

      const prev = context.enter(span);
      try {
        const result = callback(span);
        if (result && typeof result.then === "function") {
          return result
            .then((val) => {
              span.setStatus("OK");
              span.end();
              return val;
            })
            .catch((err) => {
              span.recordException(err);
              span.end();
              throw err;
            });
        }
        span.setStatus("OK");
        span.end();
        return result;
      } catch (err) {
        span.recordException(err);
        span.end();
        throw err;
      } finally {
        Deno.core.setAsyncContext(prev);
      }
    },

    activeSpan() {
      return context.get() ?? null;
    },

    extract(headers) {
      const tp = typeof headers?.get === "function" ? headers.get("traceparent") : headers?.traceparent;
      if (typeof tp !== "string" || !/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(tp)) return null;
      const parts = tp.split("-");
      if (/^0+$/.test(parts[1]) || /^0+$/.test(parts[2])) return null;
      return {
        traceId: parts[1],
        parentSpanId: parts[2],
        flags: parts[3],
      };
    },

    inject(span, headers = {}) {
      if (span && typeof span.toTraceparent === "function") {
        if (typeof headers.set === "function") headers.set("traceparent", span.toTraceparent());
        else headers["traceparent"] = span.toTraceparent();
      }
      return headers;
    },

    spans() {
      return completedSpans.slice();
    },

    clear() {
      completedSpans.length = 0;
    },

    export(format = "otlp") {
      if (format === "otlp") {
        return {
          resourceSpans: [
            {
              resource: {
                attributes: [
                  { key: "service.name", value: { stringValue: globalThis.process?.title || "jse-app" } },
                  { key: "telemetry.sdk.name", value: { stringValue: "jse-trace" } },
                  { key: "telemetry.sdk.language", value: { stringValue: "javascript" } },
                ],
              },
              scopeSpans: [
                {
                  scope: { name: "jse.trace", version: "0.1.0" },
                  spans: completedSpans.map((s) => ({
                    traceId: s.traceId,
                    spanId: s.spanId,
                    parentSpanId: s.parentSpanId || undefined,
                    name: s.name,
                    startTimeUnixNano: (BigInt(Math.trunc(s.startTime)) * 1_000_000n).toString(),
                    endTimeUnixNano: (BigInt(Math.trunc(s.endTime ?? s.startTime)) * 1_000_000n).toString(),
                    attributes: Object.entries(s.attributes).map(([k, v]) => ({
                      key: k,
                      value: attributeValue(v),
                    })),
                    status: { code: ({ UNSET: 0, OK: 1, ERROR: 2 })[s.status.code] ?? 0, message: s.status.message },
                  })),
                },
              ],
            },
          ],
        };
      }
      return completedSpans.slice();
    },
  };

  globalThis.jse = globalThis.jse || {};
  globalThis.jse.trace = traceEngine;
})();
