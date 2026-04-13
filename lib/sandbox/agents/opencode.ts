import { Sandbox } from '@vercel/sandbox'
import { AgentExecutionResult } from '../types'
import { TaskLogger } from '@/lib/utils/task-logger'
import { connectors } from '@/lib/db/schema'
import { uploadAgentScripts, executeAgentScript } from './script-runner'

type Connector = typeof connectors.$inferSelect

const SCRIPT_NAME = 'opencode.sh'

/**
 * Build the MCP config JSON for OpenCode (~/.opencode/config.json format).
 */
function buildOpenCodeMcpConfigJson(mcpServers: Connector[]): string | null {
  if (!mcpServers || mcpServers.length === 0) return null

  const opencodeConfig: {
    $schema: string
    mcp: Record<
      string,
      | { type: 'local'; command: string[]; enabled: boolean; environment?: Record<string, string> }
      | { type: 'remote'; url: string; enabled: boolean; headers?: Record<string, string> }
    >
  } = {
    $schema: 'https://opencode.ai/config.json',
    mcp: {},
  }

  for (const server of mcpServers) {
    const serverName = server.name.toLowerCase().replace(/[^a-z0-9]/g, '-')

    if (server.type === 'local') {
      const commandParts = server.command!.trim().split(/\s+/)

      let envObject: Record<string, string> | undefined
      if (server.env) {
        try {
          envObject = JSON.parse(server.env)
        } catch {
          // Failed to parse env
        }
      }

      opencodeConfig.mcp[serverName] = {
        type: 'local',
        command: commandParts,
        enabled: true,
        ...(envObject ? { environment: envObject } : {}),
      }
    } else {
      const entry: { type: 'remote'; url: string; enabled: boolean; headers?: Record<string, string> } = {
        type: 'remote',
        url: server.baseUrl!,
        enabled: true,
      }

      const headers: Record<string, string> = {}
      if (server.oauthClientSecret) headers.Authorization = `Bearer ${server.oauthClientSecret}`
      if (server.oauthClientId) headers['X-Client-ID'] = server.oauthClientId
      if (Object.keys(headers).length > 0) entry.headers = headers

      opencodeConfig.mcp[serverName] = entry
    }
  }

  return JSON.stringify(opencodeConfig, null, 2)
}

export async function executeOpenCodeInSandbox(
  sandbox: Sandbox,
  instruction: string,
  logger: TaskLogger,
  selectedModel?: string,
  mcpServers?: Connector[],
  isResumed?: boolean,
  sessionId?: string,
): Promise<AgentExecutionResult> {
  try {
    await logger.info('Starting OpenCode agent execution...')

    // Validate API keys
    if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
      const errorMsg = 'OpenAI API key or Anthropic API key is required for OpenCode agent'
      await logger.error(errorMsg)
      return { success: false, error: errorMsg, cliName: 'opencode', changesDetected: false }
    }

    // Upload scripts to sandbox
    await logger.info('Uploading agent scripts...')
    const uploaded = await uploadAgentScripts(sandbox, SCRIPT_NAME, logger)
    if (!uploaded) {
      return { success: false, error: 'Failed to upload agent scripts', cliName: 'opencode', changesDetected: false }
    }

    // Build script arguments
    const args: string[] = ['--instruction', instruction]
    if (selectedModel) args.push('--model', selectedModel)
    if (isResumed && sessionId) args.push('--session-id', sessionId, '--resumed')
    else if (isResumed) args.push('--resumed')

    // Build MCP config
    const mcpConfigJson = buildOpenCodeMcpConfigJson(mcpServers || [])
    if (mcpConfigJson) {
      args.push('--mcp-config-json', mcpConfigJson)
      await logger.info('Configuring MCP servers')
    }

    // Build environment variables
    const envVars: Record<string, string> = {}
    if (process.env.OPENAI_API_KEY) envVars.OPENAI_API_KEY = process.env.OPENAI_API_KEY
    if (process.env.ANTHROPIC_API_KEY) envVars.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
    if (process.env.GEMINI_API_KEY) envVars.GEMINI_API_KEY = process.env.GEMINI_API_KEY

    // Execute the script
    await logger.info('Executing OpenCode run command in non-interactive mode...')
    const result = await executeAgentScript(sandbox, SCRIPT_NAME, args, envVars, logger)

    // Map ScriptResult to AgentExecutionResult
    if (result.exitCode === 0) {
      const successMsg = result.hasChanges
        ? 'OpenCode executed successfully (Changes detected)'
        : 'OpenCode executed successfully (No changes made)'
      await logger.success(successMsg)

      return {
        success: true,
        output: successMsg,
        agentResponse: result.agentOutput || 'OpenCode completed the task',
        cliName: 'opencode',
        changesDetected: result.hasChanges,
        sessionId: result.sessionId || undefined,
      }
    } else {
      await logger.error('OpenCode execution failed')
      return {
        success: false,
        error: result.agentOutput || 'OpenCode execution failed',
        agentResponse: result.rawStdout,
        cliName: 'opencode',
        changesDetected: result.hasChanges,
        sessionId: result.sessionId || undefined,
      }
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to execute OpenCode in sandbox'
    console.error('OpenCode execution error:', error)
    await logger.error('OpenCode execution failed unexpectedly')

    return { success: false, error: errorMessage, cliName: 'opencode', changesDetected: false }
  }
}
