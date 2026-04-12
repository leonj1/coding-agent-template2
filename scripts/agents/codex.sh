#!/usr/bin/env bash
# Codex agent script - installs, configures, executes OpenAI Codex CLI, checks for changes
# Usage: codex.sh --instruction "..." [--model "..."] [--session-id "..."] [--mcp-config-json '{...}']
#                  [--config-content "..."] [--config-path "..."] [--resumed]
# Required env vars: AI_GATEWAY_API_KEY
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
INSTRUCTION=""
MODEL=""
SESSION_ID=""
MCP_CONFIG_JSON=""
CONFIG_CONTENT=""
CONFIG_PATH=""
RESUMED=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --instruction) INSTRUCTION="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --session-id) SESSION_ID="$2"; shift 2 ;;
    --mcp-config-json) MCP_CONFIG_JSON="$2"; shift 2 ;;
    --config-content) CONFIG_CONTENT="$2"; shift 2 ;;
    --config-path) CONFIG_PATH="$2"; shift 2 ;;
    --resumed) RESUMED=true; shift ;;
    *) log_error "Unknown argument: $1"; exit 1 ;;
  esac
done

if [ -z "$INSTRUCTION" ]; then
  log_error "--instruction is required"
  emit_result 1 false "" "Missing required --instruction argument"
  exit 1
fi

# ---------------------------------------------------------------------------
# Validate API key
# ---------------------------------------------------------------------------
if [ -z "${AI_GATEWAY_API_KEY:-}" ]; then
  log_error "AI_GATEWAY_API_KEY is required"
  emit_result 1 false "" "Missing AI_GATEWAY_API_KEY"
  exit 1
fi

# Validate key format
case "${AI_GATEWAY_API_KEY}" in
  sk-*|vck_*)
    log_info "API key format validated"
    ;;
  *)
    log_error "AI_GATEWAY_API_KEY must start with sk- or vck_"
    emit_result 1 false "" "Invalid API key format"
    exit 1
    ;;
esac

# ---------------------------------------------------------------------------
# Step 1: Install Codex CLI
# ---------------------------------------------------------------------------
log_info "Checking Codex CLI installation..."
install_npm_cli "codex" "@openai/codex" || {
  emit_result 1 false "" "Failed to install Codex CLI"
  exit 1
}

# Verify installation
log_command "codex --version"
codex --version >&2 2>&1 || {
  log_error "Codex CLI verification failed"
  emit_result 1 false "" "Codex CLI not found after installation"
  exit 1
}
log_info "Codex CLI verified"

# ---------------------------------------------------------------------------
# Step 2: Write config file (TOML format, built by TypeScript)
# ---------------------------------------------------------------------------
if [ -n "$CONFIG_CONTENT" ]; then
  # Default config path for codex
  if [ -z "$CONFIG_PATH" ]; then
    CONFIG_PATH="${HOME}/.codex/config.toml"
  fi
  write_config "$CONFIG_PATH" "$CONFIG_CONTENT"
fi

# ---------------------------------------------------------------------------
# Step 3: Build and execute the codex command
# ---------------------------------------------------------------------------
# Build environment variables
ENV_VARS=()
ENV_VARS+=("AI_GATEWAY_API_KEY=${AI_GATEWAY_API_KEY}")
ENV_VARS+=("HOME=${HOME:-/home/vercel-sandbox}")
ENV_VARS+=("CI=true")
[ -n "${OPENAI_API_KEY:-}" ] && ENV_VARS+=("OPENAI_API_KEY=${OPENAI_API_KEY}")

if [ "$RESUMED" = true ]; then
  # Resume last session
  log_command "codex resume --last"
  CMD_ARGS=(resume --last)
else
  # New execution
  CMD_ARGS=(exec --dangerously-bypass-approvals-and-sandbox "$INSTRUCTION")
  log_command "codex exec <instruction>"
fi

# Execute in project directory, capture output
AGENT_OUTPUT=""
EXIT_CODE=0
AGENT_OUTPUT=$(cd "$PROJECT_DIR" && env "${ENV_VARS[@]}" codex "${CMD_ARGS[@]}" 2>&1) || EXIT_CODE=$?

# Print raw agent output to stdout
echo "$AGENT_OUTPUT"

# ---------------------------------------------------------------------------
# Step 4: Check for changes and extract session ID
# ---------------------------------------------------------------------------
HAS_CHANGES=$(check_git_changes)
EXTRACTED_SESSION_ID=$(extract_session_id "$AGENT_OUTPUT")

# Use extracted session ID if we don't already have one
if [ -z "$SESSION_ID" ] && [ -n "$EXTRACTED_SESSION_ID" ]; then
  SESSION_ID="$EXTRACTED_SESSION_ID"
fi

# Emit structured result as the last line
emit_result "$EXIT_CODE" "$HAS_CHANGES" "$SESSION_ID" "$AGENT_OUTPUT"
exit "$EXIT_CODE"
