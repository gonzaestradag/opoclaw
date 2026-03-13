# make-video

Create talking avatar videos using D-ID + ffmpeg in OpoClaw style.

## When to use this skill

Trigger when the user asks to:
- Create a talking video with an avatar
- Generate a video with Thorn or any agent speaking
- Make a video announcement, presentation, or message
- Record a video report with a talking head

## Setup

- D-ID API key: stored in `${REPO_DIR}/.env` as `DID_API_KEY`
- Auth format: `Authorization: Basic {DID_API_KEY}` (the key is already in Basic auth format)
- D-ID base URL: `https://api.d-id.com`
- ffmpeg: installed at `/opt/homebrew/bin/ffmpeg` (v8.0.1)

## Assets

### Thorn Avatar
- PNG: `${REPO_DIR}/dashboard/public/avatars/thorn.png`
- JPG: `${REPO_DIR}/dashboard/public/avatars/thorn.jpg`
- Use the PNG for D-ID (cleaner edges, transparent-capable)

### Other Agent Avatars
All agent portraits are at `${REPO_DIR}/dashboard/public/avatars/{agent-id}.png`
Examples: `marcus-reyes.png`, `jordan-walsh.png`, `aria-nakamura.png`, etc.

### OpoClaw Branding
- Logo SVG: `${REPO_DIR}/workspace/opoclaw-logo-transparent.svg`
- Logo HD PNG: `${REPO_DIR}/workspace/opoclaw-logo-hd.png`

## D-ID API — Create Talking Video

### Step 1: Create a talk (POST /talks)

```bash
DID_KEY=$(grep DID_API_KEY ${REPO_DIR}/.env | cut -d= -f2)

# Using a hosted image URL (D-ID requires publicly accessible URL)
# If avatar is local, upload to a temp host or use D-ID's /images endpoint first

RESPONSE=$(curl -s -X POST "https://api.d-id.com/talks" \
  -H "Authorization: Basic $DID_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "source_url": "https://your-public-url/thorn.png",
    "script": {
      "type": "text",
      "input": "Hello, I am Thorn. Here is your report.",
      "provider": {
        "type": "elevenlabs",
        "voice_id": "06RLvYUqE7ke4HDI57RQ"
      }
    },
    "config": {
      "fluent": true,
      "pad_audio": 0
    }
  }')

TALK_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "Talk ID: $TALK_ID"
```

### Step 2: Poll for completion (GET /talks/{id})

```bash
while true; do
  STATUS_RESP=$(curl -s -X GET "https://api.d-id.com/talks/$TALK_ID" \
    -H "Authorization: Basic $DID_KEY")
  STATUS=$(echo "$STATUS_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])")
  echo "Status: $STATUS"
  if [ "$STATUS" = "done" ]; then
    VIDEO_URL=$(echo "$STATUS_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['result_url'])")
    echo "Video URL: $VIDEO_URL"
    break
  elif [ "$STATUS" = "error" ]; then
    echo "Error: $STATUS_RESP"
    break
  fi
  sleep 5
done
```

### Step 3: Download the video

```bash
curl -o /tmp/talking-avatar.mp4 "$VIDEO_URL"
```

## Alternative: Using pre-recorded audio with D-ID

If you already have an audio file (from ElevenLabs TTS), use audio input:

```bash
curl -s -X POST "https://api.d-id.com/talks" \
  -H "Authorization: Basic $DID_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "source_url": "https://your-public-url/thorn.png",
    "script": {
      "type": "audio",
      "audio_url": "https://your-public-url/audio.mp3"
    }
  }'
```

## D-ID /images endpoint — Upload local avatar

D-ID requires public URLs. To use local avatars, upload first:

```bash
DID_KEY=$(grep DID_API_KEY ${REPO_DIR}/.env | cut -d= -f2)

UPLOAD_RESP=$(curl -s -X POST "https://api.d-id.com/images" \
  -H "Authorization: Basic $DID_KEY" \
  -F "image=@${REPO_DIR}/dashboard/public/avatars/thorn.png")

IMAGE_URL=$(echo "$UPLOAD_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['url'])")
echo "Hosted image URL: $IMAGE_URL"
# Use IMAGE_URL as source_url in /talks request
```

