const DEFAULT_MS = 45_000;

/**
 * Resilient JSON fetch:
 *   1. Adds a cache-busting `_t` query param to defeat stale caches / service workers.
 *   2. Uses `response.text()` + `JSON.parse()` instead of `response.json()`
 *      so browser extensions that patch `Response.prototype.json` (e.g. MetaMask
 *      SES lockdown) can't silently break parsing.
 *   3. Wraps everything in a single deadline (connect + body + parse).
 *   4. Retries up to `retries` times on transient failures.
 */
export async function fetchJsonWithTimeout<T = unknown>(
    input: RequestInfo | URL,
    init: RequestInit & { timeoutMs?: number; retries?: number } = {}
): Promise<{ response: Response; data: T }> {
    const { timeoutMs = DEFAULT_MS, retries = 2, ...fetchInit } = init;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            const separator = url.includes('?') ? '&' : '?';
            const bustUrl = `${url}${separator}_t=${Date.now()}`;

            const response = await fetch(bustUrl, {
                ...fetchInit,
                signal: controller.signal,
            });

            const text = await response.text();
            clearTimeout(timer);

            let data: T;
            try {
                data = JSON.parse(text) as T;
            } catch {
                throw new Error(
                    `Invalid JSON from ${url} (status ${response.status}, body length ${text.length})`
                );
            }

            return { response, data };
        } catch (err: unknown) {
            clearTimeout(timer);
            lastError = err;

            const isAbort =
                typeof err === 'object' &&
                err !== null &&
                'name' in err &&
                (err as { name: string }).name === 'AbortError';

            if (isAbort || attempt === retries) break;

            await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
    }

    throw lastError;
}
