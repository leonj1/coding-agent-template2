import { readFileSync } from 'fs'
import { join } from 'path'
import { Sandbox } from '@vercel/sandbox'
import { runCommandInSandbox } from '../commands'
import { TaskLogger } from '@/lib/utils/task-logger'
import { redactSensitiveInfo } from '@/lib/utils/logging'

const SCRIPTS_DIR = '/vercel/sandbox/scripts/agents'

export interface ScriptResult {
  exitCode: number
  hasChanges: boolean
  sessionId: string
  agentOutput: string
  rawStdout: string
  rawStderr: string
}

/**
 * Upload a script file to the sandbox by reading it from the local filesystem
 * and writing it via runCommandInSandbox using a heredoc.
 */
async function uploadScript(sandbox: Sandbox, localPath: string, remotePath: string): Promise<boolean> {
  const content = readFileSync(localPath, 'utf-8')
  // Use heredoc with a unique delimiter to avoid issues with script content
  const cmd = `mkdir -p $(dirname '${remotePath}') && cat > '${remotePath}' << 'SCRIPT_EOF'\n${content}\nSCRIPT_EOF\nchmod +x '${remotePath}'`
  const result = await runCommandInSandbox(sandbox, 'sh', ['-c', cmd])
  return result.success
}

/**
 * Upload common.sh and the agent-specific script to the sandbox.
 */
export async function uploadAgentScripts(
  sandbox: Sandbox,
  agentScriptName: string,
  logger: TaskLogger,
): Promise<boolean> {
  const projectRoot = process.cwd()

  // Upload common.sh first
  const commonLocalPath = join(projectRoot, 'scripts', 'agents', 'lib', 'common.sh')
  const commonRemotePath = `${SCRIPTS_DIR}/lib/common.sh`

  const commonUploaded = await uploadScript(sandbox, commonLocalPath, commonRemotePath)
  if (!commonUploaded) {
    await logger.error('Failed to upload common script library')
    return false
  }

  // Upload the agent script
  const agentLocalPath = join(projectRoot, 'scripts', 'agents', agentScriptName)
  const agentRemotePath = `${SCRIPTS_DIR}/${agentScriptName}`

  const agentUploaded = await uploadScript(sandbox, agentLocalPath, agentRemotePath)
  if (!agentUploaded) {
    await logger.error('Failed to upload agent script')
    return false
  }

  return true
}

/**
 * Execute an agent script in the sandbox and parse the structured result.
 *
 * The script is expected to emit a line prefixed with `###AGENT_RESULT###`
 * containing JSON with fields: exit_code, has_changes, session_id, agent_output.
 */
export async function executeAgentScript(
  sandbox: Sandbox,
  agentScriptName: string,
  args: string[],
  envVars: Record<string, string>,
  logger: TaskLogger,
): Promise<ScriptResult> {
  const remotePath = `${SCRIPTS_DIR}/${agentScriptName}`

  // Build env prefix for the command
  const envPrefix = Object.entries(envVars)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(' ')

  // Build the full command
  const scriptArgs = args.map((a) => JSON.stringify(a)).join(' ')
  const fullCommand = envPrefix ? `${envPrefix} bash ${remotePath} ${scriptArgs}` : `bash ${remotePath} ${scriptArgs}`

  // Log the command (redacted)
  const redacted = redactSensitiveInfo(fullCommand)
  await logger.command(redacted)

  const result = await runCommandInSandbox(sandbox, 'sh', ['-c', fullCommand])

  const stdout = result.output || ''
  const stderr = result.error || ''

  // Parse the ###AGENT_RESULT### line from stdout
  const resultLine = stdout.split('\n').find((line: string) => line.startsWith('###AGENT_RESULT###'))

  if (resultLine) {
    try {
      const jsonStr = resultLine.replace('###AGENT_RESULT###', '')
      const parsed = JSON.parse(jsonStr)
      return {
        exitCode: parsed.exit_code ?? (result.exitCode || 0),
        hasChanges: parsed.has_changes === true || parsed.has_changes === 'true',
        sessionId: parsed.session_id || '',
        agentOutput: parsed.agent_output || '',
        rawStdout: stdout.split('###AGENT_RESULT###')[0].trim(),
        rawStderr: stderr,
      }
    } catch {
      // Failed to parse result JSON, fall through to fallback
    }
  }

  // Fallback if no result line found
  return {
    exitCode: result.exitCode ?? -1,
    hasChanges: false,
    sessionId: '',
    agentOutput: stdout,
    rawStdout: stdout,
    rawStderr: stderr,
  }
}
