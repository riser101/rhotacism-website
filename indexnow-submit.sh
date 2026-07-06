#!/bin/bash
# IndexNow URL submission script for topspeech.health
# Usage:
#   Submit all sitemap URLs:  ./indexnow-submit.sh
#   Submit specific URLs:     ./indexnow-submit.sh https://topspeech.health/therollracademy/guide/rhotacism.html

HOST="topspeech.health"
KEY="667729dc409691931c7c9ddd92cc8c4a"
KEY_LOCATION="https://${HOST}/${KEY}.txt"
ENDPOINT="https://api.indexnow.org/indexnow"

if [ $# -gt 0 ]; then
  # Submit specific URLs passed as arguments
  URLS=$(printf '"%s",' "$@")
  URLS="[${URLS%,}]"
else
  # Extract all URLs from sitemap.xml
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  SITEMAP="${SCRIPT_DIR}/sitemap.xml"
  if [ ! -f "$SITEMAP" ]; then
    echo "Error: sitemap.xml not found at $SITEMAP"
    exit 1
  fi
  URLS=$(sed -n 's/.*<loc>\(.*\)<\/loc>.*/"\1"/p' "$SITEMAP" | paste -sd',' -)
  URLS="[${URLS}]"
fi

echo "Submitting URLs to IndexNow..."
echo "Endpoint: $ENDPOINT"
echo "Host: $HOST"
echo ""

RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$ENDPOINT" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d "{
    \"host\": \"${HOST}\",
    \"key\": \"${KEY}\",
    \"keyLocation\": \"${KEY_LOCATION}\",
    \"urlList\": ${URLS}
  }")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

echo "HTTP Status: $HTTP_CODE"
if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "202" ]; then
  echo "Success! URLs submitted to IndexNow."
else
  echo "Response: $BODY"
fi
