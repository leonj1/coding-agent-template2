import { Sandbox } from '@vercel/sandbox'
import { AgentExecutionResult } from '../types'
import { TaskLogger } from '@/lib/utils/task-logger'
import { connectors } from '@/lib/db/schema'
import { uploadAgentScripts, executeAgentScript } from './script-runner'

type Connector = typeof connectors.$inferSelect

const SCRIPT_NAME = 'forgecode.sh'

/**
 * Build the MCP config JSON for ForgeCode (.mcp.json format).
 */
function buildMcpConfigJson(mcpServers: Connector[]): string | null {
  if (!mcpServers || mcpServers.length === 0) return null

  const mcpConfig: {
    mcpServers: Record<
      string,
      | { command: string; args?: string[]; env?: Record<string, string> }
      | { url: string; headers?: Record<string, string> }
    >
  } = { mcpServers: {} }

  for (const server of mcpServers) {
    const serverName = server.name.toLowerCase().replace(/[^a-z0-9]/g, '-')

    if (server.type === 'local') {
      if (!server.command) {
        continue // Skip connector with missing command
      }
      const commandParts = server.command.trim().split(/\s+/)
      const executable = commandParts[0]
      const args = commandParts.slice(1)

      let envObject: Record<string, string> | undefined
      if (server.env) {
        try {
          envObject = JSON.parse(server.env)
        } catch {
          // Failed to parse env
        }
      }

      const localServer: { command: string; args?: string[]; env?: Record<string, string> } = {
        command: executable,
      }
      if (args.length > 0) localServer.args = args
      if (envObject) localServer.env = envObject

      mcpConfig.mcpServers[serverName] = localServer
    } else {
      if (!server.baseUrl) {
        continue // Skip connector with missing baseUrl
      }
      const remoteServer: { url: string; headers?: Record<string, string> } = {
        url: server.baseUrl,
      }
      const headers: Record<string, string> = {}
      if (server.oauthClientSecret) headers.Authorization = `Bearer ${server.oauthClientSecret}`
      if (server.oauthClientId) headers['X-Client-ID'] = server.oauthClientId
      if (Object.keys(headers).length > 0) remoteServer.headers = headers

      mcpConfig.mcpServers[serverName] = remoteServer
    }
  }

  return JSON.stringify(mcpConfig, null, 2)
}

export async function executeForgeCodeInSandbox(
  sandbox: Sandbox,
  instruction: string,
  logger: TaskLogger,
  selectedModel?: string,
  mcpServers?: Connector[],
  isResumed?: boolean,
  sessionId?: string,
): Promise<AgentExecutionResult> {
  try {
    await logger.info('Starting ForgeCode agent execution...')

    // Validate API keys (keys come from process.env on the Node.js server)
    if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY && !process.env.GEMINI_API_KEY) {
      const errorMsg = 'Anthropic API key, OpenAI API key, or Gemini API key is required for ForgeCode agent'
      await logger.error(errorMsg)
      return { success: false, error: errorMsg, cliName: 'forge', changesDetected: false }
    }

    // Upload scripts to sandbox
    await logger.info('Uploading agent scripts...')
    const uploaded = await uploadAgentScripts(sandbox, SCRIPT_NAME, logger)
    if (!uploaded) {
      return { success: false, error: 'Failed to upload agent scripts', cliName: 'forge', changesDetected: false }
    }

    // Build script arguments
    const args: string[] = ['--instruction', instruction]
    if (selectedModel) args.push('--model', selectedModel)
    if (isResumed && sessionId) args.push('--session-id', sessionId, '--resumed')
    else if (isResumed) args.push('--resumed')

    // Build MCP config
    const mcpConfigJson = buildMcpConfigJson(mcpServers || [])
    if (mcpConfigJson) {
      args.push('--mcp-config-json', mcpConfigJson)
      await logger.info('Configuring MCP servers')
    }

    // Build environment variables
    const envVars: Record<string, string> = {}
    if (process.env.ANTHROPIC_API_KEY) envVars.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
    if (process.env.OPENAI_API_KEY) envVars.OPENAI_API_KEY = process.env.OPENAI_API_KEY
    if (process.env.GEMINI_API_KEY) envVars.GEMINI_API_KEY = process.env.GEMINI_API_KEY

    // Execute the script
    await logger.info('Executing ForgeCode in non-interactive mode...')
    const result = await executeAgentScript(sandbox, SCRIPT_NAME, args, envVars, logger)

    // Map ScriptResult to AgentExecutionResult
    if (result.exitCode === 0) {
      const successMsg = result.hasChanges
        ? 'ForgeCode executed successfully (Changes detected)'
        : 'ForgeCode executed successfully (No changes made)'
      await logger.success(successMsg)

      return {
        success: true,
        output: successMsg,
        agentResponse: result.agentOutput || 'ForgeCode completed the task',
        cliName: 'forge',
        changesDetected: result.hasChanges,
        sessionId: result.sessionId || undefined,
      }
    } else {
      await logger.error('ForgeCode execution failed')
      return {
        success: false,
        error: result.agentOutput || 'ForgeCode execution failed',
        agentResponse: result.rawStdout,
        cliName: 'forge',
        changesDetected: result.hasChanges,
        sessionId: result.sessionId || undefined,
      }
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to execute ForgeCode in sandbox'
    console.error('ForgeCode execution error:', error)
    await logger.error('ForgeCode execution failed unexpectedly')

    return { success: false, error: errorMessage, cliName: 'forge', changesDetected: false }
  }
}
