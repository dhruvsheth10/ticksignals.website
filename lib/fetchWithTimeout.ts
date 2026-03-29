const DEFAULT_MS = 45_000;

function abortError(): Error {
    const e = new Error('The operation was aborted');
    e.name = 'AbortError';
    return e;
}

/**
 * fetch() that aborts the TCP request after `timeoutMs`.
 * Note: in browsers the fetch promise may settle when headers arrive; a stalled
 * response body can still hang `response.json()`. Prefer `fetchJsonWithTimeout`
 * for API calls that parse JSON.
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

/**
 * Fetches and parses JSON with a single deadline for the whole operation
 * (connection + download + parse). Avoids infinite "loading" when the body
 * never finishes or `json()` never completes.
 */
export function fetchJsonWithTimeout<T = unknown>(
    input: RequestInfo | URL,
    init: RequestInit & { timeoutMs?: number } = {}
): Promise<{ response: Response; data: T }> {
    const { timeoutMs = DEFAULT_MS, ...rest } = init;

    return new Promise((resolve, reject) => {
        let settled = false;
        const id = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(abortError());
        }, timeoutMs);

        void (async () => {
            try {
                const response = await fetch(input, rest);
                const data = (await response.json()) as T;
                if (settled) return;
                settled = true;
                clearTimeout(id);
                resolve({ response, data });
            } catch (err) {
                if (settled) return;
                settled = true;
                clearTimeout(id);
                reject(err);
            }
        })();
    });
}
