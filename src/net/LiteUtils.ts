import { ErrorEnum } from './ErrorEnum';
import type { SendExceptionDetails } from './LiteNet';
import type { SocketReason } from './LiteSocket';
import type { SessionCallback } from './SessionCallback';

// 如果 data 太大、无法序列化，消息根本没发出去，自然也不会有响应。
export function settleSendFailure(callback: SessionCallback | undefined, reason: SocketReason, details?: SendExceptionDetails): void {
    if (!callback || !Array.isArray(details?.data)) return;
    const id = details.data[details.data.length - 1];
    if (!Number.isSafeInteger(id) || id <= 0) return;
    const pending = callback.callbacks[id];
    if (pending?.[0] === details.eventName && pending[1] === details.data) {
        callback.onSessionCallback(id, [ErrorEnum.settleSendFailure, String(reason)]);
    }
}

