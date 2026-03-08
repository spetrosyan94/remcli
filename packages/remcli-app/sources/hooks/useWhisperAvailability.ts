/**
 * useWhisperAvailability hook
 *
 * Checks whether Whisper STT is available on the connected daemon.
 * Sends a single GET /v1/whisper/status request on mount (P2P mode only).
 * Returns { available, loading }.
 * On error or non-P2P mode, gracefully returns available=false.
 */

import * as React from 'react';
import { TokenStorage } from '@/auth/tokenStorage';
import { getServerUrl, isP2PMode } from '@/sync/serverConfig';

interface WhisperStatus {
    available: boolean;
    model: string | null;
    modelDownloaded: boolean;
}

export function useWhisperAvailability(): { available: boolean; loading: boolean } {
    const [available, setAvailable] = React.useState(false);
    const [loading, setLoading] = React.useState(() => isP2PMode());

    React.useEffect(() => {
        if (!isP2PMode()) {
            setAvailable(false);
            setLoading(false);
            return;
        }

        let cancelled = false;

        (async () => {
            try {
                const serverUrl = getServerUrl();
                const credentials = await TokenStorage.getCredentials();
                if (!credentials || cancelled) {
                    if (!cancelled) {
                        setAvailable(false);
                        setLoading(false);
                    }
                    return;
                }

                const response = await fetch(`${serverUrl}/v1/whisper/status`, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${credentials.token}`,
                    },
                });

                if (cancelled) return;

                if (!response.ok) {
                    setAvailable(false);
                    setLoading(false);
                    return;
                }

                const status: WhisperStatus = await response.json();
                if (!cancelled) {
                    setAvailable(status.available);
                    setLoading(false);
                }
            } catch {
                if (!cancelled) {
                    setAvailable(false);
                    setLoading(false);
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, []);

    return { available, loading };
}
