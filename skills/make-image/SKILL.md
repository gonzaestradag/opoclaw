---
name: make-image
description: Generate images using DALL-E 3. Triggers on: "genera una imagen", "crea una foto", "make an image", "genera una foto de", "diseña una imagen".
allowed-tools: Bash
---

# make-image

Generate images with DALL-E 3 and send them directly in Telegram.

## Triggers

Use this skill when the user asks to generate, create, or design an image or photo.

## How to use

1. Extract the image description from the user's message
2. Enhance it slightly for better DALL-E results (more detail, style cues) — but keep the original intent
3. Call the API, download the image, send it

## Step 1 — Generate the image

```bash
OPENAI_KEY=$(grep OPENAI_API_KEY ${REPO_DIR}/.env | cut -d= -f2)

RESPONSE=$(curl -s -X POST https://api.openai.com/v1/images/generations \
  -H "Authorization: Bearer $OPENAI_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"dall-e-3\",
    \"prompt\": \"[PROMPT AQUI]\",
    \"n\": 1,
    \"size\": \"1024x1024\",
    \"quality\": \"standard\"
  }")

IMAGE_URL=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data'][0]['url'])")
echo "URL: $IMAGE_URL"
```

## Step 2 — Download it

```bash
OUTPUT="/tmp/generated_image_$(date +%s).png"
curl -s "$IMAGE_URL" -o "$OUTPUT"
echo "Saved to: $OUTPUT"
```

## Step 3 — Send it

Include this marker in your response (the bot sends it automatically):

```
[SEND_PHOTO:/tmp/generated_image_TIMESTAMP.png]
```

Add a short caption if useful.

## Error handling

- If API returns an error, show the error message and ask to rephrase
- If the prompt violates content policy, DALL-E returns a 400 — tell the user and suggest an alternative
- Always use absolute paths for the file marker
