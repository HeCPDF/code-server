/**
 * A from-scratch, faithful port of just the wire protocol from vscode's
 * own `src/vs/base/parts/ipc/common/ipc.ts` (`ChannelServer`, `serialize`/
 * `deserialize`, the VQL integer encoding) — ported by hand rather than
 * `require()`d from the vscode payload this app already bundles, since
 * that payload is built for the `vscode-reh-web` target
 * (`gulpfile.reh.ts` explicitly excludes `electron-browser/**` etc.) and
 * whether `vs/base/parts/ipc/common/ipc.js` survives tree-shaking there
 * isn't something to assume without checking. This file has zero runtime
 * dependency on the bundled vscode payload; it only needs to speak the
 * exact same bytes vscode's own `ChannelClient`
 * (`vs/base/parts/ipc/electron-browser/ipc.electron.ts`, running inside
 * ipad-vscode's separately-built desktop workbench bundle — see
 * ipad-vscode's README.md "Architecture pivot" section) already emits.
 *
 * Every byte shape below (the `DataType` tag values, the VQL
 * variable-length integer encoding, the `[type, id, channelName, name]`
 * header array, the `RequestType`/`ResponseType` numeric codes) is copied
 * from the real fetched source at the same pinned commit this project
 * always uses (`08d4889f9ec4a1685d257b9b95de036c8e1ce1e5`), not guessed.
 * Uses plain Node `Buffer` instead of vscode's own `VSBuffer` wrapper —
 * `Buffer` already provides the same `readUInt8`/`writeUInt8`/`concat`
 * primitives `VSBuffer` wraps, so there was nothing to port there.
 *
 * What this does NOT implement: `IPCServer`'s multi-connection routing
 * (this app only ever has one client — the one WKWebView — so there's
 * nothing to route between; each WebSocket connection gets its own
 * `PortChannelServer` directly, skipping that layer), event listening
 * cancellation edge cases beyond what's needed for correctness, and any
 * actual service logic — `registerChannel` is the seam callers use to
 * plug in real handlers (see routes/ipadVSCodeIpc.ts for the first one).
 */

const enum DataType {
  Undefined = 0,
  String = 1,
  Buffer = 2,
  VSBuffer = 3,
  Array = 4,
  Object = 5,
  Int = 6,
}

const enum RequestType {
  Promise = 100,
  PromiseCancel = 101,
  EventListen = 102,
  EventDispose = 103,
}

const enum ResponseType {
  Initialize = 200,
  PromiseSuccess = 201,
  PromiseError = 202,
  PromiseErrorObj = 203,
  EventFire = 204,
}

function writeInt32VQL(chunks: Buffer[], value: number): void {
  if (value === 0) {
    chunks.push(Buffer.from([0]))
    return
  }
  const bytes: number[] = []
  for (let v = value; v !== 0;) {
    let byte = v & 0b01111111
    v = v >>> 7
    if (v > 0) {
      byte |= 0b10000000
    }
    bytes.push(byte)
  }
  chunks.push(Buffer.from(bytes))
}

class BufferCursor {
  private pos = 0
  constructor(private readonly buffer: Buffer) {}

  readByte(): number {
    return this.buffer[this.pos++]
  }

  read(length: number): Buffer {
    const result = this.buffer.subarray(this.pos, this.pos + length)
    this.pos += length
    return result
  }
}

function readIntVQL(cursor: BufferCursor): number {
  let value = 0
  for (let n = 0; ; n += 7) {
    const next = cursor.readByte()
    value |= (next & 0b01111111) << n
    if (!(next & 0b10000000)) {
      return value
    }
  }
}

