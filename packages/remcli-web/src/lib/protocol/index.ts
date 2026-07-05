/**
 * P2P daemon protocol client — public API for the web app screens.
 *
 * Typical flow:
 *   1. ConnectPage: parseConnectData()/parseManualInput() → startProtocolClient(payload)
 *   2. App boot:    restoreProtocolClient()
 *   3. Screens:     useSessions()/useMachines()/useSessionMessages(id)/useConnectionStatus()
 *   4. Chat:        loadSessionMessages(id) + sendSessionMessage(id, text)
 *   5. Actions:     machineSpawnNewSession(), sessionAllow()/sessionDeny(), sessionAbort() ...
 *   6. Voice/TTS:   getRestConfig() + synthesizeSpeech()/transcribeAudio()
 *   7. Logout:      logoutProtocolClient()
 */

export {
    parseConnectData,
    parseConnectUrl,
    parseManualInput,
    deriveBearerToken,
    buildEndpoint,
    getStoredConnection,
    storeConnection,
    clearStoredConnection,
    connectP2P,
    restoreCredentials,
    disconnectP2P,
    type P2PQRPayload,
    type P2PConnectionConfig,
    type P2PCredentials
} from '@/lib/protocol/connection';

export {
    startProtocolClient,
    restoreProtocolClient,
    stopProtocolClient,
    logoutProtocolClient,
    isClientStarted,
    getRestConfig,
    refreshSessions,
    refreshMachines,
    loadSessionMessages,
    sendSessionMessage,
    // fixture-aware обёртки над socket.ts (в fixture-режиме — локальный ответ)
    machineSpawnNewSession,
    machineListAgentSessions,
    machineListDirectory,
    sessionAllow,
    sessionDeny,
    machineSetDisplayName,
    machineDelete,
    subscribeKvChanges
} from '@/lib/protocol/client';

export {
    useProtocolStore,
    useConnectionStatus,
    useIsAuthenticated,
    useLatencyMs,
    useMachines,
    useMachine,
    useSessions,
    useSession,
    useSessionMessages,
    useSessionMessagesLoaded
} from '@/lib/protocol/store';

export {
    machineStopSession,
    machineStopDaemon,
    sessionAbort,
    sessionSwitch,
    sessionKill,
    sessionRpc,
    machineRpc,
    type ConnectionStatus,
    type DirectoryEntry,
    type DirectoryHome,
    type DirectoryListing,
    type DirectoryPathStyle,
    type SpawnSessionOptions,
    type SpawnSessionResult
} from '@/lib/protocol/socket';

export {
    fetchSessions,
    fetchActiveSessions,
    fetchMessages,
    deleteSession,
    fetchMachines,
    fetchMachine,
    deleteMachine,
    kvGet,
    kvMutate,
    fetchTtsStatus,
    synthesizeSpeech,
    fetchWhisperStatus,
    transcribeAudio,
    fetchConciergeStatus,
    conciergeChat,
    type RestConfig,
    type MessagesPage,
    type DeleteMachineResult,
    type KvItem,
    type KvMutation,
    type KvMutateResponse
} from '@/lib/protocol/rest';

export {
    normalizeRawMessage,
    RawRecordSchema,
    type RawRecord,
    type NormalizedMessage,
    type NormalizedAgentContent,
    type AgentEvent,
    type MessageMeta,
    type UsageData
} from '@/lib/protocol/messages';

export type {
    Session,
    Machine,
    SessionMetadata,
    AgentState,
    MachineMetadata,
    ApiMessage,
    ApiSession,
    ApiMachine,
    KvChange,
    PermissionMode,
    AgentKind,
    AgentSessionInfo,
    TtsStatus,
    WhisperStatus,
    WhisperTranscription,
    ConciergeStatus,
    ConciergeChatMessage,
    ConciergeChatResponse,
    DecryptedMessage
} from '@/lib/protocol/types';
