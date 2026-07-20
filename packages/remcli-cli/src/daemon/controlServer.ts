/**
 * HTTP control server for daemon management
 * Provides endpoints for listing sessions, stopping sessions, and daemon shutdown
 */

import fastify, { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { logger } from '@/ui/logger';
import type { Metadata } from '@/api/types';
import type {
  CodexRemoteTuiOpenRequest,
  CodexRemoteTuiOpenResult,
  CursorHeadlessWriterLeaseAcquireRequest,
  CursorHeadlessWriterLeaseAcquireResult,
  CursorNativeWriterLeaseReleaseRequest,
  CursorNativeWriterLeaseReleaseResult,
  CursorRunnerPreflightRequest,
  CursorRunnerPreflightResult,
  DaemonRunnerLifecycleResult,
  DaemonSessionWebhookResult,
  NativeCodexThreadBinding,
  NativeCodexThreadBindingResult,
  NativeCursorSessionBinding,
  NativeCursorSessionBindingResult,
  StopSessionResult,
  TrackedSession,
} from './types';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import type { PairingRekeyApprovalResult } from './p2p/pairingRekey';

const nativeCodexThreadBindingSchema = z.object({
  agent: z.literal('codex'),
  nativeThreadId: z.string().min(1),
  remcliSessionId: z.string().min(1),
});

const runnerCredentialSchema = z.string().optional();

const nativeCodexThreadWrapperSchema = nativeCodexThreadBindingSchema;

const protectedNativeCodexThreadBindingSchema = nativeCodexThreadBindingSchema.extend({
  runnerCredential: runnerCredentialSchema,
});

const nativeCursorSessionWrapperSchema = z.object({
  agent: z.literal('cursor'),
  nativeSessionId: z.string().min(1),
  remcliSessionId: z.string().min(1),
});

const nativeCursorSessionBindingSchema = nativeCursorSessionWrapperSchema.extend({
  writerLeaseId: z.string().min(32).optional(),
});

const protectedNativeCursorSessionBindingSchema = nativeCursorSessionBindingSchema.extend({
  runnerCredential: runnerCredentialSchema,
});

const cursorNativeWriterOwnerSchema = z.enum(['headless', 'interactive']);

const cursorNativeWriterLeaseSchema = nativeCursorSessionWrapperSchema.extend({
  leaseId: z.string().min(32),
  owner: cursorNativeWriterOwnerSchema,
});

const cursorHeadlessWriterLeaseAcquireRequestSchema = nativeCursorSessionWrapperSchema;

const protectedCursorHeadlessWriterLeaseAcquireRequestSchema = cursorHeadlessWriterLeaseAcquireRequestSchema.extend({
  runnerCredential: runnerCredentialSchema,
});

const cursorNativeWriterLeaseReleaseRequestSchema = nativeCursorSessionWrapperSchema.extend({
  leaseId: z.string().min(32),
});

const protectedCursorNativeWriterLeaseReleaseRequestSchema = cursorNativeWriterLeaseReleaseRequestSchema.extend({
  runnerCredential: runnerCredentialSchema,
});

const cursorRunnerPreflightRequestSchema = z.object({
  agent: z.enum(['claude', 'codex', 'cursor', 'gemini']),
  nativeResumeSessionId: z.string().min(1).optional(),
  pid: z.number().int().positive(),
  runnerToken: z.string().min(1),
});

const cursorRunnerPreflightResponseSchema = z.object({
  type: z.literal('verified'),
  parentRemcliSessionId: z.string().min(1).optional(),
});

const codexRemoteTuiOpenRequestSchema = nativeCodexThreadBindingSchema.extend({
  endpoint: z.string().url(),
  reasoningEffort: z.string().trim().min(1).nullable(),
  model: z.string().min(1).optional(),
});

const protectedCodexRemoteTuiOpenRequestSchema = codexRemoteTuiOpenRequestSchema.extend({
  runnerCredential: runnerCredentialSchema,
});

const daemonRunnerLifecycleRequestSchema = z.object({
  sessionId: z.string().min(1),
  runnerCredential: z.string().min(1),
});

const daemonRunnerLifecycleResultSchema = z.object({
  accepted: z.boolean(),
});

const metadataSchema = z.object({
  path: z.string(),
  host: z.string(),
  version: z.string().optional(),
  name: z.string().optional(),
  os: z.string().optional(),
  summary: z.object({
    text: z.string(),
    updatedAt: z.number(),
  }).optional(),
  machineId: z.string().optional(),
  agentSessionId: z.string().optional(),
  claudeSessionId: z.string().optional(),
  codexSessionId: z.string().optional(),
  cursorSessionId: z.string().optional(),
  geminiSessionId: z.string().optional(),
  tools: z.array(z.string()).optional(),
  slashCommands: z.array(z.string()).optional(),
  homeDir: z.string(),
  remcliHomeDir: z.string(),
  remcliLibDir: z.string(),
  remcliToolsDir: z.string(),
  startedFromDaemon: z.boolean().optional(),
  hostPid: z.number().optional(),
  startedBy: z.union([z.literal('daemon'), z.literal('terminal')]).optional(),
  lifecycleState: z.string().optional(),
  lifecycleStateSince: z.number().optional(),
  archivedBy: z.string().optional(),
  archiveReason: z.string().optional(),
  flavor: z.string().optional(),
}).passthrough();

const sessionStartedRequestSchema = z.object({
  sessionId: z.string(),
  metadata: metadataSchema,
  runnerToken: z.string().min(1).optional(),
});

const sessionStartedResponseSchema = z.object({
  status: z.literal('ok'),
  runnerCredential: z.string().min(1).optional(),
});

const INVALID_SESSION_RUNNER_CREDENTIAL_ERROR = 'invalid-runner-credential';

const runnerCredentialDeniedResponseSchema = z.object({
  error: z.literal(INVALID_SESSION_RUNNER_CREDENTIAL_ERROR),
});

const SESSION_WEBHOOK_REJECTED_ERROR = 'session-webhook-rejected';

const sessionWebhookRejectedResponseSchema = z.object({
  error: z.literal(SESSION_WEBHOOK_REJECTED_ERROR),
});

const CURSOR_RUNNER_PREFLIGHT_REJECTED_ERROR = 'cursor-runner-preflight-rejected';

const cursorRunnerPreflightRejectedResponseSchema = z.object({
  error: z.literal(CURSOR_RUNNER_PREFLIGHT_REJECTED_ERROR),
});

const pairingRekeyApprovalRequestSchema = z.object({
  requestId: z.string().min(16).max(128),
  approvalCode: z.string().regex(/^[A-F0-9]{8}$/),
});

const pairingRekeyApprovalResultSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('approved'), expiresAt: z.number().int().positive() }),
  z.object({ type: z.literal('not-found') }),
  z.object({ type: z.literal('expired') }),
  z.object({ type: z.literal('already-approved') }),
  z.object({ type: z.literal('invalid-code') }),
]);

const nativeCodexThreadBindingResultSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bound'), wrapper: nativeCodexThreadWrapperSchema }),
  z.object({ type: z.literal('already-bound'), wrapper: nativeCodexThreadWrapperSchema }),
  z.object({ type: z.literal('reuse-active-wrapper'), wrapper: nativeCodexThreadWrapperSchema }),
  z.object({ type: z.literal('wrapper-not-tracked'), binding: nativeCodexThreadBindingSchema }),
  z.object({
    type: z.literal('agent-mismatch'),
    binding: nativeCodexThreadBindingSchema,
    trackedAgent: z.enum(['claude', 'codex', 'cursor', 'gemini']),
  }),
]);

const nativeCursorSessionBindingResultSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bound'), wrapper: nativeCursorSessionWrapperSchema, writerLease: cursorNativeWriterLeaseSchema }),
  z.object({ type: z.literal('already-bound'), wrapper: nativeCursorSessionWrapperSchema, writerLease: cursorNativeWriterLeaseSchema }),
  z.object({ type: z.literal('reuse-active-wrapper'), wrapper: nativeCursorSessionWrapperSchema }),
  z.object({ type: z.literal('wrapper-not-tracked'), binding: nativeCursorSessionBindingSchema }),
  z.object({
    type: z.literal('native-session-mismatch'),
    binding: nativeCursorSessionBindingSchema,
    expectedNativeSessionId: z.string().min(1),
  }),
  z.object({ type: z.literal('writer-busy'), binding: nativeCursorSessionBindingSchema, owner: cursorNativeWriterOwnerSchema }),
  z.object({ type: z.literal('writer-lease-mismatch'), binding: nativeCursorSessionBindingSchema }),
  z.object({
    type: z.literal('agent-mismatch'),
    binding: nativeCursorSessionBindingSchema,
    trackedAgent: z.enum(['claude', 'codex', 'cursor', 'gemini']),
  }),
]);

