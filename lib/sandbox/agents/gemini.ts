import { Sandbox } from '@vercel/sandbox'
import { AgentExecutionResult } from '../types'
import { TaskLogger } from '@/lib/utils/task-logger'
import { connectors } from '@/lib/db/schema'
import { uploadAgentScripts, executeAgentScript } from './script-runner'

type Connector = typeof connectors.$inferSelect

const SCRIPT_NAME = 'gemini.sh'

/**
 * Build the MCP config JSON for Gemini CLI (settings.json format).
 */
function buildGeminiMcpConfigJson(mcpServers: Connector[]): string | null {
  if (!mcpServers || mcpServers.length === 0) return null

  const settingsConfig: {
    mcpServers: Record<
      string,
      | { httpUrl: string; headers?: Record<string, string> }
      | { command: string; args?: string[]; env?: Record<string, string> }
    >
  } = { mcpServers: {} }

  for (const server of mcpServers) {
    const serverName = server.name.toLowerCase().replace(/[^a-z0-9]/g, '-')

    if (server.type === 'local') {
      const commandParts = server.command!.trim().split(/\s+/)
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

      settingsConfig.mcpServers[serverName] = {
        command: executable,
        ...(args.length > 0 ? { args } : {}),
        ...(envObject ? { env: envObject } : {}),
      }
    } else {
      const entry: { httpUrl: string; headers?: Record<string, string> } = {
        httpUrl: server.baseUrl!,
      }

      const headers: Record<string, string> = {}
      if (server.oauthClientSecret) headers.Authorization = `Bearer ${server.oauthClientSecret}`
      if (server.oauthClientId) headers['X-Client-ID'] = server.oauthClientId
      if (Object.keys(headers).length > 0) entry.headers = headers

      settingsConfig.mcpServers[serverName] = entry
    }
  }

  return JSON.stringify(settingsConfig, null, 2)
}

export async function executeGeminiInSandbox(
  sandbox: Sandbox,
  instruction: string,
  logger: TaskLogger,
  selectedModel?: string,
  mcpServers?: Connector[],
): Promise<AgentExecutionResult> {
  try {
    // Validate authentication credentials
    const hasGeminiKey = !!process.env.GEMINI_API_KEY
    const hasGoogleKey = !!process.env.GOOGLE_API_KEY
    const hasVertexAI = process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true' && !!process.env.GOOGLE_CLOUD_PROJECT
    const hasOAuthProject = !!process.env.GOOGLE_CLOUD_PROJECT

    if (!hasGeminiKey && !hasGoogleKey && !hasVertexAI && !hasOAuthProject) {
      await logger.info('No API keys found, will attempt OAuth authentication')
    } else if (hasGeminiKey) {
      await logger.info('Using Gemini API key authentication')
    } else if (hasVertexAI) {
      await logger.info('Using Vertex AI authentication')
    } else if (hasOAuthProject) {
      await logger.info('Using Google Cloud Project authentication')
    }

    // Upload scripts to sandbox
    await logger.info('Uploading agent scripts...')
    const uploaded = await uploadAgentScripts(sandbox, SCRIPT_NAME, logger)
    if (!uploaded) {
      return { success: false, error: 'Failed to upload agent scripts', cliName: 'gemini', changesDetected: false }
    }

    // Build script arguments
    const args: string[] = ['--instruction', instruction]
    if (selectedModel) args.push('--model', selectedModel)

    // Build MCP config
    const mcpConfigJson = buildGeminiMcpConfigJson(mcpServers || [])
    if (mcpConfigJson) {
      args.push('--mcp-config-json', mcpConfigJson)
      await logger.info('Configuring MCP servers')
    }

    // Build environment variables
    const envVars: Record<string, string> = {}
    if (process.env.GEMINI_API_KEY) envVars.GEMINI_API_KEY = process.env.GEMINI_API_KEY
    if (process.env.GOOGLE_API_KEY) envVars.GOOGLE_API_KEY = process.env.GOOGLE_API_KEY
    if (process.env.GOOGLE_GENAI_USE_VERTEXAI) envVars.GOOGLE_GENAI_USE_VERTEXAI = process.env.GOOGLE_GENAI_USE_VERTEXAI
    if (process.env.GOOGLE_CLOUD_PROJECT) envVars.GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT

    // Execute the script
    await logger.info('Executing Gemini CLI with authentication')
    const result = await executeAgentScript(sandbox, SCRIPT_NAME, args, envVars, logger)

    // Map ScriptResult to AgentExecutionResult
    if (result.exitCode === 0) {
      const successMsg = result.hasChanges
        ? 'Gemini CLI executed successfully (Changes detected)'
        : 'Gemini CLI executed successfully (No changes made)'

      return {
        success: true,
        output: successMsg,
        agentResponse: result.agentOutput || 'No detailed response available',
        cliName: 'gemini',
        changesDetected: result.hasChanges,
      }
    } else {
      // Handle specific error types from raw stderr/output
      const combinedOutput = `${result.rawStdout} ${result.rawStderr}`

      if (combinedOutput.includes('authentication') || combinedOutput.includes('login')) {
        return {
          success: false,
          error:
            'Gemini CLI authentication failed. Please set GEMINI_API_KEY, GOOGLE_API_KEY, or GOOGLE_CLOUD_PROJECT environment variable.',
          agentResponse: result.rawStdout,
          cliName: 'gemini',
          changesDetected: result.hasChanges,
        }
      }

      if (combinedOutput.includes('Tool') && combinedOutput.includes('not found in registry')) {
        return {
          success: false,
          error: 'Gemini CLI tool registry error - this may be due to sandbox environment limitations.',
          agentResponse: result.rawStdout,
          cliName: 'gemini',
          changesDetected: result.hasChanges,
        }
      }

      return {
        success: false,
        error: result.agentOutput || 'Gemini CLI execution failed',
        agentResponse: result.rawStdout,
        cliName: 'gemini',
        changesDetected: result.hasChanges,
      }
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to execute Gemini CLI in sandbox'
    return { success: false, error: errorMessage, cliName: 'gemini', changesDetected: false }
  }
}
