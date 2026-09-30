// node:ws — standards-compliant WebSocket and WebSocketServer shim.
import { EventEmitter } from "node:events";

export const WebSocket = globalThis.WebSocket;

export class WebSocketServer extends EventEmitter {
  constructor(options = {}, callback) {
    super();
    this.options = options;
    this.clients = new Set();
    this._server = null;

    if (options.port) {
      this._server = jse.serve({
        port: options.port,
        host: options.host || "0.0.0.0",
        handler: (req) => {
          const upgradeHeader = req.headers.get("upgrade");
          if (upgradeHeader && upgradeHeader.toLowerCase() === "websocket") {
            const { response, socket } = jse.upgradeWebSocket(req);
            this.clients.add(socket);
            socket.on("close", () => this.clients.delete(socket));
            this.emit("connection", socket, req);
            return response;
          }
          return new Response("Expected WebSocket Upgrade", { status: 426 });
        },
      });
      if (typeof callback === "function") {
        queueMicrotask(() => callback());
      }
      queueMicrotask(() => this.emit("listening"));
    }
  }

  address() {
    return {
      address: this.options.host || "127.0.0.1",
      port: this.options.port || 0,
      family: "IPv4",
    };
  }

  close(cb) {
    if (this._server) {
      this._server.close();
      this._server = null;
    }
    for (const client of this.clients) {
      try {
        client.close(1001, "Server closing");
      } catch (_) {}
    }
    this.clients.clear();
    this.emit("close");
    if (typeof cb === "function") queueMicrotask(() => cb());
  }
}

export function createWebSocketStream(ws, options) {
  return ws;
}

export default WebSocket;
