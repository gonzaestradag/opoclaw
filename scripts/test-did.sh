#!/bin/bash
# Test D-ID API connectivity
DID_KEY=$(grep DID_API_KEY /Users/opoclaw1/claudeclaw/.env | cut -d= -f2)
echo "Testing D-ID API..."
curl -s -X GET "https://api.d-id.com/credits" \
  -H "Authorization: Basic $DID_KEY" \
  -H "Content-Type: application/json" | python3 -m json.tool
