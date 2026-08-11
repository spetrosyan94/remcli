import { beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_SESSIONS } from "@/lib/fixtures/data";
import { useProtocolStore } from "@/lib/protocol/store";

describe("protocol session snapshot state", () => {
    beforeEach(() => {
        useProtocolStore.getState().reset();
    });

    it("does not mark incremental session updates as an authoritative snapshot", () => {
        useProtocolStore.getState().applySessions([FIXTURE_SESSIONS[0]]);

        expect(useProtocolStore.getState().hasLoadedSessions).toBe(false);
    });

    it("marks replaceSessions as loaded and resets the signal", () => {
        useProtocolStore.getState().replaceSessions([FIXTURE_SESSIONS[0]]);
        expect(useProtocolStore.getState().hasLoadedSessions).toBe(true);

        useProtocolStore.getState().reset();
        expect(useProtocolStore.getState().hasLoadedSessions).toBe(false);
    });
});
