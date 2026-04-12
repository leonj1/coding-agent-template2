#!/usr/bin/env bash
# ForgeCode agent script - installs, configures, executes forge CLI, checks for changes
# Usage: forgecode.sh --instruction "..." [--model "..."] [--session-id "..."] [--mcp-config-json '{...}'] [--resumed]
# Required env vars: At least one of ANTHROPIC_API_KEY, OPENAI_API_KEY
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
RESUMED=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --instruction) INSTRUCTION="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --session-id) SESSION_ID="$2"; shift 2 ;;
    --mcp-config-json) MCP_CONFIG_JSON="$2"; shift 2 ;;
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
# Validate API keys
# ---------------------------------------------------------------------------
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${OPENAI_API_KEY:-}" ]; then
  log_error "At least one of ANTHROPIC_API_KEY or OPENAI_API_KEY is required"
  emit_result 1 false "" "Missing API key"
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 1: Install ForgeCode CLI
# ---------------------------------------------------------------------------
log_info "Checking ForgeCode CLI installation..."
install_curl_cli "forge" "https://forgecode.dev/cli" || {
  emit_result 1 false "" "Failed to install ForgeCode CLI"
  exit 1
}

# Verify installation
log_command "forge --version"
forge --version >&2 2>&1 || {
  log_error "ForgeCode CLI verification failed"
  emit_result 1 false "" "ForgeCode CLI not found after installation"
  exit 1
}
log_info "ForgeCode CLI verified"

# ---------------------------------------------------------------------------
# Step 2: Configure MCP servers if provided
# ---------------------------------------------------------------------------
if [ -n "$MCP_CONFIG_JSON" ]; then
  write_mcp_config "${PROJECT_DIR}/.mcp.json" "$MCP_CONFIG_JSON"
fi

# ---------------------------------------------------------------------------
# Step 3: Build and execute the forge command
# ---------------------------------------------------------------------------
CMD_ARGS=()
if [ -n "$MODEL" ]; then
  CMD_ARGS+=(--model "$MODEL")
fi
if [ "$RESUMED" = true ] && [ -n "$SESSION_ID" ]; then
  CMD_ARGS+=(--conversation-id "$SESSION_ID")
fi
CMD_ARGS+=(-p "$INSTRUCTION")

# Build environment variables array
ENV_VARS=()
[ -n "${ANTHROPIC_API_KEY:-}" ] && ENV_VARS+=("ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}")
[ -n "${OPENAI_API_KEY:-}" ] && ENV_VARS+=("OPENAI_API_KEY=${OPENAI_API_KEY}")
[ -n "${GEMINI_API_KEY:-}" ] && ENV_VARS+=("GEMINI_API_KEY=${GEMINI_API_KEY}")

log_command "forge -p <instruction>"

# Execute in project directory, capture output
AGENT_OUTPUT=""
EXIT_CODE=0
AGENT_OUTPUT=$(cd "$PROJECT_DIR" && env "${ENV_VARS[@]}" forge "${CMD_ARGS[@]}" 2>&1) || EXIT_CODE=$?

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
