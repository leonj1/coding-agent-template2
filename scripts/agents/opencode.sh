#!/usr/bin/env bash
# OpenCode agent script - installs, configures, executes opencode CLI, checks for changes
# Usage: opencode.sh --instruction "..." [--model "..."] [--session-id "..."] [--mcp-config-json '{...}'] [--resumed]
# Required env vars: At least one of OPENAI_API_KEY, ANTHROPIC_API_KEY
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
    --instruction)
      if [[ $# -lt 2 ]] || [[ "${2:-}" == --* ]]; then
        log_error "--instruction requires a value"
        emit_result 1 false "" "Missing value for --instruction"
        exit 1
      fi
      INSTRUCTION="$2"; shift 2 ;;
    --model)
      if [[ $# -lt 2 ]] || [[ "${2:-}" == --* ]]; then
        log_error "--model requires a value"
        emit_result 1 false "" "Missing value for --model"
        exit 1
      fi
      MODEL="$2"; shift 2 ;;
    --session-id)
      if [[ $# -lt 2 ]] || [[ "${2:-}" == --* ]]; then
        log_error "--session-id requires a value"
        emit_result 1 false "" "Missing value for --session-id"
        exit 1
      fi
      SESSION_ID="$2"; shift 2 ;;
    --mcp-config-json)
      if [[ $# -lt 2 ]] || [[ "${2:-}" == --* ]]; then
        log_error "--mcp-config-json requires a value"
        emit_result 1 false "" "Missing value for --mcp-config-json"
        exit 1
      fi
      MCP_CONFIG_JSON="$2"; shift 2 ;;
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
if [ -z "${OPENAI_API_KEY:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  log_error "At least one of OPENAI_API_KEY or ANTHROPIC_API_KEY is required"
  emit_result 1 false "" "Missing API key"
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 1: Install OpenCode CLI
# ---------------------------------------------------------------------------
log_info "Checking OpenCode CLI installation..."
install_npm_cli "opencode" "opencode-ai" || {
  emit_result 1 false "" "Failed to install OpenCode CLI"
  exit 1
}

# Handle npm bin path fallback - some systems need the global bin in PATH
NPM_GLOBAL_BIN=""
if ! cli_exists "opencode"; then
  NPM_GLOBAL_BIN=$(npm config get prefix 2>/dev/null)/bin
  if [ -x "${NPM_GLOBAL_BIN}/opencode" ]; then
    export PATH="${NPM_GLOBAL_BIN}:${PATH}"
    log_info "Added npm global bin to PATH"
  fi
fi

# Verify installation
log_command "opencode --version"
opencode --version >&2 2>&1 || {
  log_error "OpenCode CLI verification failed"
  emit_result 1 false "" "OpenCode CLI not found after installation"
  exit 1
}
log_info "OpenCode CLI verified"

# ---------------------------------------------------------------------------
# Step 2: Configure auth providers
# ---------------------------------------------------------------------------
if [ -n "${OPENAI_API_KEY:-}" ]; then
  log_info "Configuring OpenAI auth..."
  echo "${OPENAI_API_KEY}" | opencode auth add openai >&2 2>&1 || {
    log_info "OpenAI auth configuration may have failed, continuing anyway"
  }
fi

if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  log_info "Configuring Anthropic auth..."
  echo "${ANTHROPIC_API_KEY}" | opencode auth add anthropic >&2 2>&1 || {
    log_info "Anthropic auth configuration may have failed, continuing anyway"
  }
fi

# ---------------------------------------------------------------------------
# Step 3: Configure MCP servers if provided
# ---------------------------------------------------------------------------
if [ -n "$MCP_CONFIG_JSON" ]; then
  write_mcp_config "${HOME}/.opencode/config.json" "$MCP_CONFIG_JSON"
fi

# ---------------------------------------------------------------------------
# Step 4: Build and execute the opencode command
# ---------------------------------------------------------------------------
CMD_ARGS=(run)

if [ -n "$MODEL" ]; then
  CMD_ARGS+=(--model "$MODEL")
fi

if [ "$RESUMED" = true ]; then
  if [ -n "$SESSION_ID" ]; then
    CMD_ARGS+=(--session "$SESSION_ID")
  else
    CMD_ARGS+=(--continue)
  fi
fi

CMD_ARGS+=("$INSTRUCTION")

# Build environment variables
ENV_VARS=()
[ -n "${OPENAI_API_KEY:-}" ] && ENV_VARS+=("OPENAI_API_KEY=${OPENAI_API_KEY}")
[ -n "${ANTHROPIC_API_KEY:-}" ] && ENV_VARS+=("ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}")
[ -n "${GEMINI_API_KEY:-}" ] && ENV_VARS+=("GEMINI_API_KEY=${GEMINI_API_KEY}")

log_command "opencode run <instruction>"

# Execute in project directory, capture output
AGENT_OUTPUT=""
EXIT_CODE=0
if [ ${#ENV_VARS[@]} -gt 0 ]; then
  AGENT_OUTPUT=$(cd "$PROJECT_DIR" && env "${ENV_VARS[@]}" opencode "${CMD_ARGS[@]}" 2>&1) || EXIT_CODE=$?
else
  AGENT_OUTPUT=$(cd "$PROJECT_DIR" && opencode "${CMD_ARGS[@]}" 2>&1) || EXIT_CODE=$?
fi

# Print raw agent output to stdout
echo "$AGENT_OUTPUT"

# ---------------------------------------------------------------------------
# Step 5: Check for changes and extract session ID
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
