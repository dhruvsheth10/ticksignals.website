const DEFAULT_MS = 45_000;

/**
 * Same as fetch, but aborts after `timeoutMs` so the UI is not stuck forever
 * when a request hangs (e.g. some privacy extensions or broken service workers).
 */
export function fetchWithTimeout(
    input: RequestInfo | URL,
    init: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
    const { timeoutMs = DEFAULT_MS, signal: userSignal, ...rest } = init;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    const onUserAbort = () => controller.abort();
    if (userSignal) {
        if (userSignal.aborted) controller.abort();
        else userSignal.addEventListener('abort', onUserAbort, { once: true });
    }

    return fetch(input, { ...rest, signal: controller.signal }).finally(() => {
        clearTimeout(t);
        userSignal?.removeEventListener('abort', onUserAbort);
    });
}
