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
  DaemonSessionWebhookResult,
  NativeCodexThreadBinding,
  NativeCodexThreadBindingResult,
  StopSessionResult,
  TrackedSession,
} from './types';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';

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

const codexRemoteTuiOpenRequestSchema = nativeCodexThreadBindingSchema.extend({
  endpoint: z.string().url(),
  reasoningEffort: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});

const protectedCodexRemoteTuiOpenRequestSchema = codexRemoteTuiOpenRequestSchema.extend({
  runnerCredential: runnerCredentialSchema,
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
  openCodexRemoteTui,
}: {
  getChildren: () => TrackedSession[];
  stopSession: (sessionId: string) => StopSessionResult | Promise<StopSessionResult>;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  requestShutdown: () => void;
  onRemcliSessionWebhook: (sessionId: string, metadata: Metadata, runnerToken?: string) => DaemonSessionWebhookResult;
  issueSessionRunnerCredential: (sessionId: string, owner: string) => string | undefined;
  verifySessionRunnerCredential: (sessionId: string, credential: string) => boolean;
  bindNativeCodexThread: (binding: NativeCodexThreadBinding) => Promise<NativeCodexThreadBindingResult>;
  openCodexRemoteTui: (request: CodexRemoteTuiOpenRequest) => Promise<CodexRemoteTuiOpenResult>;
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
