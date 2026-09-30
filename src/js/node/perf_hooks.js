// node:perf_hooks -- Performance timing, marks, measures, and observers.
const _perf = globalThis.performance;

// Central entry buffer and observer registry.
const _entries = [];
const _marks = new Map();
const _observers = new Set();

function _notify(entry) {
  _entries.push(entry);
  for (const obs of _observers) {
    if (obs._types.has(entry.entryType)) {
      obs._buffer.push(entry);
      if (!obs._scheduled) {
        obs._scheduled = true;
        queueMicrotask(() => {
          obs._scheduled = false;
          if (obs._buffer.length === 0) return;
          const list = { getEntries: () => obs._buffer.splice(0) };
          obs._callback(list, obs);
        });
      }
    }
  }
}

export class PerformanceEntry {
  constructor(name, entryType, startTime, duration) {
    this.name = name;
    this.entryType = entryType;
    this.startTime = startTime;
    this.duration = duration;
  }
  toJSON() {
    return { name: this.name, entryType: this.entryType, startTime: this.startTime, duration: this.duration };
  }
}

export class PerformanceMark extends PerformanceEntry {
  constructor(name, options = {}) {
    super(name, "mark", options.startTime ?? _perf.now(), 0);
    this.detail = options.detail ?? null;
  }
}

export class PerformanceMeasure extends PerformanceEntry {
  constructor(name, options = {}) {
    super(
      name,
      "measure",
      options.startTime ?? _perf.now(),
      options.duration ?? 0,
    );
    this.detail = options.detail ?? null;
  }
}

export class PerformanceObserver {
  constructor(callback) {
    this._callback = callback;
    this._types = new Set();
    this._buffer = [];
    this._scheduled = false;
  }

  observe(options = {}) {
    if (options.entryTypes) {
      for (const t of options.entryTypes) this._types.add(t);
    }
    if (options.type) this._types.add(options.type);
    _observers.add(this);
  }

  disconnect() {
    _observers.delete(this);
  }

  takeRecords() {
    return this._buffer.splice(0);
  }

  static get supportedEntryTypes() {
    return ["mark", "measure", "function"];
  }
}

// Enhanced performance object with mark/measure/getEntries/clear.
const performance = Object.create(_perf);

performance.mark = function (name, options) {
  const entry = new PerformanceMark(name, options);
  _marks.set(name, entry);
  _notify(entry);
  return entry;
};

performance.measure = function (name, startOrOptions, endMark) {
  let startTime, duration;
  if (typeof startOrOptions === "string") {
    const s = _marks.get(startOrOptions);
    const e = endMark ? _marks.get(endMark) : null;
    startTime = s ? s.startTime : 0;
    duration = (e ? e.startTime : _perf.now()) - startTime;
  } else if (startOrOptions && typeof startOrOptions === "object") {
    startTime = startOrOptions.start != null
      ? (typeof startOrOptions.start === "string" ? (_marks.get(startOrOptions.start)?.startTime ?? 0) : startOrOptions.start)
      : _perf.now();
    if (startOrOptions.duration != null) {
      duration = startOrOptions.duration;
    } else if (startOrOptions.end != null) {
      const end = typeof startOrOptions.end === "string" ? (_marks.get(startOrOptions.end)?.startTime ?? _perf.now()) : startOrOptions.end;
      duration = end - startTime;
    } else {
      duration = _perf.now() - startTime;
    }
  } else {
    startTime = 0;
    duration = _perf.now();
  }
  const entry = new PerformanceMeasure(name, { startTime, duration });
  _notify(entry);
  return entry;
};

performance.getEntries = function () { return _entries.slice(); };
performance.getEntriesByName = function (name) { return _entries.filter(e => e.name === name); };
performance.getEntriesByType = function (type) { return _entries.filter(e => e.entryType === type); };
performance.clearMarks = function (name) {
  if (name) { _marks.delete(name); } else { _marks.clear(); }
};
performance.clearMeasures = function () {};

export function monitorEventLoopDelay() {
  return { enable() {}, disable() {}, reset() {}, get min() { return 0; }, get max() { return 0; }, get mean() { return 0; }, get stddev() { return 0; }, percentile() { return 0; }, percentiles: new Map() };
}

export { performance };

export default {
  performance,
  PerformanceEntry,
  PerformanceMark,
  PerformanceMeasure,
  PerformanceObserver,
  monitorEventLoopDelay,
};
