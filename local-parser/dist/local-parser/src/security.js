import { timingSafeEqual } from 'node:crypto';
const devOrigins = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);
export function parseAllowedOrigins(input) {
    if (!input?.trim())
        return devOrigins;
    const origins = new Set();
    for (const value of input.split(',')) {
        const url = new URL(value.trim());
        if (!['https:', 'http:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
            throw new Error('Каждый разрешённый адрес должен быть origin вида https://crm.example или http://localhost:5173.');
        }
        if (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
            throw new Error('Для внешнего CRM разрешён только HTTPS origin.');
        }
        origins.add(url.origin);
    }
    if (!origins.size)
        throw new Error('Нужно указать хотя бы один разрешённый origin.');
    return origins;
}
export function isAllowedOrigin(origin, allowedOrigins) {
    return Boolean(origin && allowedOrigins.has(origin));
}
export function tokenMatches(candidate, expected) {
    if (!candidate)
        return false;
    const actualBytes = Buffer.from(candidate);
    const expectedBytes = Buffer.from(expected);
    return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
