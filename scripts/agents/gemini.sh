#!/usr/bin/env bash
# Gemini agent script - installs, configures, executes Gemini CLI, checks for changes
# Usage: gemini.sh --instruction "..." [--model "..."] [--mcp-config-json '{...}']
# Required env vars: At least one of GEMINI_API_KEY, GOOGLE_API_KEY, or GOOGLE_GENAI_USE_VERTEXAI
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
INSTRUCTION=""
MODEL=""
MCP_CONFIG_JSON=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --instruction) INSTRUCTION="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --mcp-config-json) MCP_CONFIG_JSON="$2"; shift 2 ;;
    *) log_error "Unknown argument: $1"; exit 1 ;;
  esac
done

if [ -z "$INSTRUCTION" ]; then
  log_error "--instruction is required"
  emit_result 1 false "" "Missing required --instruction argument"
  exit 1
fi

# ---------------------------------------------------------------------------
# Validate auth credentials
# ---------------------------------------------------------------------------
HAS_API_KEY=false
if [ -n "${GEMINI_API_KEY:-}" ] || [ -n "${GOOGLE_API_KEY:-}" ]; then
  HAS_API_KEY=true
fi

HAS_VERTEX=false
if [ "${GOOGLE_GENAI_USE_VERTEXAI:-}" = "true" ] && [ -n "${GOOGLE_CLOUD_PROJECT:-}" ]; then
  HAS_VERTEX=true
fi

if [ "$HAS_API_KEY" = false ] && [ "$HAS_VERTEX" = false ]; then
  log_error "At least one of GEMINI_API_KEY/GOOGLE_API_KEY or GOOGLE_GENAI_USE_VERTEXAI+GOOGLE_CLOUD_PROJECT is required"
  emit_result 1 false "" "Missing authentication credentials"
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 1: Install Gemini CLI
# ---------------------------------------------------------------------------
log_info "Checking Gemini CLI installation..."
install_npm_cli "gemini" "@google/gemini-cli" || {
  emit_result 1 false "" "Failed to install Gemini CLI"
  exit 1
}

# Verify installation
log_command "gemini --version"
gemini --version >&2 2>&1 || {
  log_error "Gemini CLI verification failed"
  emit_result 1 false "" "Gemini CLI not found after installation"
  exit 1
}
log_info "Gemini CLI verified"

# ---------------------------------------------------------------------------
# Step 2: Configure MCP servers if provided
# ---------------------------------------------------------------------------
if [ -n "$MCP_CONFIG_JSON" ]; then
  write_mcp_config "${HOME}/.gemini/settings.json" "$MCP_CONFIG_JSON"
fi

# ---------------------------------------------------------------------------
# Step 3: Build environment variables
# ---------------------------------------------------------------------------
ENV_VARS=()
[ -n "${GEMINI_API_KEY:-}" ] && ENV_VARS+=("GEMINI_API_KEY=${GEMINI_API_KEY}")
[ -n "${GOOGLE_API_KEY:-}" ] && ENV_VARS+=("GOOGLE_API_KEY=${GOOGLE_API_KEY}")
[ -n "${GOOGLE_GENAI_USE_VERTEXAI:-}" ] && ENV_VARS+=("GOOGLE_GENAI_USE_VERTEXAI=${GOOGLE_GENAI_USE_VERTEXAI}")
[ -n "${GOOGLE_CLOUD_PROJECT:-}" ] && ENV_VARS+=("GOOGLE_CLOUD_PROJECT=${GOOGLE_CLOUD_PROJECT}")

# ---------------------------------------------------------------------------
# Step 4: Execute with retry cascade
# ---------------------------------------------------------------------------
# Attempt 1: Full features (--yolo -o json)
# Attempt 2: Fallback (--approval-mode auto_edit -o text)
# Attempt 3: Minimal (no special flags)

AGENT_OUTPUT=""
EXIT_CODE=0

run_gemini() {
  local attempt="$1"
  shift
  local cmd_args=("$@")

  log_info "Gemini execution attempt $attempt"
  local output=""
  local code=0
  output=$(cd "$PROJECT_DIR" && env "${ENV_VARS[@]}" gemini "${cmd_args[@]}" 2>&1) || code=$?
  AGENT_OUTPUT="$output"
  EXIT_CODE=$code
  return $code
}

# Build base args
BASE_ARGS=()
if [ -n "$MODEL" ]; then
  BASE_ARGS+=(--model "$MODEL")
fi

# Attempt 1: --yolo -o json
log_command "gemini --yolo -o json <instruction>"
ATTEMPT1_ARGS=("${BASE_ARGS[@]}" --yolo -o json "$INSTRUCTION")
if run_gemini 1 "${ATTEMPT1_ARGS[@]}"; then
  log_info "Gemini succeeded on attempt 1"
else
  log_info "Attempt 1 failed (exit code: $EXIT_CODE), trying fallback"

  # Attempt 2: --approval-mode auto_edit -o text
  log_command "gemini --approval-mode auto_edit -o text <instruction>"
  ATTEMPT2_ARGS=("${BASE_ARGS[@]}" --approval-mode auto_edit -o text "$INSTRUCTION")
  if run_gemini 2 "${ATTEMPT2_ARGS[@]}"; then
    log_info "Gemini succeeded on attempt 2"
  else
    log_info "Attempt 2 failed (exit code: $EXIT_CODE), trying minimal"

    # Attempt 3: minimal - just the instruction
    log_command "gemini <instruction>"
    ATTEMPT3_ARGS=("${BASE_ARGS[@]}" "$INSTRUCTION")
    if run_gemini 3 "${ATTEMPT3_ARGS[@]}"; then
      log_info "Gemini succeeded on attempt 3"
    else
      log_error "All Gemini execution attempts failed"
    fi
  fi
fi

# Print raw agent output to stdout
echo "$AGENT_OUTPUT"

# ---------------------------------------------------------------------------
# Step 5: Check for changes (no session resumption for Gemini)
# ---------------------------------------------------------------------------
HAS_CHANGES=$(check_git_changes)

# Emit structured result as the last line
emit_result "$EXIT_CODE" "$HAS_CHANGES" "" "$AGENT_OUTPUT"
exit "$EXIT_CODE"