const cursorHeadlessWriterLeaseAcquireResultSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('acquired'), writerLease: cursorNativeWriterLeaseSchema }),
  z.object({ type: z.literal('writer-busy'), request: cursorHeadlessWriterLeaseAcquireRequestSchema, owner: cursorNativeWriterOwnerSchema }),
  z.object({ type: z.literal('wrapper-not-tracked'), request: cursorHeadlessWriterLeaseAcquireRequestSchema }),
  z.object({
    type: z.literal('agent-mismatch'),
    request: cursorHeadlessWriterLeaseAcquireRequestSchema,
    trackedAgent: z.enum(['claude', 'codex', 'cursor', 'gemini']),
  }),
  z.object({
    type: z.literal('native-session-mismatch'),
    request: cursorHeadlessWriterLeaseAcquireRequestSchema,
    trackedNativeSessionId: z.string().min(1).optional(),
  }),
]);

const cursorNativeWriterLeaseReleaseResultSchema = z.object({
  released: z.boolean(),
});

const codexRemoteTuiOpenResultSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('opened'),
    wrapper: nativeCodexThreadWrapperSchema,
    tmuxWindowId: z.string().min(1),
  }),
  z.object({
    type: z.literal('already-open'),
    wrapper: nativeCodexThreadWrapperSchema,
    tmuxWindowId: z.string().min(1),
  }),
  z.object({ type: z.literal('wrapper-not-tracked'), request: codexRemoteTuiOpenRequestSchema }),
  z.object({
    type: z.literal('agent-mismatch'),
    request: codexRemoteTuiOpenRequestSchema,
    trackedAgent: z.enum(['claude', 'codex', 'cursor', 'gemini']),
  }),
  z.object({
    type: z.literal('native-thread-mismatch'),
    request: codexRemoteTuiOpenRequestSchema,
    trackedNativeThreadId: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal('wrapper-not-daemon-owned'), request: codexRemoteTuiOpenRequestSchema }),
  z.object({
    type: z.literal('host-unavailable'),
    request: codexRemoteTuiOpenRequestSchema,
    error: z.string().min(1),
  }),
]);

