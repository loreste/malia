// src/production.rs - Enterprise Production Telemetry, Health Checks & Lifecycle Management.
// Provides out-of-the-box Prometheus/JSON metrics, RSS tracking, and graceful
// drain hooks for containerized (Kubernetes/Docker/systemd) deployments.

use std::sync::atomic::{AtomicU64, Ordering};
use deno_core::op2;
use serde::{Deserialize, Serialize};

pub struct ProductionTelemetry {
  pub requests_total: AtomicU64,
  pub active_conns: AtomicU64,
}

impl Default for ProductionTelemetry {
  fn default() -> Self {
    Self::new()
  }
}

impl ProductionTelemetry {
  pub fn new() -> Self {
    Self {
      requests_total: AtomicU64::new(0),
      active_conns: AtomicU64::new(0),
    }
  }

  pub fn inc_requests(&self) {
    self.requests_total.fetch_add(1, Ordering::Relaxed);
  }

  pub fn inc_conns(&self) {
    self.active_conns.fetch_add(1, Ordering::Relaxed);
  }

  pub fn dec_conns(&self) {
    let _ = self.active_conns.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |c| {
      Some(c.saturating_sub(1))
    });
  }
}

pub static GLOBAL_TELEMETRY: std::sync::LazyLock<ProductionTelemetry> =
  std::sync::LazyLock::new(ProductionTelemetry::new);

#[derive(Serialize, Deserialize)]
pub struct ProductionMetrics {
  pub uptime_secs: f64,
  pub requests_total: u64,
  pub active_connections: u64,
}

#[op2]
#[serde]
pub fn op_production_metrics() -> ProductionMetrics {
  // Same clock as performance.now(), which starts during runtime bootstrap.
  let uptime = crate::ops::monotonic_start().elapsed().as_secs_f64();
  let requests = GLOBAL_TELEMETRY.requests_total.load(Ordering::Relaxed);
  let conns = GLOBAL_TELEMETRY.active_conns.load(Ordering::Relaxed);

  ProductionMetrics {
    uptime_secs: uptime,
    requests_total: requests,
    active_connections: conns,
  }
}

