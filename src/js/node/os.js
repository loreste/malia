// node:os — uname, memory, and network interfaces from host ops.
const ops = Deno.core.ops;

let info = null;
function osInfo() {
  if (info === null) info = ops.op_os_info();
  return info;
}

export function platform() {
  return ops.op_platform();
}

export function arch() {
  return ops.op_arch();
}

export function cpus() {
  const n = ops.op_cpus();
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ model: "jse-cpu", speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } });
  }
  return out;
}

export function homedir() {
  return process.env.HOME || "/";
}

// Node's lookup order, without a trailing separator (except a drive root).
export function tmpdir() {
  const env = process.env;
  if (process.platform === "win32") {
    const dir = env.TEMP || env.TMP || `${env.SystemRoot || env.windir}\\temp`;
    return dir.length > 1 && dir.endsWith("\\") && !dir.endsWith(":\\") ? dir.slice(0, -1) : dir;
  }
  const dir = env.TMPDIR || env.TMP || env.TEMP || "/tmp";
  return dir.length > 1 && dir.endsWith("/") ? dir.slice(0, -1) : dir;
}


export function hostname() {
  return osInfo().hostname;
}

export function type() {
  return osInfo().sysname;
}

export function release() {
  return osInfo().release;
}

export function version() {
  return osInfo().version;
}

export function machine() {
  return osInfo().machine;
}

export function totalmem() {
  return ops.op_meminfo().total;
}

export function freemem() {
  return ops.op_meminfo().free;
}

export function endianness() {
  const probe = new Uint16Array([0x1234]);
  return new Uint8Array(probe.buffer)[0] === 0x34 ? "LE" : "BE";
}

export function networkInterfaces() {
  const out = {};
  for (const nic of ops.op_network_interfaces()) {
    if (!out[nic.name]) out[nic.name] = [];
    out[nic.name].push({
      address: nic.address,
      netmask: nic.netmask,
      family: nic.family,
      mac: "00:00:00:00:00:00",
      internal: nic.internal,
      cidr: null,
    });
  }
  return out;
}

export function userInfo() {
  const raw = osInfo();
  return {
    uid: raw.uid,
    gid: raw.gid,
    username: process.env.USER || process.env.LOGNAME || "",
    homedir: homedir(),
    shell: process.env.SHELL || "",
  };
}

export function availableParallelism() {
  return ops.op_cpus();
}

export function uptime() {
  return typeof process.uptime === "function" ? process.uptime() : 0;
}

export function loadavg() {
  return [0.0, 0.0, 0.0];
}

export const constants = {
  UV_UDP_REUSEADDR: 4,
  signals: {},
  errno: {},
  priority: {
    PRIORITY_LOW: 19,
    PRIORITY_BELOW_NORMAL: 10,
    PRIORITY_NORMAL: 0,
    PRIORITY_ABOVE_NORMAL: -10,
    PRIORITY_HIGH: -19,
    PRIORITY_HIGHEST: -20,
  },
};

export function getPriority(pid = 0) {
  return 0;
}

export function setPriority(pid = 0, priority = 0) {}

export const EOL = "\n";
export const devNull = "/dev/null";

export default {
  platform,
  arch,
  cpus,
  homedir,
  tmpdir,
  hostname,
  type,
  release,
  version,
  machine,
  totalmem,
  freemem,
  endianness,
  networkInterfaces,
  userInfo,
  availableParallelism,
  uptime,
  loadavg,
  constants,
  getPriority,
  setPriority,
  EOL,
  devNull,
};