export function startDaemonControlServer({
  getChildren,
  stopSession,
  spawnSession,
  requestShutdown,
  onRemcliSessionWebhook,
  issueSessionRunnerCredential,
  verifySessionRunnerCredential,
  bindNativeCodexThread,
  bindNativeCursorSession,
  acquireCursorHeadlessWriterLease,
  releaseCursorNativeWriterLease,
  preflightCursorRunner,
  markDaemonRunnerStopping,
  completeDaemonRunnerStopping,
  openCodexRemoteTui,
  approvePairingRekey,
}: {
  getChildren: () => TrackedSession[];
  stopSession: (sessionId: string) => StopSessionResult | Promise<StopSessionResult>;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  requestShutdown: () => void;
  onRemcliSessionWebhook: (sessionId: string, metadata: Metadata, runnerToken?: string) => DaemonSessionWebhookResult;
  issueSessionRunnerCredential: (sessionId: string, owner: string) => string | undefined;
  verifySessionRunnerCredential: (sessionId: string, credential: string) => boolean;
  bindNativeCodexThread: (binding: NativeCodexThreadBinding) => Promise<NativeCodexThreadBindingResult>;
  bindNativeCursorSession: (binding: NativeCursorSessionBinding) => Promise<NativeCursorSessionBindingResult>;
  acquireCursorHeadlessWriterLease: (
    request: CursorHeadlessWriterLeaseAcquireRequest,
  ) => Promise<CursorHeadlessWriterLeaseAcquireResult>;
  releaseCursorNativeWriterLease: (
    request: CursorNativeWriterLeaseReleaseRequest,
  ) => Promise<CursorNativeWriterLeaseReleaseResult>;
  preflightCursorRunner: (request: CursorRunnerPreflightRequest) => Promise<CursorRunnerPreflightResult>;
  markDaemonRunnerStopping: (sessionId: string) => DaemonRunnerLifecycleResult;
  completeDaemonRunnerStopping: (sessionId: string) => Promise<DaemonRunnerLifecycleResult>;
  openCodexRemoteTui: (request: CodexRemoteTuiOpenRequest) => Promise<CodexRemoteTuiOpenResult>;
  approvePairingRekey: (requestId: string, approvalCode: string) => Promise<PairingRekeyApprovalResult>;
}): Promise<{ port: number; stop: () => Promise<void> }> {
  return new Promise((resolve) => {
    const app = fastify({
      logger: false // We use our own logger
    });

    // Set up Zod type provider
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>();

    // Session reports itself after creation
    typed.post('/session-started', {
      schema: {
        body: sessionStartedRequestSchema,
        response: {
          200: sessionStartedResponseSchema,
          403: sessionWebhookRejectedResponseSchema,
        }
      }
    }, async (request, reply) => {
      const { sessionId, metadata, runnerToken } = request.body;

      logger.debug(`[CONTROL SERVER] Session started: ${sessionId}`);
      const sessionWebhookResult = onRemcliSessionWebhook(sessionId, metadata, runnerToken);
      if (!sessionWebhookResult.accepted) {
        reply.code(403);
        return { error: SESSION_WEBHOOK_REJECTED_ERROR } as const;
      }

      if (!sessionWebhookResult.daemonOwned) {
        return { status: 'ok' as const };
      }

      if (!sessionWebhookResult.runnerCredentialOwner) {
        logger.warn('[CONTROL SERVER] Daemon runner webhook did not provide a credential owner proof');
        reply.code(403);
        return { error: SESSION_WEBHOOK_REJECTED_ERROR } as const;
      }

      const runnerCredential = issueSessionRunnerCredential(sessionId, sessionWebhookResult.runnerCredentialOwner);

      if (!runnerCredential) {
        logger.warn('[CONTROL SERVER] Rejected runner credential issuance because the session is owned by another runner');
        reply.code(403);
        return { error: SESSION_WEBHOOK_REJECTED_ERROR } as const;
      }

      return { status: 'ok' as const, runnerCredential };
    });

    // A runner proves its daemon-created wrapper before it creates any P2P
    // metadata. Keep this endpoint free of capability and lineage logging.
    typed.post('/cursor-runner-preflight', {
      schema: {
        body: cursorRunnerPreflightRequestSchema,
        response: {
          200: cursorRunnerPreflightResponseSchema,
          403: cursorRunnerPreflightRejectedResponseSchema,
        },
      },
    }, async (request, reply) => {
      const result = await preflightCursorRunner(request.body);
      if (result.type === 'rejected') {
        reply.code(403);
        return { error: CURSOR_RUNNER_PREFLIGHT_REJECTED_ERROR } as const;
      }

      return result;
    });

    const registerDaemonRunnerLifecycleRoute = (
      path: '/daemon-runner-stopping' | '/daemon-runner-stopped',
      lifecycleHandler: (sessionId: string) => DaemonRunnerLifecycleResult | Promise<DaemonRunnerLifecycleResult>,
    ): void => {
      typed.post(path, {
        schema: {
          body: daemonRunnerLifecycleRequestSchema,
          response: {
            200: daemonRunnerLifecycleResultSchema,
            403: runnerCredentialDeniedResponseSchema,
          },
        },
      }, async (request, reply) => {
        const { sessionId, runnerCredential } = request.body;
        if (!verifySessionRunnerCredential(sessionId, runnerCredential)) {
          reply.code(403);
          return { error: INVALID_SESSION_RUNNER_CREDENTIAL_ERROR } as const;
        }

        return await lifecycleHandler(sessionId);
      });
    };

    registerDaemonRunnerLifecycleRoute('/daemon-runner-stopping', markDaemonRunnerStopping);
    registerDaemonRunnerLifecycleRoute('/daemon-runner-stopped', completeDaemonRunnerStopping);

    typed.post('/codex-thread-bound', {
      schema: {
        body: protectedNativeCodexThreadBindingSchema,
        response: {
          200: nativeCodexThreadBindingResultSchema,
          403: runnerCredentialDeniedResponseSchema,
        },
      },
    }, async (request, reply) => {
      const { agent, nativeThreadId, remcliSessionId, runnerCredential } = request.body;
      if (!runnerCredential || !verifySessionRunnerCredential(remcliSessionId, runnerCredential)) {
        reply.code(403);
        return { error: INVALID_SESSION_RUNNER_CREDENTIAL_ERROR } as const;
      }

      const binding: NativeCodexThreadBinding = { agent, nativeThreadId, remcliSessionId };
      const result = await bindNativeCodexThread(binding);
      logger.debug(`[CONTROL SERVER] Codex thread ${nativeThreadId} binding result: ${result.type}`);
      return result;
    });

    typed.post('/cursor-session-bound', {
      schema: {
        body: protectedNativeCursorSessionBindingSchema,
        response: {
          200: nativeCursorSessionBindingResultSchema,
          403: runnerCredentialDeniedResponseSchema,
        },
      },
      }, async (request, reply) => {
      const { agent, nativeSessionId, remcliSessionId, writerLeaseId, runnerCredential } = request.body;
      if (!runnerCredential || !verifySessionRunnerCredential(remcliSessionId, runnerCredential)) {
        reply.code(403);
        return { error: INVALID_SESSION_RUNNER_CREDENTIAL_ERROR } as const;
      }

      const binding: NativeCursorSessionBinding = {
        agent,
        nativeSessionId,
        remcliSessionId,
        ...(writerLeaseId ? { writerLeaseId } : {}),
      };
      const result = await bindNativeCursorSession(binding);
      logger.debug(`[CONTROL SERVER] Cursor session ${nativeSessionId} binding result: ${result.type}`);
      return result;
    });

    typed.post('/cursor-headless-writer-acquire', {
      schema: {
        body: protectedCursorHeadlessWriterLeaseAcquireRequestSchema,
        response: {
          200: cursorHeadlessWriterLeaseAcquireResultSchema,
          403: runnerCredentialDeniedResponseSchema,
        },
      },
    }, async (request, reply) => {
      const { agent, nativeSessionId, remcliSessionId, runnerCredential } = request.body;
      if (!runnerCredential || !verifySessionRunnerCredential(remcliSessionId, runnerCredential)) {
        reply.code(403);
        return { error: INVALID_SESSION_RUNNER_CREDENTIAL_ERROR } as const;
      }

      return await acquireCursorHeadlessWriterLease({ agent, nativeSessionId, remcliSessionId });
    });

    typed.post('/cursor-writer-release', {
      schema: {
        body: protectedCursorNativeWriterLeaseReleaseRequestSchema,
        response: {
          200: cursorNativeWriterLeaseReleaseResultSchema,
          403: runnerCredentialDeniedResponseSchema,
        },
      },
    }, async (request, reply) => {
      const { agent, leaseId, nativeSessionId, remcliSessionId, runnerCredential } = request.body;
      if (!runnerCredential || !verifySessionRunnerCredential(remcliSessionId, runnerCredential)) {
        reply.code(403);
        return { error: INVALID_SESSION_RUNNER_CREDENTIAL_ERROR } as const;
      }

      return await releaseCursorNativeWriterLease({ agent, leaseId, nativeSessionId, remcliSessionId });
    });

    typed.post('/codex-remote-tui-open', {
      schema: {
        body: protectedCodexRemoteTuiOpenRequestSchema,
        response: {
          200: codexRemoteTuiOpenResultSchema,
          403: runnerCredentialDeniedResponseSchema,
        },
      },
    }, async (request, reply) => {
      const { agent, nativeThreadId, remcliSessionId, endpoint, reasoningEffort, model, runnerCredential } = request.body;
      if (!runnerCredential || !verifySessionRunnerCredential(remcliSessionId, runnerCredential)) {
        reply.code(403);
        return { error: INVALID_SESSION_RUNNER_CREDENTIAL_ERROR } as const;
      }

      const remoteTuiRequest: CodexRemoteTuiOpenRequest = {
        agent,
        nativeThreadId,
        remcliSessionId,
        endpoint,
        reasoningEffort,
        model,
      };
      const result = await openCodexRemoteTui(remoteTuiRequest);
      logger.debug(`[CONTROL SERVER] Codex remote TUI open for ${remcliSessionId}: ${result.type}`);
      return result;
    });

    // Loopback-only approval boundary for pairing-key rotation. A remote P2P
    // client can create a pending request but cannot promote it by itself.
    typed.post('/pairing-rekey/approve', {
      schema: {
        body: pairingRekeyApprovalRequestSchema,
        response: { 200: pairingRekeyApprovalResultSchema },
      },
    }, async (request) => {
      return await approvePairingRekey(request.body.requestId, request.body.approvalCode);
    });

    // List all tracked sessions
    typed.post('/list', {
      schema: {
        response: {
          200: z.object({
            children: z.array(z.object({
              startedBy: z.string(),
              remcliSessionId: z.string(),
              pid: z.number()
            }))
          })
        }
      }
    }, async () => {
      const children = getChildren();
      logger.debug(`[CONTROL SERVER] Listing ${children.length} sessions`);
      return { 
        children: children
          .filter(child => child.remcliSessionId !== undefined)
          .map(child => ({
            startedBy: child.startedBy,
            remcliSessionId: child.remcliSessionId!,
            pid: child.pid
          }))
      }
    });

    // Stop specific session
    typed.post('/stop-session', {
      schema: {
        body: z.object({
          sessionId: z.string()
        }),
        response: {
          200: z.object({
            success: z.boolean()
          })
        }
      }
    }, async (request) => {
      const { sessionId } = request.body;

      logger.debug(`[CONTROL SERVER] Stop session request: ${sessionId}`);
      const result = await stopSession(sessionId);
      return { success: result.success };
    });

    // Spawn new session
    typed.post('/spawn-session', {
      schema: {
        body: z.object({
          directory: z.string(),
          sessionId: z.string().optional()
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            sessionId: z.string().optional(),
            approvedNewDirectoryCreation: z.boolean().optional()
          }),
          409: z.object({
            success: z.boolean(),
            requiresUserApproval: z.boolean().optional(),
            actionRequired: z.string().optional(),
            directory: z.string().optional()
          }),
          500: z.object({
            success: z.boolean(),
            error: z.string().optional()
          })
        }
      }
    }, async (request, reply) => {
      const { directory, sessionId } = request.body;

      logger.debug(`[CONTROL SERVER] Spawn session request: dir=${directory}, sessionId=${sessionId || 'new'}`);
      const result = await spawnSession({ directory, sessionId });

      switch (result.type) {
        case 'success':
          // Check if sessionId exists, if not return error
          if (!result.sessionId) {
            reply.code(500);
            return {
              success: false,
              error: 'Failed to spawn session: no session ID returned'
            };
          }
          return {
            success: true,
            sessionId: result.sessionId,
            approvedNewDirectoryCreation: true
          };
        
        case 'requestToApproveDirectoryCreation':
          reply.code(409); // Conflict - user input needed
          return { 
            success: false,
            requiresUserApproval: true,
            actionRequired: 'CREATE_DIRECTORY',
            directory: result.directory
          };
        
        case 'error':
          reply.code(500);
          return { 
            success: false,
            error: result.errorMessage
          };
      }
    });

    // Stop daemon
    typed.post('/stop', {
      schema: {
        response: {
          200: z.object({
            status: z.string()
          })
        }
      }
    }, async () => {
      logger.debug('[CONTROL SERVER] Stop daemon request received');

      // Give time for response to arrive
      setTimeout(() => {
        logger.debug('[CONTROL SERVER] Triggering daemon shutdown');
        requestShutdown();
      }, 50);

      return { status: 'stopping' };
    });

    app.listen({ port: 0, host: '127.0.0.1' }, (err, address) => {
      if (err) {
        logger.debug('[CONTROL SERVER] Failed to start:', err);
        throw err;
      }

      const port = parseInt(address.split(':').pop()!);
      logger.debug(`[CONTROL SERVER] Started on port ${port}`);

      resolve({
        port,
        stop: async () => {
          logger.debug('[CONTROL SERVER] Stopping server');
          await app.close();
          logger.debug('[CONTROL SERVER] Server stopped');
        }
      });
    });
  });
}
