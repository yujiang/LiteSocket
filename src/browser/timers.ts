function abortError(): Error {
    return new DOMException('The operation was aborted', 'AbortError');
}

// 对应 node:timers/promises 中用于退避重连的可取消 delay。
export function setTimeout<T = undefined>(
    ms: number, value?: T, options: { signal?: AbortSignal } = {},
): Promise<T> {
    const { signal } = options;
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise<T>((resolve, reject) => {
        const timer = globalThis.setTimeout(() => {
            signal?.removeEventListener('abort', cancel);
            resolve(value);
        }, ms);
        function cancel() {
            globalThis.clearTimeout(timer);
            signal?.removeEventListener('abort', cancel);
            reject(abortError());
        }
        signal?.addEventListener('abort', cancel, { once: true });
    });
}