/** Matches vscode's real `serialize()` (ipc.ts) exactly -- see this file's header comment. */
export function ipcSerialize(chunks: Buffer[], data: unknown): void {
  if (typeof data === "undefined") {
    chunks.push(Buffer.from([DataType.Undefined]))
  } else if (typeof data === "string") {
    const buf = Buffer.from(data, "utf8")
    chunks.push(Buffer.from([DataType.String]))
    writeInt32VQL(chunks, buf.byteLength)
    chunks.push(buf)
  } else if (Buffer.isBuffer(data)) {
    chunks.push(Buffer.from([DataType.Buffer]))
    writeInt32VQL(chunks, data.byteLength)
    chunks.push(data)
  } else if (Array.isArray(data)) {
    chunks.push(Buffer.from([DataType.Array]))
    writeInt32VQL(chunks, data.length)
    for (const el of data) {
      ipcSerialize(chunks, el)
    }
  } else if (typeof data === "number" && (data | 0) === data) {
    chunks.push(Buffer.from([DataType.Int]))
    writeInt32VQL(chunks, data)
  } else {
    const buf = Buffer.from(JSON.stringify(data), "utf8")
    chunks.push(Buffer.from([DataType.Object]))
    writeInt32VQL(chunks, buf.byteLength)
    chunks.push(buf)
  }
}

/** Matches vscode's real `deserialize()` (ipc.ts) exactly -- see this file's header comment. */
export function ipcDeserialize(cursor: BufferCursor): unknown {
  const type = cursor.readByte()
  switch (type) {
    case DataType.Undefined:
      return undefined
    case DataType.String:
      return cursor.read(readIntVQL(cursor)).toString("utf8")
    case DataType.Buffer:
    case DataType.VSBuffer:
      return Buffer.from(cursor.read(readIntVQL(cursor)))
    case DataType.Array: {
      const length = readIntVQL(cursor)
      const result: unknown[] = []
      for (let i = 0; i < length; i++) {
        result.push(ipcDeserialize(cursor))
      }
      return result
    }
    case DataType.Object:
      return JSON.parse(cursor.read(readIntVQL(cursor)).toString("utf8"))
    case DataType.Int:
      return readIntVQL(cursor)
    default:
      throw new Error(`ipadVSCodeIpc: unknown DataType tag ${type}`)
  }
}

export function encodeMessage(header: unknown, body: unknown): Buffer {
  const chunks: Buffer[] = []
  ipcSerialize(chunks, header)
  ipcSerialize(chunks, body)
  return Buffer.concat(chunks)
}

function decodeMessage(message: Buffer): { header: unknown[]; body: unknown } {
  const cursor = new BufferCursor(message)
  const header = ipcDeserialize(cursor) as unknown[]
  const body = ipcDeserialize(cursor)
  return { header, body }
}

/**
 * Minimal transport contract this server needs from its caller -- deliberately
 * NOT tied to `ws`'s `WebSocket` type here, so this file stays testable/
 * reusable independent of the actual transport (see
 * routes/ipadVSCodeIpc.ts for the real `ws` binding).
 */
export interface IPCRawTransport {
  send(data: Buffer): void
  onMessage(listener: (data: Buffer) => void): void
  onClose(listener: () => void): void
}

/**
 * One per connected client (one per WKWebView connection -- see this
 * file's header comment on why `IPCServer`'s multi-connection routing
 * isn't ported). Mirrors `ChannelServer`'s real dispatch loop
 * (`onRawMessage`/`onPromise`/`sendResponse` in ipc.ts) closely enough
 * that the exact same request/response shapes real vscode's
 * `ChannelClient` expects are produced, but simplified: no
 * `pendingRequests`-until-channel-registered buffering (channels here
 * are all registered up front, before any connection is accepted -- see
 * `PortChannelServer.create`), and `EventListen`/`EventDispose` are
 * handled but most registered channels are not expected to have real
 * events yet.
 */
export class PortChannelServer {
  private readonly channels = new Map<string, IServerChannel>()
  private readonly activeRequests = new Map<number, { dispose(): void }>()

  private constructor(private readonly transport: IPCRawTransport) {
    this.transport.onMessage((data) => this.onRawMessage(data))
    this.transport.onClose(() => {
      for (const req of this.activeRequests.values()) {
        req.dispose()
      }
      this.activeRequests.clear()
    })
    this.sendResponse([ResponseType.Initialize])
  }

