ENVF="${FOUNDRY_ENV:-}"
if [[ -z "$ENVF" ]]; then
  ENVF="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/.env"
fi
if [[ ! -f "$ENVF" ]]; then
  echo "missing Foundry .env at $ENVF" >&2
  return 1 2>/dev/null || exit 1
fi
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  [[ -z "${line// }" ]] && continue
  case "$line" in
    LLM_BASE_URL=*|LLM_API_KEY=*|LLM_FAST_MODEL=*|LLM_REASONING_MODEL=*)
      key="${line%%=*}"
      val="${line#*=}"
      if [[ "$val" == \"*\" && "$val" == *\" ]]; then val="${val:1:${#val}-2}"; fi
      if [[ "$val" == \'*\' && "$val" == *\' ]]; then val="${val:1:${#val}-2}"; fi
      export "$key=$val"
      ;;
  esac
done < "$ENVF"
if [[ -n "${LLM_BASE_URL:-}" && "$LLM_BASE_URL" != */v1 && "$LLM_BASE_URL" != */v1/ ]]; then
  export LLM_BASE_URL="${LLM_BASE_URL%/}/v1"
fi
# pi-provider-litellm wants LITELLM_* (base without requiring /v1; plugin normalizes)
if [[ -n "${LLM_API_KEY:-}" ]]; then
  export LITELLM_API_KEY="$LLM_API_KEY"
fi
if [[ -n "${LLM_BASE_URL:-}" ]]; then
  # plugin normalizeBaseUrl strips /v1; pass either form
  export LITELLM_BASE_URL="${LLM_BASE_URL%/v1}"
  export LITELLM_BASE_URL="${LITELLM_BASE_URL%/}"
fi
