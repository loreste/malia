// node:perf_hooks — Performance timing and metrics.
export const performance = globalThis.performance;

export class PerformanceEntry {
  constructor(name, entryType, startTime, duration) {
    this.name = name;
    this.entryType = entryType;
    this.startTime = startTime;
    this.duration = duration;
  }
}

export class PerformanceMark extends PerformanceEntry {
  constructor(name, options = {}) {
    super(name, "mark", options.startTime ?? performance.now(), 0);
    this.detail = options.detail ?? null;
  }
}

export class PerformanceMeasure extends PerformanceEntry {
  constructor(name, options = {}) {
    super(
      name,
      "measure",
      options.startTime ?? performance.now(),
      options.duration ?? 0,
    );
    this.detail = options.detail ?? null;
  }
}

export class PerformanceObserver {
  constructor(callback) {
    this.callback = callback;
  }

  observe(options) {
    // Stub
  }

  disconnect() {
    // Stub
  }

  takeRecords() {
    return [];
  }
}

export default {
  performance,
  PerformanceEntry,
  PerformanceMark,
  PerformanceMeasure,
  PerformanceObserver,
};
