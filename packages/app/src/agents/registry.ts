import type { AgentAdapter } from '../claude';
import { ClaudeAgent } from '../claude';
import type { AgentProvider } from '../domain';
import { CodexAgent } from './codex';
import { GrokBuildAgent } from './grok-build';

export interface AgentRegistry {
  getAgent(provider: AgentProvider): AgentAdapter;
}

/** 注册三家 Agent 单例；按 provider 取适配器。 */
export function createAgentRegistry(): AgentRegistry {
  const claude = new ClaudeAgent();
  const codex = new CodexAgent();
  const grok = new GrokBuildAgent();
  return {
    getAgent(provider: AgentProvider): AgentAdapter {
      switch (provider) {
        case 'codex':
          return codex;
        case 'grok-build':
          return grok;
        case 'claude':
        default:
          return claude;
      }
    },
  };
}