  static create(transport: IPCRawTransport, channels: ReadonlyMap<string, IServerChannel>): PortChannelServer {
    const server = new PortChannelServer(transport)
    for (const [name, channel] of channels) {
      server.channels.set(name, channel)
    }
    return server
  }

  private sendResponse(header: unknown[], body?: unknown): void {
    try {
      this.transport.send(encodeMessage(header, body))
    } catch {
      // The far side (WKWebView) may already be gone -- nothing to do.
    }
  }

  private onRawMessage(data: Buffer): void {
    let decoded: { header: unknown[]; body: unknown }
    try {
      decoded = decodeMessage(data)
    } catch (err) {
      logIpcError("failed to decode incoming IPC frame", err)
      return
    }
    const { header, body } = decoded
    const type = header[0] as RequestType

    switch (type) {
      case RequestType.Promise:
        return this.onPromise({
          id: header[1] as number,
          channelName: header[2] as string,
          name: header[3] as string,
          arg: body,
        })
      case RequestType.EventListen:
        return this.onEventListen({
          id: header[1] as number,
          channelName: header[2] as string,
          name: header[3] as string,
          arg: body,
        })
      case RequestType.PromiseCancel:
      case RequestType.EventDispose:
        return this.disposeActiveRequest(header[1] as number)
    }
  }

  private onPromise(request: { id: number; channelName: string; name: string; arg: unknown }): void {
    const channel = this.channels.get(request.channelName)
    if (!channel) {
      this.sendResponse([ResponseType.PromiseError, request.id], {
        name: "Unknown channel",
        message: `Channel name '${request.channelName}' is not registered`,
        stack: undefined,
      })
      return
    }

    let cancelled = false
    let promise: Promise<unknown>
    try {
      promise = channel.call(request.name, request.arg, () => cancelled)
    } catch (err) {
      promise = Promise.reject(err)
    }

    promise
      .then((data) => {
        if (!cancelled) {
          this.sendResponse([ResponseType.PromiseSuccess, request.id], data)
        }
      })
      .catch((err) => {
        if (cancelled) {
          return
        }
        if (err instanceof Error) {
          this.sendResponse([ResponseType.PromiseError, request.id], {
            message: err.message,
            name: err.name,
            stack: err.stack ? err.stack.split("\n") : undefined,
          })
        } else {
          this.sendResponse([ResponseType.PromiseErrorObj, request.id], err)
        }
      })
      .finally(() => {
        this.activeRequests.delete(request.id)
      })

    this.activeRequests.set(request.id, {
      dispose: () => {
        cancelled = true
      },
    })
  }

  private onEventListen(request: { id: number; channelName: string; name: string; arg: unknown }): void {
    const channel = this.channels.get(request.channelName)
    if (!channel || !channel.listen) {
      // No event support on this channel (yet) -- silently ignored rather
      // than erroring; the caller (vscode's own ChannelClient) tolerates
      // an event that simply never fires.
      return
    }
    const disposable = channel.listen(request.name, request.arg, (data) => {
      this.sendResponse([ResponseType.EventFire, request.id], data)
    })
    this.activeRequests.set(request.id, disposable)
  }

  private disposeActiveRequest(id: number): void {
    const req = this.activeRequests.get(id)
    if (req) {
      req.dispose()
      this.activeRequests.delete(id)
    }
  }
}

/**
 * A registered channel's implementation. `call` mirrors real vscode's
 * `IServerChannel.call` (minus the `TContext`/`CancellationToken` object --
 * just a plain `() => boolean` cancelled-check, enough for what this
 * project's own channel implementations need so far).
 */
export interface IServerChannel {
  call(command: string, arg: unknown, isCancelled: () => boolean): Promise<unknown>
  listen?(event: string, arg: unknown, fire: (data: unknown) => void): { dispose(): void }
}

function logIpcError(message: string, err: unknown): void {
  console.error(`[ipadVSCodeIpc] ${message}:`, err)
}
