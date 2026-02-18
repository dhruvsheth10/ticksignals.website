import { createClient, type Client } from '@libsql/client';

let turso: Client | null = null;

/**
 * Turso (LibSQL) client for portfolio + trading data.
 * Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in env.
 */
export function getTurso(): Client {
    if (!turso) {
        const url = process.env.TURSO_DATABASE_URL;
        const token = process.env.TURSO_AUTH_TOKEN;
        if (!url || !token) {
            throw new Error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set');
        }
        turso = createClient({ url, authToken: token });
    }
    return turso;
}
