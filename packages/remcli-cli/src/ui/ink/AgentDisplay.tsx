/**
 * AgentDisplay - shared Ink UI component for terminal-based AI agents.
 *
 * Renders a scrolling message log plus a status/confirmation bar and handles
 * the double-Ctrl-C exit flow. Agent-specific chrome (icon, labels, colors,
 * message filtering and an optional status extra) is supplied via props so the
 * same component backs Codex, Cursor and Gemini.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Box, Text, useStdout, useInput } from 'ink'
import { MessageBuffer, type BufferedMessage } from './messageBuffer'

export interface AgentDisplayProps {
    messageBuffer: MessageBuffer
    logPath?: string
    onExit?: () => void
    /** Emoji/icon shown in the header and status bar. */
    icon: string
    /** Human-readable agent name, e.g. "Codex Agent". */
    agentLabel: string
    /** Color of the header title text. */
    headerColor: string
    /** Accent color used for the status bar border and running text. */
    accentColor: string
    /** Optional predicate to filter which messages are rendered. */
    filterMessage?: (msg: BufferedMessage) => boolean
    /** Invoked on every message buffer update (e.g. to extract model info). */
    onMessagesUpdate?: (messages: BufferedMessage[]) => void
    /** Extra content rendered under the running status text. */
    statusExtra?: React.ReactNode
}

export const AgentDisplay: React.FC<AgentDisplayProps> = ({
    messageBuffer,
    logPath,
    onExit,
    icon,
    agentLabel,
    headerColor,
    accentColor,
    filterMessage,
    onMessagesUpdate,
    statusExtra,
}) => {
    const [messages, setMessages] = useState<BufferedMessage[]>([])
    const [confirmationMode, setConfirmationMode] = useState<boolean>(false)
    const [actionInProgress, setActionInProgress] = useState<boolean>(false)
    const confirmationTimeoutRef = useRef<NodeJS.Timeout | null>(null)
    // Keep the latest callback in a ref so the subscription effect stays stable.
    const onMessagesUpdateRef = useRef(onMessagesUpdate)
    onMessagesUpdateRef.current = onMessagesUpdate
    const { stdout } = useStdout()
    const terminalWidth = stdout.columns || 80
    const terminalHeight = stdout.rows || 24

    useEffect(() => {
        setMessages(messageBuffer.getMessages())

        const unsubscribe = messageBuffer.onUpdate((newMessages) => {
            setMessages(newMessages)
            onMessagesUpdateRef.current?.(newMessages)
        })

        return () => {
            unsubscribe()
            if (confirmationTimeoutRef.current) {
                clearTimeout(confirmationTimeoutRef.current)
            }
        }
    }, [messageBuffer])

    const resetConfirmation = useCallback(() => {
        setConfirmationMode(false)
        if (confirmationTimeoutRef.current) {
            clearTimeout(confirmationTimeoutRef.current)
            confirmationTimeoutRef.current = null
        }
    }, [])

    const setConfirmationWithTimeout = useCallback(() => {
        setConfirmationMode(true)
        if (confirmationTimeoutRef.current) {
            clearTimeout(confirmationTimeoutRef.current)
        }
        confirmationTimeoutRef.current = setTimeout(() => {
            resetConfirmation()
        }, 15000) // 15 seconds timeout
    }, [resetConfirmation])

    useInput(useCallback(async (input, key) => {
        // Don't process input if action is in progress
        if (actionInProgress) return

        // Handle Ctrl-C - exits the agent directly instead of switching modes
        if (key.ctrl && input === 'c') {
            if (confirmationMode) {
                // Second Ctrl-C, exit
                resetConfirmation()
                setActionInProgress(true)
                // Small delay to show the status message
                await new Promise(resolve => setTimeout(resolve, 100))
                onExit?.()
            } else {
                // First Ctrl-C, show confirmation
                setConfirmationWithTimeout()
            }
            return
        }

        // Any other key cancels confirmation
        if (confirmationMode) {
            resetConfirmation()
        }
    }, [confirmationMode, actionInProgress, onExit, setConfirmationWithTimeout, resetConfirmation]))

    const getMessageColor = (type: BufferedMessage['type']): string => {
        switch (type) {
            case 'user': return 'magenta'
            case 'assistant': return 'cyan'
            case 'system': return 'blue'
            case 'tool': return 'yellow'
            case 'result': return 'green'
            case 'status': return 'gray'
            default: return 'white'
        }
    }

    const formatMessage = (msg: BufferedMessage): string => {
        const lines = msg.content.split('\n')
        const maxLineLength = terminalWidth - 10 // Account for borders and padding
        return lines.map(line => {
            if (line.length <= maxLineLength) return line
            const chunks: string[] = []
            for (let i = 0; i < line.length; i += maxLineLength) {
                chunks.push(line.slice(i, i + maxLineLength))
            }
            return chunks.join('\n')
        }).join('\n')
    }

    const visibleMessages = filterMessage ? messages.filter(filterMessage) : messages

    return (
        <Box flexDirection="column" width={terminalWidth} height={terminalHeight}>
            {/* Main content area with logs */}
            <Box
                flexDirection="column"
                width={terminalWidth}
                height={terminalHeight - 4}
                borderStyle="round"
                borderColor="gray"
                paddingX={1}
                overflow="hidden"
            >
                <Box flexDirection="column" marginBottom={1}>
                    <Text color={headerColor} bold>{icon} {agentLabel} Messages</Text>
                    <Text color="gray" dimColor>{'─'.repeat(Math.min(terminalWidth - 4, 60))}</Text>
                </Box>

                <Box flexDirection="column" height={terminalHeight - 10} overflow="hidden">
                    {visibleMessages.length === 0 ? (
                        <Text color="gray" dimColor>Waiting for messages...</Text>
                    ) : (
                        // Show only the last messages that fit in the available space
                        visibleMessages.slice(-Math.max(1, terminalHeight - 10)).map((msg) => (
                            <Box key={msg.id} flexDirection="column" marginBottom={1}>
                                <Text color={getMessageColor(msg.type)} dimColor>
                                    {formatMessage(msg)}
                                </Text>
                            </Box>
                        ))
                    )}
                </Box>
            </Box>

            {/* Modal overlay / status bar at the bottom */}
            <Box
                width={terminalWidth}
                borderStyle="round"
                borderColor={
                    actionInProgress ? "gray" :
                    confirmationMode ? "red" :
                    accentColor
                }
                paddingX={2}
                justifyContent="center"
                alignItems="center"
                flexDirection="column"
            >
                <Box flexDirection="column" alignItems="center">
                    {actionInProgress ? (
                        <Text color="gray" bold>
                            Exiting agent...
                        </Text>
                    ) : confirmationMode ? (
                        <Text color="red" bold>
                            ⚠️  Press Ctrl-C again to exit the agent
                        </Text>
                    ) : (
                        <>
                            <Text color={accentColor} bold>
                                {icon} {agentLabel} Running • Ctrl-C to exit
                            </Text>
                            {statusExtra}
                        </>
                    )}
                    {process.env.DEBUG && logPath && (
                        <Text color="gray" dimColor>
                            Debug logs: {logPath}
                        </Text>
                    )}
                </Box>
            </Box>
        </Box>
    )
}
