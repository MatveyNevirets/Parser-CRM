import { TwoGisLocalJob } from "./twoGisMaps.js";
/** Playwright is confined to this provider adapter; the orchestration layer only sees the port. */
export class TwoGisLocalSource {
    createSession(request, onCard) {
        return new TwoGisLocalJob(request, onCard);
    }
}
