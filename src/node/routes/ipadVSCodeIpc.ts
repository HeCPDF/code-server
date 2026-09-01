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
 * Real vscode channel names this server understands so far, matching
 * exactly what vscode's own `ChannelClient.getChannel(name)` calls will
 * ask for -- verified from real source, not guessed (see each channel's
 * own comment for its citation). An unregistered channel already fails
 * cleanly (a real, catchable "Unknown channel" PromiseError -- see
 * PortChannelServer) rather than hanging or silently doing nothing, so
 * there is deliberately no attempt yet to register all ~31 by name with
 * stub bodies -- only channels with a real implementation are listed
 * here, one at a time, as they're actually built.
 *
 * A factory (not a static map) so each connection's channel instances
 * can close over that connection's own `transport` -- see
 * `IPCRawTransport.sendText`'s doc comment on why `menubar` needs this.
 */
function makeChannels(transport: IPCRawTransport): ReadonlyMap<string, IServerChannel> {
  return new Map<string, IServerChannel>([
    [
      // Not a real vscode channel name -- a deliberate, minimal
      // diagnostic channel proving the full round trip (WKWebView ->
      // VSCodeIPCBridge -> this WebSocket -> PortChannelServer ->
      // channel.call -> reply -> back) before any real channel existed.
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
    [
      // Real vscode channel (src/vs/platform/menubar/{common,electron-main}/menubar.ts,
      // registered as "menubar" in app.ts's initChannels -- see
      // ipad-vscode's README.md "Architecture pivot" section's channel
      // list). ICommonMenubarService's one method,
      // `updateMenubar(windowId: number, menuData: IMenubarData): Promise<void>`,
      // is how the *renderer* pushes its own menu-registry-computed
      // menu tree TO the main process -- real Electron just turns
      // menuData into a native Menu via Menu.buildFromTemplate. There's
      // no such thing here, so this channel's only job is forwarding
      // menuData onward to the native Swift layer (which owns the real
      // menu bar) as an out-of-band push -- see
      // NativeMenubarStore.swift on that side.
      //
      // ProxyChannel.fromService's real `call()` (ipc.ts) does
      // `target.apply(handler, args)` -- confirming `arg` on the wire
      // is a plain positional-args array, `[windowId, menuData]` here,
      // not a single object.
      "menubar",
      {
        async call(command: string, arg: unknown): Promise<unknown> {
          if (command === "updateMenubar") {
            const [, menuData] = arg as [number, unknown]
            transport.sendText(JSON.stringify({ kind: "menubarUpdate", data: menuData }))
            return undefined
          }
          throw new Error(`menubar: unknown command '${command}'`)
        },
      },
    ],
  ])
}

wsRouter.ws("/", async (req) => {
  wss.handleUpgrade(req, req.ws, req.head, (ws) => {
    const transport: IPCRawTransport = {
      send: (data) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(data)
        }
      },
      sendText: (text) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(text)
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
      PortChannelServer.create(transport, makeChannels)
    } catch (err) {
      logger.error(`ipadVSCodeIpc: failed to start PortChannelServer: ${err}`)
      ws.close()
    }

    req.ws.resume()
  })
})
