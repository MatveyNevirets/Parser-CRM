export class CompanySourceError extends Error {
    code;
    retryAfterMs;
    constructor(message, code, retryAfterMs = null) {
        super(message);
        this.code = code;
        this.retryAfterMs = retryAfterMs;
        this.name = 'CompanySourceError';
    }
    get requiresUserAction() {
        return this.code === 'captcha' || this.code === 'access_denied' || this.code === 'rate_limited';
    }
}
