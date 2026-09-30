import { isMainThread, parentPort, workerData } from "node:worker_threads";

if (isMainThread) throw new Error("worker script ran on the main thread");
parentPort.postMessage({ echo: workerData });
