# LiteSocket

**English | [简体中文](README_CN.md)**

One codebase, two builds: a complete Node.js library and a browser client that uses the native WebSocket API.

## Inspiration

The low-level transport layer, `LiteServer` / `LiteClient`, is inspired by [Socket.IO](https://socket.io/), providing connection lifecycle events, messages, heartbeats, and room broadcasts. Built on that layer, `IOServer` / `IOClient` simplify application APIs and add message dispatch, RPC, error codes, and diagnostics. The main use case is communication between game clients and Node.js servers.

**LiteSocket uses its own JSON message protocol and is not compatible with the Socket.IO or Engine.IO protocols.** Both ends must use LiteSocket or implement its protocol. Socket.IO clients and servers cannot be mixed directly with LiteSocket endpoints.

## Two API layers

| Layer | Server / client | Responsibilities |
| --- | --- | --- |
| Transport layer | `LiteServer` / `LiteClient` | WebSocket / WSS connections, string-named messages, lifecycle events, heartbeats, reconnection, size limits, and server-side room broadcasts |
| Application layer (recommended) | `IOServer` / `IOClient` | Message-ID dispatch and simpler registration/send APIs on top of the transport, plus session-based RPC, error codes, and timeout handling |

Use **`IOServer` / `IOClient`** for application development: `onMessage()` and `send()` handle ordinary messages, `onCallback()` registers RPC handlers, `asend()` returns an error code and results, and `asende()` returns only the error code. Use `LiteServer` / `LiteClient` directly when you want to organize string-named events and your own application protocol.

Connections and heartbeats belong to the transport layer and are reused by the IO layer. RPC sessions, results, and timeouts belong to the IO layer. The Socket.IO comparison below concerns the transport layer; the code examples use the recommended IO layer.

## Why build another library?

For applications that have already chosen WebSocket, this project provides a focused communication layer that is straightforward to maintain and adapt:

- **Explicit connection readiness:** `await connectPromise()` returns a connection result. A connection is ready only after the client receives the server's `system` message and completes protocol initialization.
- **Separate lifecycle events from application messages:** `onEvent()` handles client lifecycle events, while `on()` handles messages. The server uses `onClient()` for client connection events.
- **RPC shaped around application needs:** `IOServer` and `IOClient` use message IDs, session IDs, and error codes. `asend()` returns a result tuple; `asende()` returns only the error code.
- **Built-in diagnostics:** injectable logging, per-connection message observation, profiling, message size limits, and exception notifications.
- **A focused maintenance scope:** the browser uses native WebSocket and the server uses `ws`, concentrating the implementation on connections, heartbeats, reconnection, and message dispatch.

Readability, application integration, and maintenance scope are the main design goals. Socket.IO also provides Promise-based APIs and timeouts, and covers a broader range of transport and connection-management scenarios.

## Comparison with Socket.IO

This compares Socket.IO with `LiteServer` / `LiteClient`. Both provide bidirectional communication, connection notifications, heartbeat detection, and server-side room broadcasts. The application-level RPC extensions in `IOServer` / `IOClient` are described in the next section.

| Area | Socket.IO | LiteServer / LiteClient |
| --- | --- | --- |
| Transport | Engine.IO, with HTTP long-polling, WebSocket, and transport upgrades | WebSocket / WSS only; no long-polling fallback |
| Message protocol | Socket.IO / Engine.IO protocols | JSON `{ eventName, data }` packets, dispatched by string event names |
| Event registration | Multiple listeners per event | One handler per event or message; registering again replaces it and logs a warning |
| Connection handling | Connection events and connection management | `connectPromise()` waits for the `system` message before marking the protocol ready |
| Automatic reconnection | Available in the client | Disabled by default; enable exponential backoff with `autoReconnect` |
| Rooms and scaling | Rooms, namespaces, and multi-instance adapters | In-process rooms and broadcasts; no namespaces or cross-instance adapters |
| Connection recovery | Optional connection state recovery | Client message handlers survive reconnection; server application state and requests are not automatically restored or replayed |

The transport comparison refers to the official Socket.IO [feature overview](https://socket.io/docs/v4/how-it-works/) and [client API](https://socket.io/docs/v4/client-api/). Connection retries in LiteSocket do not imply message replay: persistence, application retries, and idempotency are application responsibilities.

## What IOServer / IOClient add

`IOServer` / `IOClient` provide application-facing APIs on top of `LiteServer` / `LiteClient`:

- **Message-ID dispatch:** register numeric message IDs with `onMessage()` and send ordinary messages with `send([messageId, ...args])`.
- **RPC:** register server handlers with `onCallback()`. Return an error code or `[errorCode, ...results]`, and await the matching result with `asend()`. The framework matches session IDs.
- **Consistent error handling:** `ErrorEnum` covers disconnected clients, missing handlers, invalid results, timeouts, disconnects, and send failures. Use `asende()` when only the error code matters.
- **Less application wiring:** `IOServer` manages message handlers and `IOServerSocket` instances. `IOClient.connectServer()` establishes the connection and binds dispatch, reusing transport logging, observation, and connection management.

Enable `checktimeout` on `IOClient` to check RPC deadlines. `checkIntervalMs` controls the polling interval; the client examples below enable it.

## Installation

```sh
pnpm add @mosnpm/litesocket
```

Use the package root, `@mosnpm/litesocket`, in Node.js. Use `@mosnpm/litesocket/client` in the browser. Both entry points include TypeScript declarations.

## Building from source

```sh
pnpm install
pnpm build
```

You can also run `pnpm build:full` or `pnpm build:client` separately. Each build cleans only its own output directory.

```text
lib/
├── full/                     # Complete Node.js library: CommonJS and .d.ts
│   ├── index.js
│   ├── index.d.ts
│   ├── net/
│   └── public/
└── client/                   # Browser client: no Node.js runtime dependencies
    ├── index.js              # ES module
    ├── index.d.ts            # Browser DOM types only
    ├── litesocket.global.js  # Classic script; global name: LiteSocket
    └── package.json
```

The full library includes `LiteServer`, `IOServer`, room management, and all client APIs. Its runtime dependencies are `ws`, `chalk`, and `tslib`. The browser client includes `LiteClient`, `IOClient`, RPC, message types, error codes, logging, and profiling APIs, without server implementations.

## Complete Node.js library

TypeScript, using the recommended application layer:

```ts
import { IOServer, ErrorEnum } from '@mosnpm/litesocket';
import type { IOServerSocket } from '@mosnpm/litesocket';

enum Message {
    Hello = 960001,
    HelloReply,
    Add,
}

async function main(): Promise<void> {
    const server = new IOServer('server', console);
    server.onMessage(Message.Hello, (socket: IOServerSocket, name: string) => {
        socket.send(Message.HelloReply, `Hello, ${name}!`);
    });
    server.onCallback(Message.Add, (_socket: IOServerSocket, a: number, b: number) => {
        return [ErrorEnum.ErrorOk, a + b];
    });
    const [ok, error] = await server.listen('server', 8080);
    if (!ok) throw error;
}

void main().catch(console.error);
```

The package root, `@mosnpm/litesocket`, exports `IOServer` and `IOClient`, as well as the low-level `LiteServer` / `LiteClient`. Node.js TypeScript projects can use `Node16` for both `module` and `moduleResolution`.

## Browser client

In a TypeScript browser project, import `IOClient` from the client entry point and let your bundler resolve it. The message IDs match the `IOServer` example above:

```ts
import { IOClient, ErrorEnum } from '@mosnpm/litesocket/client';

enum Message {
    Hello = 960001,
    HelloReply,
    Add,
}

const client = new IOClient('browser', console, {
    checktimeout: true,
    checkIntervalMs: 50,
});
client.onMessage(Message.HelloReply, (message: string) => {
    console.log(message);
});

async function main(): Promise<void> {
    const connected = await client.connectServer('ws://localhost:8080', reason => {
        console.warn('Disconnected:', reason);
    });
    if (!connected) throw new Error('Connection failed');
    client.send([Message.Hello, 'browser']);
    const [code, sum] = await client.asendMsg(Message.Add, 3, 5);
    if (code !== ErrorEnum.ErrorOk) throw new Error(`RPC failed: ${code}`);
    console.log('3 + 5 =', sum);
}

void main().catch(console.error);
```

Include `DOM` types in your browser TypeScript configuration; `moduleResolution: "bundler"` can resolve the `/client` entry point. Node.js clients use the same `IOClient` API, imported from `@mosnpm/litesocket`.

Without a bundler, serve the built ES module files from a static server:

```html
<script type="module">
  import { IOClient, ErrorEnum } from './lib/client/index.js';
  ...
</script>
```

A classic script build is also available:

```html
<script src="./lib/client/litesocket.global.js"></script>
<script>
  const { IOClient, ErrorEnum } = LiteSocket;
  ...
</script>
```

The browser build uses native `WebSocket` by default; you do not need to provide `createSocket`. The IO layer reuses transport connection and reconnection handling. Call `client.destroy("leaving page")` to close the connection and clear timers. For WSS, use a `wss://` URL; certificate validation is handled by the browser.

## Verification

Examples for both builds are available in [`example/lib/`](example/lib/README.md). Run `pnpm example:lib` to start the full-library server and try the client library in a browser.

```sh
pnpm test       # Source tests: connections, protocol, RPC, events, TLS, etc.
pnpm test:lib   # Build outputs, browser declarations, and client runtime tests
```

`test:lib` requires the native WebSocket implementation in Node.js 22+. Tests run in an isolated environment without `require`, `process`, or `Buffer`, using browser-style numeric timers and native WebSocket against a real server. They cover messages, binary JSON, RPC, timeouts, and reconnection. This verification does not launch a browser UI.
