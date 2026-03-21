/**
 * useTtsAvailability hook
 *
 * Checks whether TTS is available on the connected daemon.
 * Sends a single GET /v1/tts/status request on mount (P2P mode only).
 * Returns { available, provider, voices, loading }.
 * On error or non-P2P mode, gracefully returns available=false.
 */

import * as React from 'react';
import { TokenStorage } from '@/auth/tokenStorage';
import { getServerUrl, isP2PMode } from '@/sync/serverConfig';
import { TtsStatusResponse } from '@/sync/apiTts';

export function useTtsAvailability(): { available: boolean; provider: string; voices: string[]; loading: boolean } {
    const [status, setStatus] = React.useState<TtsStatusResponse & { loading: boolean }>({
        available: false,
        provider: 'off',
        voices: [],
        loading: isP2PMode(),
    });

    React.useEffect(() => {
        if (!isP2PMode()) {
            setStatus({ available: false, provider: 'off', voices: [], loading: false });
            return;
        }

        let cancelled = false;

        (async () => {
            try {
                const serverUrl = getServerUrl();
                const credentials = await TokenStorage.getCredentials();
                if (!credentials || cancelled) {
                    if (!cancelled) {
                        setStatus({ available: false, provider: 'off', voices: [], loading: false });
                    }
                    return;
                }

                const response = await fetch(`${serverUrl}/v1/tts/status`, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${credentials.token}`,
                    },
                });

                if (cancelled) return;

                if (!response.ok) {
                    setStatus({ available: false, provider: 'off', voices: [], loading: false });
                    return;
                }

                const result: TtsStatusResponse = await response.json();
                if (!cancelled) {
                    setStatus({ ...result, loading: false });
                }
            } catch {
                if (!cancelled) {
                    setStatus({ available: false, provider: 'off', voices: [], loading: false });
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, []);

    return status;
}
