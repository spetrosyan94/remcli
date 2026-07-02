/**
 * GeminiDisplay - thin wrapper around the shared AgentDisplay.
 *
 * Adds Gemini-specific behavior: message filtering (hides internal [MODEL:...]
 * and redundant status messages) and a live model indicator in the status bar,
 * extracted from [MODEL:...] messages emitted onto the buffer.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Text } from 'ink';
import { AgentDisplay } from './AgentDisplay';
import { MessageBuffer, type BufferedMessage } from './messageBuffer';

interface GeminiDisplayProps {
  messageBuffer: MessageBuffer;
  logPath?: string;
  currentModel?: string;
  onExit?: () => void;
}

/** Hide internal/redundant system messages that should not appear in the log. */
function filterGeminiMessage(msg: BufferedMessage): boolean {
  // Filter out empty system messages (used for triggering re-renders)
  if (msg.type === 'system' && !msg.content.trim()) {
    return false;
  }
  // Filter out model update messages (model extraction happens in useEffect)
  if (msg.type === 'system' && msg.content.startsWith('[MODEL:')) {
    return false;
  }
  // Filter out status messages that are redundant (shown in status bar)
  if (msg.type === 'system' && msg.content.startsWith('Using model:')) {
    return false;
  }
  // Keep "Thinking..." and "[Thinking] ..." messages - they show agent's reasoning (like Codex)
  return true;
}

export const GeminiDisplay: React.FC<GeminiDisplayProps> = ({ messageBuffer, logPath, currentModel, onExit }) => {
  const [model, setModel] = useState<string | undefined>(currentModel);

  // Update model when prop changes (only if different to avoid loops)
  useEffect(() => {
    if (currentModel !== undefined && currentModel !== model) {
      setModel(currentModel);
    }
  }, [currentModel]); // Only depend on currentModel, not model, to avoid loops

  const handleMessagesUpdate = useCallback((newMessages: BufferedMessage[]) => {
    // Extract model from [MODEL:...] messages.
    // Use reverse + find to get the LATEST model message (in case model was changed)
    const modelMessage = [...newMessages].reverse().find(msg =>
      msg.type === 'system' && msg.content.startsWith('[MODEL:')
    );

    if (modelMessage) {
      const modelMatch = modelMessage.content.match(/\[MODEL:(.+?)\]/);
      if (modelMatch && modelMatch[1]) {
        const extractedModel = modelMatch[1];
        setModel(prevModel => (extractedModel !== prevModel ? extractedModel : prevModel));
      }
    }
  }, []);

  return (
    <AgentDisplay
      messageBuffer={messageBuffer}
      logPath={logPath}
      onExit={onExit}
      icon="✨"
      agentLabel="Gemini Agent"
      headerColor="cyan"
      accentColor="cyan"
      filterMessage={filterGeminiMessage}
      onMessagesUpdate={handleMessagesUpdate}
      statusExtra={model ? <Text color="gray" dimColor>Model: {model}</Text> : null}
    />
  );
};
