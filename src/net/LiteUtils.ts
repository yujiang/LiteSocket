import { ErrorEnum } from './ErrorEnum';
import type { SendExceptionDetails } from './LiteNet';
import type { SocketReason } from './LiteSocket';
import type { SessionCallback } from './SessionCallback';

// 如果 data 太大、无法序列化，消息根本没发出去，自然也不会有响应。
// use by IOClient and IOServerSocket 清除callback的数据
export function settleSendFailure(callback: SessionCallback | undefined, reason: SocketReason, details?: SendExceptionDetails): void {
    if (!callback || !Array.isArray(details?.data)) return;
    callback.onSendFailed(reason, details)
}

