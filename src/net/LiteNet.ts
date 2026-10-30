// LiteNet.ts 提供公共的结构

import { colors } from "../public/color";

/**
 * Handshake values expressed from the receiving client perspective.
 */
export interface SocketSysMessage {
	/**
	 * Positive server-assigned connection ID.
	 */
	id: number;
	/**
	 * Exclusive client outgoing string-length limit, copied from the server receive limit.
	 */
	maxSendLen: number;
	/**
	 * Exclusive client incoming string-length limit, copied from the server send limit.
	 */
	maxRecvLen: number;
}

/**
 * Token bucket for valid non-heartbeat messages; exhaustion disconnects the sender.
 */
export interface MessageRateLimit {
	/**
	 * Positive token refill rate in business messages per second.
	 */
	perSecond: number;
	/**
	 * Positive integer token capacity and initial allowance.
	 */
	burst: number;
}

/**
 * Optional server transport overrides, merged with defaults.
 */
export interface LiteOptionsInput {
	/** TLS private-key path relative to the process working directory; certfile is also required. */
	keyfile?: string;
	/**
	 * TLS certificate path relative to the process working directory; keyfile must also be supplied.
	 */
	certfile?: string;
	/**
	 * Heartbeat check interval in milliseconds.
	 * @defaultValue 10000
	 */
	heartbeatInterval?: number;
	/**
	 * Maximum pong age accepted at a heartbeat check, in milliseconds.
	 * @defaultValue 15000
	 */
	heartbeatTimeout?: number;
	/**
	 * Exclusive outgoing JSON string-length limit in UTF-16 code units, not UTF-8 bytes.
	 * @defaultValue 1048576
	 */
	maxSendLen?: number;
	/**
	 * Exclusive incoming JSON string-length limit, in UTF-16 code units, checked after decoding.
	 * @defaultValue 1048576
	 */
	maxRecvLen?: number;
	/**
	 * Optional per-connection business-message token bucket; omitted means unlimited.
	 */
	messageRateLimit?: MessageRateLimit;
}

/**
 * Resolved server transport configuration.
 */
export interface LiteOptions {
	/**
	 * TLS private-key path relative to the process working directory; certfile must also be supplied.
	 */
	keyfile?: string;
	/**
	 * TLS certificate path relative to the process working directory; keyfile must also be supplied.
	 */
	certfile?: string;
	/**
	 * Heartbeat check interval in milliseconds.
	 * @defaultValue 10000
	 */
	heartbeatInterval: number;
	/**
	 * Maximum pong age accepted at a heartbeat check, in milliseconds.
	 * @defaultValue 15000
	 */
	heartbeatTimeout: number;
	/**
	 * Exclusive outgoing JSON string-length limit in UTF-16 code units, not UTF-8 bytes.
	 * @defaultValue 1048576
	 */
	maxSendLen: number;
	/**
	 * Exclusive incoming JSON string-length limit, in UTF-16 code units, checked after decoding.
	 * @defaultValue 1048576
	 */
	maxRecvLen: number;
	/**
	 * Optional per-connection business-message token bucket; omitted means unlimited.
	 */
	messageRateLimit?: MessageRateLimit;
}

/**
 * Diagnostic context for broadcast serialization or size failure.
 */
export interface BroadcastExceptionDetails {
	eventName: string;
	/**
	 * Encoded JSON length in UTF-16 code units, if encoding succeeded.
	 */
	length?: number;
	/**
	 * Configured outgoing JSON string-length limit.
	 */
	limit: number;
	/**
	 * Room name, if this failure came from a room broadcast.
	 */
	room?: string;
	/** Original serialization error, if encoding failed. */
	error?: unknown;
}

/**
 * Diagnostic context for serialization, size, or synchronous send failure.
 */
export interface SendExceptionDetails {
	eventName: string;
	/**
	 * Original payload reference; RPC failure settlement matches this same reference.
	 */
	data: any;
	/** Original serialization or transport error, when available. */
	error?: unknown;
}

/**
 * Formats a diagnostic prefix with optional warning/error coloring.
 * @param name - Diagnostic label.
 */
export function logHeadEx(classname: string, name: string|number, func: string, logtype?: string) {
	let prefix = '';
	if (logtype === 'error') {
		prefix = colors.red('[ERROR]');
	} else if (logtype === 'warn') {
		prefix = colors.yellow('[WARN]');
	} else {
		return `[${classname}] ${name} ${func}`;
	}
	return `${prefix} [${classname}] ${name} ${func}`;
}


export const msgSendMax = 'send >= maxSendLen'
export const msgJsonParseError = 'JSON.parse error'
export const msgRecvMax = 'recv >= maxRecvLen'
export const msgJsonStringError = 'JSON.stringify error'
export const msgInvalidPacket = 'invalid packet'
export const msgSendError = 'WebSocket.send error'

/**
 * Cause of established connection loss.
 */
export type DisconnectReason = 'close' | 'error' | 'pong-timeout';
/**
 * Failure reason before the system handshake completes.
 */
export type ConnectFailedReason = 'close' | 'error' | 'timeout';

/**
 * Client lifecycle and diagnostic names, separate from business messages.
 */
export type socketClientEvent =
	| 'connect'
	| 'disconnect'
	| 'connect_fail'
	| 'reconnect'
	| 'reconnect_fail'
	| 'retries_exhausted'
	| 'pong-timeout'
	| 'close'
	| 'error'
	| 'exception';

/**
 * Transport operations shared by clients and server-side connections.
 */
export interface CommonSocket {
  /** Sends a named event with an optional payload. */
  emit(event: string, data?: any): void;
  /** Disables or restores pong replies for heartbeat diagnostics. */
  stopPong(stop: boolean): void; // 有的实现可能没有，设为可选
  /** Sends an already encoded string without framing or size validation. */
  wsSend(s: string): void;
  /** Reports whether the transport is ready for business messages. */
  isConnected(): boolean;
  /** Returns the mean estimated one-way delay in milliseconds. */
  getArgDelay(): number;
  /** Requests a closing handshake; reason must fit the WebSocket 123-byte UTF-8 limit. */
  close(code: SocketCloseCode, reason?: string): void;
  /** Requests disconnection with an application close code and diagnostic reason. */
  disconnect(code: SocketCloseCode, reason: string): void;
}

// common types
/**
 * Client transport contract including message and lifecycle registration.
 */
export interface CommonClient extends CommonSocket {
  /** Registers one business transport handler; later registration replaces it. */
  on(event: string, handler: (data?: any) => void): void;
  /** Adds a lifecycle observer; multiple observers are supported. */
  onEvent(event: string, handler: (payload?: any, err?: Error) => void): void;
  /** Returns the connection ID assigned by the server handshake. */
  getServerId(): number;
  /** Returns negotiated system handshake data. */
  getSys(): any;
}


/**
 * Application-specific WebSocket close codes in the private-use range.
 */
export enum SocketCloseCode {
	normal = 4000, // 正常关闭!
	heartbreak ,
	connect_timeout ,
	disconnect ,	
	stop ,	
	test ,
}

/**
 * Builds a ws:// or wss:// endpoint from host, port, and TLS selection.
 * @param port - TCP port; zero requests an OS-assigned port.
 */
export function getWsUrl(ip: string, port:number, secure = false){
	return `${secure ? 'wss' : 'ws'}://${ip}:${port}`
}
