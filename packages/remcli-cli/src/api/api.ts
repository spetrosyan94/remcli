import axios from 'axios'
import { logger } from '@/ui/logger'
import type { AgentState, CreateSessionResponse, Metadata, Session } from '@/api/types'
import { ApiSessionClient } from './apiSession';
import { decodeBase64, encodeBase64, getRandomBytes, encrypt, decrypt, libsodiumEncryptForPublicKey } from './encryption';
import { getEffectiveServerUrl } from '@/daemon/p2p/p2pSession';
import { Credentials } from '@/persistence';
import { connectionState, isNetworkError } from '@/utils/serverConnectionErrors';
import { randomUUID } from 'node:crypto';
import {
  calculateRequestProofMac,
  REQUEST_PROOF_TTL_MS,
  REQUEST_PROOF_VERSION,
  type JsonValue,
} from '@/daemon/p2p/p2pRequestProof';

const SESSION_CREATION_OPERATION = 'POST /v1/sessions';

interface CreateSessionRequestBody extends Record<string, JsonValue> {
  tag: string;
  metadata: string;
  agentState: string | null;
  dataEncryptionKey: string | null;
}

export class ApiClient {

  static async create(credential: Credentials) {
    return new ApiClient(credential);
  }

  private readonly credential: Credentials;

  private constructor(credential: Credentials) {
    this.credential = credential
  }

  /**
   * Create a new session or load existing one with the given tag
   */
  async getOrCreateSession(opts: {
    tag: string,
    metadata: Metadata,
    state: AgentState | null
  }): Promise<Session | null> {

    // Resolve encryption key
    let dataEncryptionKey: Uint8Array | null = null;
    let encryptionKey: Uint8Array;
    let encryptionVariant: 'legacy' | 'dataKey';
    if (this.credential.encryption.type === 'dataKey') {

      // Generate new encryption key
      encryptionKey = getRandomBytes(32);
      encryptionVariant = 'dataKey';

      // Derive and encrypt data encryption key
      let encryptedDataKey = libsodiumEncryptForPublicKey(encryptionKey, this.credential.encryption.publicKey);
      dataEncryptionKey = new Uint8Array(encryptedDataKey.length + 1);
      dataEncryptionKey.set([0], 0); // Version byte
      dataEncryptionKey.set(encryptedDataKey, 1); // Data key
    } else {
      encryptionKey = this.credential.encryption.secret;
      encryptionVariant = 'legacy';
    }

    const requestBody: CreateSessionRequestBody = {
      tag: opts.tag,
      metadata: encodeBase64(encrypt(encryptionKey, encryptionVariant, opts.metadata)),
      agentState: opts.state ? encodeBase64(encrypt(encryptionKey, encryptionVariant, opts.state)) : null,
      dataEncryptionKey: dataEncryptionKey ? encodeBase64(dataEncryptionKey) : null,
    };
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.credential.token}`,
      'Content-Type': 'application/json'
    };

    if (this.credential.p2pAuthSecret) {
      const requestId = randomUUID();
      const expiresAt = Date.now() + REQUEST_PROOF_TTL_MS;
      const mac = calculateRequestProofMac(this.credential.p2pAuthSecret, {
        v: REQUEST_PROOF_VERSION,
        transport: 'http',
        operation: SESSION_CREATION_OPERATION,
        requestId,
        expiresAt,
        payload: requestBody,
      });
      if (!mac) {
        throw new Error('Could not create P2P session request proof');
      }

      headers['X-Remcli-Request-Proof-Version'] = String(REQUEST_PROOF_VERSION);
      headers['X-Remcli-Request-Proof-Id'] = requestId;
      headers['X-Remcli-Request-Proof-Expires-At'] = String(expiresAt);
      headers['X-Remcli-Request-Proof-Mac'] = mac;
    }

    // Create session
    try {
      const response = await axios.post<CreateSessionResponse>(
        `${getEffectiveServerUrl()}/v1/sessions`,
        requestBody,
        {
          headers,
          timeout: 60000 // 1 minute timeout for very bad network connections
        }
      )

      logger.debug(`Session created/loaded: ${response.data.session.id} (tag: ${opts.tag})`)
      let raw = response.data.session;
      let session: Session = {
        id: raw.id,
        seq: raw.seq,
        metadata: decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.metadata)),
        metadataVersion: raw.metadataVersion,
        agentState: raw.agentState ? decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.agentState)) : null,
        agentStateVersion: raw.agentStateVersion,
        encryptionKey: encryptionKey,
        encryptionVariant: encryptionVariant
      }
      return session;
    } catch (error) {
      logger.debug('[API] [ERROR] Failed to get or create session:', error);

      // Check if it's a connection error
      if (error && typeof error === 'object' && 'code' in error) {
        const errorCode = (error as any).code;
        if (isNetworkError(errorCode)) {
          connectionState.fail({
            operation: 'Session creation',
            caller: 'api.getOrCreateSession',
            errorCode,
            url: `${getEffectiveServerUrl()}/v1/sessions`
          });
          return null;
        }
      }

      // Handle 404 gracefully - server endpoint may not be available yet
      const is404Error = (
        (axios.isAxiosError(error) && error.response?.status === 404) ||
        (error && typeof error === 'object' && 'response' in error && (error as any).response?.status === 404)
      );
      if (is404Error) {
        connectionState.fail({
          operation: 'Session creation',
          errorCode: '404',
          url: `${getEffectiveServerUrl()}/v1/sessions`
        });
        return null;
      }

      // Handle 5xx server errors - use offline mode with auto-reconnect
      if (axios.isAxiosError(error) && error.response?.status) {
        const status = error.response.status;
        if (status >= 500) {
          connectionState.fail({
            operation: 'Session creation',
            errorCode: String(status),
            url: `${getEffectiveServerUrl()}/v1/sessions`,
            details: ['Server encountered an error, will retry automatically']
          });
          return null;
        }
      }

      throw new Error(`Failed to get or create session: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  sessionSyncClient(session: Session): ApiSessionClient {
    return new ApiSessionClient(this.credential.token, session);
  }
}
