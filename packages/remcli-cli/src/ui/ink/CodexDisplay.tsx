/**
 * CodexDisplay - thin wrapper around the shared AgentDisplay.
 *
 * Also reused by the Cursor agent (with a custom agentLabel).
 */

import React from 'react'
import { AgentDisplay } from './AgentDisplay'
import { MessageBuffer } from './messageBuffer'

interface CodexDisplayProps {
    messageBuffer: MessageBuffer
    logPath?: string
    onExit?: () => void
    agentLabel?: string
}

export const CodexDisplay: React.FC<CodexDisplayProps> = ({ messageBuffer, logPath, onExit, agentLabel = 'Codex Agent' }) => {
    return (
        <AgentDisplay
            messageBuffer={messageBuffer}
            logPath={logPath}
            onExit={onExit}
            icon="🤖"
            agentLabel={agentLabel}
            headerColor="gray"
            accentColor="green"
        />
    )
}
