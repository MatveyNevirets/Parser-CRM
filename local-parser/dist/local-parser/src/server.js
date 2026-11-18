import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { localParserProtocolVersion } from "../../src/imports/protocol.js";
import { LocalImportService } from "./importService.js";
import { defaultDatabasePath } from "./sqliteStore.js";
import { isAllowedOrigin, parseAllowedOrigins, tokenMatches } from "./security.js";
const host = '127.0.0.1';
const port = Number(process.env.PARSER_PORT ?? 43127);
if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
    throw new Error('PARSER_PORT должен быть целым числом от 0 до 65535.');
const allowedOrigins = parseAllowedOrigins(process.env.PARSER_ALLOWED_ORIGINS);
const pairingToken = process.env.PARSER_PAIRING_TOKEN ?? randomBytes(32).toString('base64url');
if (pairingToken.length < 32)
    throw new Error('PARSER_PAIRING_TOKEN должен содержать не менее 32 символов.');
let activeService = null;
let shuttingDown = false;
const recentRequests = new Map();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const server = createServer(async (request, response) => {
    const origin = request.headers.origin;
    if (!isAllowedOrigin(origin, allowedOrigins))
        return sendJson(response, 403, { error: 'Origin не разрешён локальному парсеру.' });
    applyCors(response, origin);
    if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return;
    }
    if (!tokenMatches(readBearer(request), pairingToken))
        return sendJson(response, 401, { error: 'Неверный локальный токен. Сверьте его с токеном в терминале парсера.' });
    if (!rateAllowed(request, origin)) {
        response.setHeader('Retry-After', '10');
        return sendJson(response, 429, { error: 'Слишком много запросов к локальному парсеру.' });
    }
    const service = activeService;
    if (!service)
        return sendJson(response, 503, { error: 'Локальный парсер запускается. Повторите подключение через несколько секунд.' });
    const url = new URL(request.url ?? '/', `http://${host}:${port}`);
    const path = url.pathname;
    try {
        if (request.method === 'GET' && path === '/v1/health') {
            return sendJson(response, 200, { ok: true, storage: 'sqlite', browser: 'local-chromium', protocolVersion: localParserProtocolVersion });
        }
        if (path === '/v1/runs' && request.method === 'GET') {
            const workspaceId = requireUuid(url.searchParams.get('workspaceId'), 'workspaceId');
            return sendJson(response, 200, { runs: await service.listRuns(workspaceId, integer(url.searchParams.get('limit'), 25, 1, 100)) });
        }
        if (path === '/v1/runs' && request.method === 'POST') {
            const body = await readJson(request);
            if (!isRecord(body))
                return sendJson(response, 400, { error: 'Тело запроса должно быть JSON-объектом.' });
            const workspaceId = requireUuid(body.workspaceId, 'workspaceId');
            const createdBy = requireUuid(body.createdBy, 'createdBy');
            const source = body.source;
            const city = boundedText(body.city, 'Город', 200);
            const niche = boundedText(body.niche, 'Ниша', 200);
            const requestedCount = integer(body.requestedCount, -1, 0, 5000);
            if (requestedCount < 0)
                return sendJson(response, 400, { error: 'Количество должно быть целым числом от 0 до 5000.' });
            if (source !== '2gis')
                return sendJson(response, 400, { error: 'Поддерживается только выбранный источник.' });
            if (body.excludeWithWebsite !== undefined && typeof body.excludeWithWebsite !== 'boolean') {
                return sendJson(response, 400, { error: 'Фильтр сайтов должен быть логическим значением.' });
            }
            const run = await service.startRun({ workspaceId, source, city, niche, requestedCount,
                excludeWithWebsite: body.excludeWithWebsite !== false }, createdBy, true);
            return sendJson(response, 201, { run });
        }
        const match = path.match(/^\/v1\/runs\/([0-9a-f-]{36})(?:\/(collect|cancel|continue|reject|candidates|decision|branch-review|publication|publication-key|candidate\/([0-9a-f-]{36})\/edit))?$/i);
        if (!match || !uuidPattern.test(match[1]) || (match[3] && !uuidPattern.test(match[3])))
            return sendJson(response, 404, { error: 'Маршрут локального парсера не найден.' });
        const [, runId, action, candidateId] = match;
        if (request.method === 'GET' && !action) {
            const workspaceId = requireUuid(url.searchParams.get('workspaceId'), 'workspaceId');
            const run = await service.getRun(workspaceId, runId);
            return run ? sendJson(response, 200, { run }) : sendJson(response, 404, { error: 'Локальный пакет не найден.' });
        }
        if (request.method === 'GET' && action === 'candidates') {
            const workspaceId = requireUuid(url.searchParams.get('workspaceId'), 'workspaceId');
            const page = integer(url.searchParams.get('page'), 0, 0, 100_000);
            const pageSize = integer(url.searchParams.get('pageSize'), 50, 1, 100);
            const search = url.searchParams.get('search') ?? '';
            const result = await service.listCandidates(workspaceId, runId, page, pageSize, search.slice(0, 100));
            return sendJson(response, 200, result);
        }
        if (request.method === 'DELETE' && !action) {
            const workspaceId = requireUuid(url.searchParams.get('workspaceId'), 'workspaceId');
            await service.deleteRun(workspaceId, runId);
            return sendJson(response, 200, { ok: true });
        }
        if (request.method !== 'POST' || !action)
            return sendJson(response, 405, { error: 'Метод не поддерживается для этого маршрута.' });
        const body = await readJson(request);
        if (!isRecord(body))
            return sendJson(response, 400, { error: 'Тело запроса должно быть JSON-объектом.' });
        const workspaceId = requireUuid(body.workspaceId, 'workspaceId');
        if (action === 'candidates') {
            const candidate = await service.addCandidate(workspaceId, runId, validateCandidateFields(body.fields));
            return sendJson(response, 201, { candidate });
        }
        if (action === 'publication-key')
            return sendJson(response, 200, { idempotencyKey: await service.preparePublication(workspaceId, runId) });
        if (action === 'collect')
            return sendJson(response, 200, { run: await service.collectNextPage(workspaceId, runId) });
        if (action === 'cancel')
            return sendJson(response, 200, { run: await service.cancelRun(workspaceId, runId) });
        if (action === 'continue')
            return sendJson(response, 200, { run: await service.continueRun(workspaceId, runId, true) });
        if (action === 'reject')
            return sendJson(response, 200, { run: await service.rejectRun(workspaceId, runId) });
        if (action === 'decision') {
            if (!Array.isArray(body.candidateIds) || body.candidateIds.length > 100 || body.candidateIds.some((id) => typeof id !== 'string' || !uuidPattern.test(id))) {
                return sendJson(response, 400, { error: 'Укажите не более 100 корректных ID карточек.' });
            }
            if (body.decision !== 'include' && body.decision !== 'exclude')
                return sendJson(response, 400, { error: 'Решение должно быть include или exclude.' });
            await service.decideCandidates(workspaceId, runId, body.candidateIds, body.decision);
            return sendJson(response, 200, { ok: true });
        }
        if (action === 'branch-review') {
            if (typeof body.groupKey !== 'string' || body.groupKey.length > 2000
                || (body.classification !== 'independent' && body.classification !== 'confirmed'))
                return sendJson(response, 400, { error: 'Некорректное решение по группе.' });
            await service.reviewBranchGroup(workspaceId, runId, body.groupKey, body.classification);
            return sendJson(response, 200, { ok: true });
        }
        if (action === 'publication') {
            const report = validatePublicationReport(body.report);
            const run = await service.recordPublication(workspaceId, runId, report);
            return sendJson(response, 200, { run });
        }
        if (action.startsWith('candidate/') && candidateId) {
            const fields = validateCandidateFields(body.fields);
            const candidate = await service.editCandidate(workspaceId, runId, candidateId, fields);
            return sendJson(response, 200, { candidate });
        }
        return sendJson(response, 404, { error: 'Маршрут локального парсера не найден.' });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Локальный парсер завершил действие с ошибкой.';
        const status = message.includes('не найден') ? 404 : 400;
        return sendJson(response, status, { error: message });
    }
});
server.headersTimeout = 10_000;
server.requestTimeout = 45_000;
server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
        console.log(`Порт ${host}:${port} уже занят. Вторая копия парсера не запущена; сохранённая база не открывалась.`);
        console.log('Если CRM и парсер запущены через npm run dev:connected, отдельный npm run parser:local не нужен.');
        console.log('Для перезапуска сначала остановите прежний процесс через Ctrl+C в его терминале.');
        process.exitCode = 0;
    }
    else {
        console.error(`Не удалось запустить локальный парсер: ${error.message}`);
        process.exitCode = 1;
    }
});
server.listen(port, host, () => { void initializeService(); });
async function initializeService() {
    // Acquire the loopback port before opening sql.js: a duplicate process must
    // never mark the first process's jobs as interrupted or export its database.
    try {
        const service = await LocalImportService.open();
        if (shuttingDown) {
            service.close();
            return;
        }
        activeService = service;
    }
    catch (error) {
        console.error(`Не удалось открыть локальное хранилище: ${error instanceof Error ? error.message : 'неизвестная ошибка'}`);
        process.exitCode = 1;
        server.close();
        return;
    }
    const address = server.address();
    console.log(`Локальный парсер слушает http://${host}:${typeof address === 'object' && address ? address.port : port}`);
    console.log(`Разрешённые CRM origin: ${[...allowedOrigins].join(', ')}`);
    console.log(`SQLite-файл: ${defaultDatabasePath()}`);
    console.log('Одноразовый токен подключения CRM (сохраните локально, не публикуйте):');
    if (process.env.PARSER_PRINT_PAIRING_TOKEN !== 'false')
        console.log(pairingToken);
    else
        console.log('Парсер автоматически подключён к локальному dev-интерфейсу.');
    console.log('Оставьте этот процесс запущенным только на время работы с разделом «Парсер». Ctrl+C завершит его.');
}
async function readJson(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > 262_144)
            throw new Error('Тело запроса превышает лимит 256 КБ.');
        chunks.push(buffer);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch {
        throw new Error('Тело запроса должно быть корректным JSON.');
    }
}
function readBearer(request) {
    const header = request.headers.authorization;
    return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
}
function rateAllowed(request, origin) {
    const key = `${request.socket.remoteAddress ?? 'unknown'}|${origin}`;
    const now = Date.now();
    const recent = (recentRequests.get(key) ?? []).filter((timestamp) => now - timestamp < 10_000);
    if (recent.length >= 60)
        return false;
    recent.push(now);
    recentRequests.set(key, recent);
    return true;
}
function applyCors(response, origin) {
    response.setHeader('Access-Control-Expose-Headers', 'Retry-After');
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
    response.setHeader('Access-Control-Allow-Private-Network', 'true');
    response.setHeader('Access-Control-Max-Age', '300');
    response.setHeader('Vary', 'Origin');
    response.setHeader('Cache-Control', 'no-store');
}
function sendJson(response, status, payload) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(payload));
}
function isRecord(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function requireUuid(value, field) {
    if (typeof value !== 'string' || !uuidPattern.test(value))
        throw new Error(`Некорректный ${field}.`);
    return value;
}
function boundedText(value, label, max) {
    if (typeof value !== 'string' || !value.trim() || value.length > max)
        throw new Error(`${label}: укажите от 1 до ${max} символов.`);
    return value.trim();
}
function integer(value, fallback, min, max) {
    if (value === null || value === undefined)
        return fallback;
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : -1;
}
function validateCandidateFields(value) {
    if (!isRecord(value))
        throw new Error('Поля карточки отсутствуют.');
    return {
        companyName: boundedText(value.companyName, 'Название', 300),
        city: boundedText(value.city, 'Город', 200),
        niche: boundedText(value.niche, 'Ниша', 200),
        address: optionalText(value.address, 500),
        phone: optionalText(value.phone, 100),
        website: optionalText(value.website, 1000),
    };
}
function optionalText(value, maxLength) {
    if (typeof value !== 'string' || value.length > maxLength)
        throw new Error(`Поле должно быть строкой не длиннее ${maxLength} символов.`);
    return value.trim();
}
function validatePublicationReport(value) {
    if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > 1000)
        throw new Error('Некорректный отчёт публикации.');
    const items = value.items.map((item) => {
        if (!isRecord(item) || typeof item.candidateId !== 'string' || !uuidPattern.test(item.candidateId))
            throw new Error('Некорректный ID результата публикации.');
        if (item.leadId !== null && (typeof item.leadId !== 'string' || !uuidPattern.test(item.leadId)))
            throw new Error('Некорректный ID лида в результате публикации.');
        if (item.status !== 'created' && item.status !== 'already_exists' && item.status !== 'failed')
            throw new Error('Некорректный статус результата публикации.');
        return { candidateId: item.candidateId, leadId: item.leadId, status: item.status,
            reason: typeof item.reason === 'string' ? item.reason.slice(0, 500) : null };
    });
    const count = (field) => {
        const parsed = integer(value[field], -1, 0, 1000);
        if (parsed < 0)
            throw new Error('Некорректные итоговые счётчики публикации.');
        return parsed;
    };
    const status = value.status;
    if (status !== 'completed' && status !== 'partially_completed')
        throw new Error('Некорректный итоговый статус публикации.');
    return { created: count('created'), alreadyExists: count('alreadyExists'), excluded: count('excluded'), failed: count('failed'), status, items };
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
async function shutdown() {
    if (shuttingDown)
        return;
    shuttingDown = true;
    server.close(() => process.exit(0));
    activeService?.close();
    setTimeout(() => process.exit(0), 2_000).unref();
}
