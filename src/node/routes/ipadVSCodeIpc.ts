import { logger } from "@coder/logger"
import { Router as ExpressRouter } from "express"
import { IPCRawTransport, IServerChannel, PortChannelServer } from "../ipadVSCodeIpc"
import { Router as WsRouter, wss } from "../wsRouter"

/**
 * WebSocket endpoint the native Swift side (VSCodeIPCBridge.swift, in the
 * ipad-vscode app) relays the desktop workbench bundle's Electron-IPC
 * frames (vscode:hello / vscode:message / vscode:disconnect) over, since
 * there's no real Electron ipcRenderer/ipcMain and no fork()'d main
 * process here -- the frames terminate in THIS already-running code-server
 * Node process instead. See ipad-vscode's README.md "Architecture pivot"
 * section and VSCodeIPCBridge.swift's own doc comment for the full
 * end-to-end picture; ../ipadVSCodeIpc.ts is the wire-protocol codec this
 * route wires up to a real transport.
 *
 * Loopback-only by construction (this whole server only ever binds
 * 127.0.0.1 -- see NodeRuntimeController.swift's --bind-addr), so this
 * intentionally has no auth/origin check beyond what the rest of this
 * app's routes already apply globally.
 */
export const router = ExpressRouter()
export const wsRouter = WsRouter()

/**
 * Channels available on this server, registered once at module load
 * (not per-connection) so `PortChannelServer.create` always has the
 * full set. Currently just `ping` -- a deliberate, minimal diagnostic
 * channel proving the full round trip (WKWebView -> VSCodeIPCBridge ->
 * this WebSocket -> PortChannelServer -> channel.call -> reply ->
 * back), not a stand-in for any real vscode channel name. Real channels
 * (nativeHost, workspaces, etc. -- see README.md's IPC-channel list)
 * get added here one at a time as they're actually implemented; there
 * is deliberately no attempt yet to register all ~31 by name with stub
 * bodies, since an unregistered channel already fails cleanly (a real,
 * catchable "Unknown channel" PromiseError -- see PortChannelServer)
 * rather than silently.
 */
const channels = new Map<string, IServerChannel>([
  [
    "ipadVSCodePing",
    {
      async call(command: string, arg: unknown): Promise<unknown> {
        if (command === "ping") {
          return { pong: true, receivedArg: arg, serverTime: Date.now() }
        }
        throw new Error(`ipadVSCodePing: unknown command '${command}'`)
      },
    },
  ],
])

wsRouter.ws("/", async (req) => {
  wss.handleUpgrade(req, req.ws, req.head, (ws) => {
    const transport: IPCRawTransport = {
      send: (data) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(data)
        }
      },
      onMessage: (listener) => {
        ws.on("message", (data) => {
          // `ws` delivers a Buffer for binary frames (the only kind this
          // protocol ever sends -- see VSCodeIPCBridge.swift, which
          // always posts base64-decoded-then-re-encoded binary), but
          // guard the shape rather than assume it.
          if (Buffer.isBuffer(data)) {
            listener(data)
          } else if (Array.isArray(data)) {
            listener(Buffer.concat(data))
          }
        })
      },
      onClose: (listener) => {
        ws.on("close", listener)
      },
    }

    try {
      PortChannelServer.create(transport, channels)
    } catch (err) {
      logger.error(`ipadVSCodeIpc: failed to start PortChannelServer: ${err}`)
      ws.close()
    }

    req.ws.resume()
  })
})
