#!/usr/bin/env bash
# Shared helper library for agent scripts
# Source this file from agent scripts: source "${SCRIPT_DIR}/lib/common.sh"
set -euo pipefail

# Project directory (matches TypeScript PROJECT_DIR)
PROJECT_DIR="${PROJECT_DIR:-/vercel/sandbox/project}"

# ---------------------------------------------------------------------------
# Logging helpers - all output goes to stderr so stdout stays clean for agent
# ---------------------------------------------------------------------------
log_info() { echo "[INFO] $1" >&2; }
log_error() { echo "[ERROR] $1" >&2; }
log_command() { echo "[CMD] $1" >&2; }

# ---------------------------------------------------------------------------
# CLI installation helpers
# ---------------------------------------------------------------------------

# Check if a CLI is installed
cli_exists() { command -v "$1" >/dev/null 2>&1; }

# Install CLI via npm if not present
install_npm_cli() {
  local cli_name="$1"
  local package_name="$2"
  if cli_exists "$cli_name"; then
    log_info "$cli_name already installed, skipping"
    return 0
  fi
  log_info "Installing $cli_name..."
  npm install -g "$package_name" >&2 2>&1
  if ! cli_exists "$cli_name"; then
    log_error "$cli_name not found after installation"
    return 1
  fi
  log_info "$cli_name installed successfully"
}

# Install CLI via curl script if not present
install_curl_cli() {
  local cli_name="$1"
  local install_url="$2"
  if cli_exists "$cli_name"; then
    log_info "$cli_name already installed, skipping"
    return 0
  fi
  log_info "Installing $cli_name..."
  curl -fsSL "$install_url" | sh >&2 2>&1
  if ! cli_exists "$cli_name"; then
    log_error "$cli_name not found after installation"
    return 1
  fi
  log_info "$cli_name installed successfully"
}

# ---------------------------------------------------------------------------
# Configuration helpers
# ---------------------------------------------------------------------------

# Write config content to a file, creating parent directories as needed
# Usage: write_config <config_path> <config_content>
write_config() {
  local config_path="$1"
  local config_content="$2"
  local config_dir
  config_dir=$(dirname "$config_path")
  mkdir -p "$config_dir"
  echo "$config_content" > "$config_path"
  if [ -f "$config_path" ]; then
    log_info "Configuration written"
  else
    log_error "Failed to write configuration"
    return 1
  fi
}

# Write MCP config from JSON passed as argument
# Usage: write_mcp_config <config_path> <config_json>
write_mcp_config() {
  local config_path="$1"
  local config_json="$2"
  write_config "$config_path" "$config_json"
}

# ---------------------------------------------------------------------------
# Git helpers
# ---------------------------------------------------------------------------

# Check git status for changes in project dir
# Outputs "true" or "false"
check_git_changes() {
  local changes
  changes=$(cd "$PROJECT_DIR" && git status --porcelain 2>/dev/null || true)
  if [ -n "$changes" ]; then
    echo "true"
  else
    echo "false"
  fi
}

# ---------------------------------------------------------------------------
# Session ID extraction
# ---------------------------------------------------------------------------

# Extract session ID from agent output using common patterns
extract_session_id() {
  local output="$1"
  local session_id=""
  # Try multiple patterns for different agent output formats
  session_id=$(echo "$output" | grep -oiP '(?:conversation[_\s-]?id|session[_\s-]?id|Session|Conversation)[:\s]+\K[a-f0-9-]+' | head -1 || true)
  echo "$session_id"
}

# ---------------------------------------------------------------------------
# Structured result output
# ---------------------------------------------------------------------------

# Output the structured result line as the LAST line of stdout
# TypeScript looks for the ###AGENT_RESULT### prefix to parse this
# Usage: emit_result <exit_code> <has_changes> [session_id] [agent_output]
emit_result() {
  local exit_code="$1"
  local has_changes="$2"
  local session_id="${3:-}"
  local agent_output="${4:-}"

  # Escape the agent output for JSON (truncate to 10KB, handle special chars)
  local escaped_output
  escaped_output=$(echo "$agent_output" | head -c 10000 | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo '""')

  echo "###AGENT_RESULT###{\"exit_code\": $exit_code, \"has_changes\": $has_changes, \"session_id\": \"$session_id\", \"agent_output\": $escaped_output}"
}