## ffmpeg — Compositing and Post-Processing

### Add text overlay to video

```bash
ffmpeg -i /tmp/talking-avatar.mp4 \
  -vf "drawtext=text='OpoClaw Report':fontsize=36:fontcolor=white:x=(w-text_w)/2:y=50:shadowcolor=black:shadowx=2:shadowy=2" \
  -c:a copy \
  /tmp/output-with-text.mp4
```

### Add logo watermark

```bash
ffmpeg -i /tmp/talking-avatar.mp4 \
  -i ${REPO_DIR}/workspace/opoclaw-logo-hd.png \
  -filter_complex "overlay=20:20" \
  -c:a copy \
  /tmp/output-with-logo.mp4
```

### Add dark background frame / intro

```bash
# Create 3-second dark intro with title text
ffmpeg -f lavfi -i "color=c=0x0a0e1a:size=854x480:duration=3" \
  -vf "drawtext=text='OpoClaw':fontsize=60:fontcolor=0x14b8a6:x=(w-text_w)/2:y=(h-text_h)/2" \
  /tmp/intro.mp4

# Concatenate intro + talking video
ffmpeg -i /tmp/intro.mp4 -i /tmp/talking-avatar.mp4 \
  -filter_complex "[0:v][1:v]concat=n=2:v=1:a=0[outv]" \
  -map "[outv]" \
  /tmp/full-video.mp4
```

### Add background music (ducked under speech)

```bash
ffmpeg -i /tmp/talking-avatar.mp4 -i /path/to/background-music.mp3 \
  -filter_complex "[1:a]volume=0.15[bg];[0:a][bg]amix=inputs=2:duration=first[a]" \
  -map 0:v -map "[a]" \
  -c:v copy \
  /tmp/video-with-music.mp4
```

### Trim video

```bash
ffmpeg -i /tmp/talking-avatar.mp4 -ss 00:00:02 -to 00:00:30 -c copy /tmp/trimmed.mp4
```

### Convert to different format / compress

```bash
ffmpeg -i /tmp/talking-avatar.mp4 -vcodec libx264 -crf 23 -preset fast /tmp/compressed.mp4
```

## Full Workflow: Script to Final Video

```
1. User provides script/text
2. (Optional) Generate TTS via ElevenLabs: node ${REPO_DIR}/dist/index.js tts "text"
3. Upload avatar to D-ID: POST /images → get hosted URL
4. Create talk: POST /talks with source_url + script → get talk_id
5. Poll: GET /talks/{id} until status = "done" → get result_url
6. Download video: curl -o output.mp4 {result_url}
7. Compose with ffmpeg: add logo, text, intro, music as needed
8. Send to Telegram: [SEND_FILE:/path/to/output.mp4|caption]
9. Save to Brain Vault: bash ${REPO_DIR}/scripts/brain-save.sh /path/to/output.mp4 "Negocio"
```

## ElevenLabs Voice IDs (for D-ID TTS provider)

- Thorn's voice: `06RLvYUqE7ke4HDI57RQ` (from ELEVENLABS_VOICE_ID in .env)

## D-ID Credits

- Plan: Pro
- Total: 600 credits/month
- Expiry: ~April 10, 2026
- Check remaining: `bash ${REPO_DIR}/scripts/test-did.sh`

## Verify API Working

```bash
bash ${REPO_DIR}/scripts/test-did.sh
```

Returns current credit balance if key is valid.

## OpoClaw Video Style Guidelines

- Dark background: `#0a0e1a`
- Accent color: teal `#14b8a6`
- Always include OpoClaw logo watermark (top-left corner)
- Resolution: 854x480 or 1280x720
- Format: MP4 (H.264)
- Agent speaks as themselves — use their portrait and voice
- Keep videos under 2 minutes for Telegram delivery
