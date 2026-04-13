import { Sandbox } from '@vercel/sandbox'
import { AgentExecutionResult } from '../types'
import { TaskLogger } from '@/lib/utils/task-logger'
import { connectors } from '@/lib/db/schema'
import { uploadAgentScripts, executeAgentScript } from './script-runner'

type Connector = typeof connectors.$inferSelect

const SCRIPT_NAME = 'codex.sh'

/**
 * Build the TOML configuration for the Codex CLI.
 * Includes model provider config and MCP servers.
 */
function buildCodexConfig(apiKey: string, modelToUse: string, mcpServers?: Connector[]): string {
  const isVercelKey = apiKey.startsWith('vck_')

  let configToml: string
  if (isVercelKey) {
    configToml = `model = "${modelToUse}"
model_provider = "vercel-ai-gateway"

[model_providers.vercel-ai-gateway]
name = "Vercel AI Gateway"
base_url = "https://ai-gateway.vercel.sh/v1"
env_key = "AI_GATEWAY_API_KEY"
wire_api = "chat"

[debug]
log_requests = true
`
  } else {
    configToml = `model = "${modelToUse}"
model_provider = "openai"

[model_providers.openai]
name = "OpenAI"
base_url = "https://api.openai.com/v1"
env_key = "AI_GATEWAY_API_KEY"
wire_api = "responses"

[debug]
log_requests = true
`
  }

  // Add MCP servers configuration if provided
  if (mcpServers && mcpServers.length > 0) {
    const hasRemoteServers = mcpServers.some((s) => s.type === 'remote')
    if (hasRemoteServers) {
      configToml = `experimental_use_rmcp_client = true\n\n` + configToml
    }

    for (const server of mcpServers) {
      const serverName = server.name.toLowerCase().replace(/[^a-z0-9]/g, '-')

      if (server.type === 'local') {
        const commandParts = server.command!.trim().split(/\s+/)
        const executable = commandParts[0]
        const args = commandParts.slice(1)

        configToml += `\n[mcp_servers.${serverName}]\ncommand = "${executable}"\n`
        if (args.length > 0) {
          configToml += `args = [${args.map((arg) => `"${arg}"`).join(', ')}]\n`
        }
        if (server.env && Object.keys(server.env).length > 0) {
          configToml += `env = { ${Object.entries(server.env)
            .map(([key, value]) => `"${key}" = "${value}"`)
            .join(', ')} }\n`
        }
      } else {
        configToml += `\n[mcp_servers.${serverName}]\nurl = "${server.baseUrl}"\n`
        if (server.oauthClientSecret) {
          configToml += `bearer_token = "${server.oauthClientSecret}"\n`
        }
      }
    }
  }

  return configToml
}

export async function executeCodexInSandbox(
  sandbox: Sandbox,
  instruction: string,
  logger: TaskLogger,
  selectedModel?: string,
  mcpServers?: Connector[],
  isResumed?: boolean,
  sessionId?: string,
): Promise<AgentExecutionResult> {
  try {
    // Validate API key
    const apiKey = process.env.AI_GATEWAY_API_KEY
    if (!apiKey) {
      return {
        success: false,
        error: 'AI Gateway API key not found. Please set AI_GATEWAY_API_KEY environment variable.',
        cliName: 'codex',
        changesDetected: false,
      }
    }

    const isOpenAIKey = apiKey.startsWith('sk-')
    const isVercelKey = apiKey.startsWith('vck_')
    if (!isOpenAIKey && !isVercelKey) {
      await logger.error('Invalid API key format')
      return {
        success: false,
        error: 'Invalid API key format. Expected to start with "sk-" (OpenAI) or "vck_" (Vercel).',
        cliName: 'codex',
        changesDetected: false,
      }
    }

    await logger.info('Using API key for authentication')

    // Upload scripts to sandbox
    await logger.info('Uploading agent scripts...')
    const uploaded = await uploadAgentScripts(sandbox, SCRIPT_NAME, logger)
    if (!uploaded) {
      return { success: false, error: 'Failed to upload agent scripts', cliName: 'codex', changesDetected: false }
    }

    // Build TOML config
    const modelToUse = selectedModel || 'openai/gpt-4o'
    const configContent = buildCodexConfig(apiKey, modelToUse, mcpServers)

    // Build script arguments
    const args: string[] = ['--instruction', instruction, '--config-content', configContent]
    if (selectedModel) args.push('--model', modelToUse)
    if (isResumed) args.push('--resumed')
    if (sessionId) args.push('--session-id', sessionId)
    if (mcpServers && mcpServers.length > 0) {
      await logger.info('Configuring MCP servers')
    }

    // Build environment variables
    const envVars: Record<string, string> = {
      AI_GATEWAY_API_KEY: apiKey,
    }
    if (process.env.OPENAI_API_KEY) envVars.OPENAI_API_KEY = process.env.OPENAI_API_KEY

    // Execute the script
    await logger.info('Executing Codex CLI in non-interactive mode...')
    const result = await executeAgentScript(sandbox, SCRIPT_NAME, args, envVars, logger)

    // Map ScriptResult to AgentExecutionResult
    if (result.exitCode === 0) {
      const successMsg = result.hasChanges
        ? 'Codex CLI executed successfully (Changes detected)'
        : 'Codex CLI executed successfully (No changes made)'

      return {
        success: true,
        output: successMsg,
        agentResponse: result.agentOutput || 'Codex CLI completed the task',
        cliName: 'codex',
        changesDetected: result.hasChanges,
        sessionId: result.sessionId || undefined,
      }
    } else {
      return {
        success: false,
        error: result.agentOutput || 'Codex CLI execution failed',
        agentResponse: result.rawStdout,
        cliName: 'codex',
        changesDetected: result.hasChanges,
        sessionId: result.sessionId || undefined,
      }
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to execute Codex CLI in sandbox'
    return { success: false, error: errorMessage, cliName: 'codex', changesDetected: false }
  }
}
