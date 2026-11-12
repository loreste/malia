// malia.cron -- built-in cron scheduler. No npm packages needed.
//
//   malia.cron("*/5 * * * *", () => console.log("every 5 minutes"));
//   malia.cron("0 9 * * MON-FRI", () => sendDailyReport());
//   const job = malia.cron("0 * * * *", handler);
//   job.stop();   // pause
//   job.start();  // resume
//
// Supports: second-level precision (6 fields), ranges (1-5), steps (*/2),
// lists (1,3,5), day names (MON-SUN), month names (JAN-DEC).

"use strict";
((globalThis) => {

  const DAY_NAMES = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
  const MONTH_NAMES = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

  function parseCronField(field, min, max, names) {
    if (field === "*") return null; // null = match any

    const result = new Set();
    for (const part of field.split(",")) {
      let rangePart = part;
      let step = 1;

      if (rangePart.includes("/")) {
        const [r, s] = rangePart.split("/");
        rangePart = r;
        step = parseInt(s, 10);
      }

      // Replace names
      if (names) {
        for (const [name, val] of Object.entries(names)) {
          rangePart = rangePart.toUpperCase().replace(name, String(val));
        }
      }

      if (rangePart === "*") {
        for (let i = min; i <= max; i += step) result.add(i);
      } else if (rangePart.includes("-")) {
        const [a, b] = rangePart.split("-").map(Number);
        for (let i = a; i <= b; i += step) result.add(i);
      } else {
        result.add(parseInt(rangePart, 10));
      }
    }
    return result;
  }

  function parseCron(expr) {
    const parts = expr.trim().split(/\s+/);
    let second, minute, hour, dayOfMonth, month, dayOfWeek;

    if (parts.length === 6) {
      // Second-level: sec min hour dom month dow
      second = parseCronField(parts[0], 0, 59, null);
      minute = parseCronField(parts[1], 0, 59, null);
      hour = parseCronField(parts[2], 0, 23, null);
      dayOfMonth = parseCronField(parts[3], 1, 31, null);
      month = parseCronField(parts[4], 1, 12, MONTH_NAMES);
      dayOfWeek = parseCronField(parts[5], 0, 6, DAY_NAMES);
    } else if (parts.length === 5) {
      // Standard: min hour dom month dow
      second = new Set([0]);
      minute = parseCronField(parts[0], 0, 59, null);
      hour = parseCronField(parts[1], 0, 23, null);
      dayOfMonth = parseCronField(parts[2], 1, 31, null);
      month = parseCronField(parts[3], 1, 12, MONTH_NAMES);
      dayOfWeek = parseCronField(parts[4], 0, 6, DAY_NAMES);
    } else {
      throw new Error(`Invalid cron expression: "${expr}" (expected 5 or 6 fields)`);
    }

    return { second, minute, hour, dayOfMonth, month, dayOfWeek };
  }

  function matches(schedule, date) {
    const s = schedule;
    if (s.second && !s.second.has(date.getSeconds())) return false;
    if (s.minute && !s.minute.has(date.getMinutes())) return false;
    if (s.hour && !s.hour.has(date.getHours())) return false;
    if (s.dayOfMonth && !s.dayOfMonth.has(date.getDate())) return false;
    if (s.month && !s.month.has(date.getMonth() + 1)) return false;
    if (s.dayOfWeek && !s.dayOfWeek.has(date.getDay())) return false;
    return true;
  }

  function nextMatch(schedule, after) {
    const d = new Date(after.getTime());
    d.setMilliseconds(0);
    d.setSeconds(d.getSeconds() + 1);

    // Search up to 2 years ahead
    const limit = d.getTime() + 2 * 365 * 24 * 60 * 60 * 1000;
    while (d.getTime() < limit) {
      if (matches(schedule, d)) return d;
      // Advance by 1 second if using second-level, else 1 minute
      if (schedule.second && schedule.second.size < 60) {
        d.setSeconds(d.getSeconds() + 1);
      } else {
        d.setMinutes(d.getMinutes() + 1);
        d.setSeconds(0);
      }
    }
    return null;
  }

  class CronJob {
    #schedule;
    #fn;
    #timer = null;
    #running = false;
    #name;
    #lastRun = null;
    #runCount = 0;

    constructor(expression, fn, options = {}) {
      this.#schedule = parseCron(expression);
      this.#fn = fn;
      this.#name = options.name || expression;
      if (options.start !== false) this.start();
    }

    start() {
      if (this.#running) return this;
      this.#running = true;
      this.#tick();
      return this;
    }

    stop() {
      this.#running = false;
      if (this.#timer) {
        clearTimeout(this.#timer);
        this.#timer = null;
      }
      return this;
    }

    get running() { return this.#running; }
    get name() { return this.#name; }
    get lastRun() { return this.#lastRun; }
    get runCount() { return this.#runCount; }

    #tick() {
      if (!this.#running) return;
      const now = new Date();
      const next = nextMatch(this.#schedule, now);
      if (!next) { this.#running = false; return; }

      const delay = next.getTime() - Date.now();
      this.#timer = setTimeout(() => {
        if (!this.#running) return;
        this.#lastRun = new Date();
        this.#runCount++;
        try {
          const result = this.#fn();
          if (result && typeof result.catch === "function") {
            result.catch((e) => console.error(`[cron] ${this.#name}: ${e?.message || e}`));
          }
        } catch (e) {
          console.error(`[cron] ${this.#name}: ${e?.message || e}`);
        }
        this.#tick();
      }, Math.max(0, delay));
    }

    // Fire immediately, then continue schedule
    trigger() {
      this.#lastRun = new Date();
      this.#runCount++;
      const result = this.#fn();
      if (result && typeof result.catch === "function") {
        result.catch((e) => console.error(`[cron] ${this.#name}: ${e?.message || e}`));
      }
      return this;
    }
  }

  // malia.cron(expression, fn, options?)
  function cron(expression, fn, options) {
    return new CronJob(expression, fn, options);
  }
  cron.CronJob = CronJob;

  // Shorthand helpers
  cron.every = function (interval, fn, options) {
    if (typeof interval === "string") {
      const match = interval.match(/^(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hours?)$/i);
      if (!match) throw new Error(`Invalid interval: "${interval}". Use "5s", "10m", "1h", etc.`);
      const n = parseInt(match[1], 10);
      const unit = match[2][0].toLowerCase();
      if (unit === "s") return cron(`*/${n} * * * * *`, fn, options);
      if (unit === "m") return cron(`*/${n} * * * *`, fn, options);
      if (unit === "h") return cron(`0 */${n} * * *`, fn, options);
    }
    throw new Error(`Invalid interval: "${interval}"`);
  };

  cron.daily = (hour, minute, fn, options) => cron(`${minute || 0} ${hour || 0} * * *`, fn, options);
  cron.weekly = (day, hour, fn, options) => cron(`0 ${hour || 0} * * ${day || 0}`, fn, options);
  cron.monthly = (day, hour, fn, options) => cron(`0 ${hour || 0} ${day || 1} * *`, fn, options);

  globalThis.jse = globalThis.jse || {};
  globalThis.jse.cron = cron;
  globalThis.malia = globalThis.malia || globalThis.jse;
})(globalThis);
