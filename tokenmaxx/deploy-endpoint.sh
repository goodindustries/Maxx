#!/usr/bin/env bash
# Deploy the maxx presence/content endpoint to Google Cloud Run.
# Live: https://maxx-endpoint-807793356815.us-central1.run.app
#   ./deploy-endpoint.sh        # redeploy to the default project/region
# Needs: gcloud (authed with billing), Cloud Run + Cloud Build + Artifact Registry APIs.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="${MAXX_GCP_PROJECT:-project-atlas-498220}"
REGION="${MAXX_GCP_REGION:-us-central1}"
ACCOUNT="${MAXX_GCP_ACCOUNT:-reiftauati@gmail.com}"

# Cloud Run source-deploy needs a package.json (start script) beside endpoint.mjs.
BUNDLE="$(mktemp -d)"
cp "$DIR/endpoint.mjs" "$BUNDLE/"
cp "$DIR/today.json" "$BUNDLE/" 2>/dev/null || true
cat > "$BUNDLE/package.json" <<'JSON'
{ "name": "maxx-endpoint", "version": "1.0.0", "type": "module", "private": true,
  "scripts": { "start": "node endpoint.mjs" }, "engines": { "node": ">=18" } }
JSON

# presence is in-memory, so pin to a single instance (--max-instances 1).
gcloud run deploy maxx-endpoint \
  --source "$BUNDLE" \
  --region "$REGION" \
  --allow-unauthenticated \
  --max-instances 1 \
  --project "$PROJECT" \
  --account "$ACCOUNT" \
  --quiet
