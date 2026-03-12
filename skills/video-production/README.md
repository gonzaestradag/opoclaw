# video-production

Produce a commercial-quality AI video for OpoClaw. Takes a brief/document and outputs a fully assembled video.

## Workflow

1. **Script** — Pixel Jones writes the script and scene breakdown (30–120 seconds, timed segments)
2. **Voiceover** — Generate narration using ElevenLabs with Gonzalo's voice clone
3. **Visuals** — Generate scenes using available AI video APIs (Sora, Pika, RunwayML) or DALL-E for stills
4. **Assembly** — Combine clips + voiceover + music into final video using ffmpeg
5. **Deliver** — Send the final video to Telegram and save to Brain

## Triggers

Use this skill for: "haz un video", "produce a commercial", "video de OpoClaw", "video marketing", "crea un reel", "brand video"

## Voice generation

```bash
# Generate voiceover with ElevenLabs
ELEVEN_KEY=$(grep ELEVENLABS_API_KEY /Users/opoclaw1/claudeclaw/.env | cut -d= -f2)
VOICE_ID=$(grep ELEVENLABS_VOICE_ID /Users/opoclaw1/claudeclaw/.env | cut -d= -f2)

curl -s -X POST "https://api.elevenlabs.io/v1/text-to-speech/$VOICE_ID" \
  -H "xi-api-key: $ELEVEN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "SCRIPT TEXT HERE",
    "model_id": "eleven_turbo_v2_5",
    "voice_settings": {"stability": 0.5, "similarity_boost": 0.75}
  }' \
  --output /tmp/voiceover.mp3
```

## Video generation options (check which API keys are available)

```bash
# Check available video generation APIs
grep -i "SORA\|PIKA\|RUNWAY\|KLING\|LUMA\|FAL_\|REPLICATE" /Users/opoclaw1/claudeclaw/.env

# Option 1: FAL.ai (supports many models including fast-svd, kling, etc.)
FAL_KEY=$(grep FAL_API_KEY /Users/opoclaw1/claudeclaw/.env | cut -d= -f2)

# Option 2: Replicate
REPLICATE_KEY=$(grep REPLICATE_API_TOKEN /Users/opoclaw1/claudeclaw/.env | cut -d= -f2)

# Option 3: If no video API, use DALL-E for stills + ffmpeg to make a slideshow video
OPENAI_KEY=$(grep OPENAI_API_KEY /Users/opoclaw1/claudeclaw/.env | cut -d= -f2)
```

## Assembly with ffmpeg

```bash
# Combine clips into video
ffmpeg -f concat -safe 0 -i /tmp/clips.txt -c copy /tmp/assembled.mp4

# Add voiceover to assembled video
ffmpeg -i /tmp/assembled.mp4 -i /tmp/voiceover.mp3 -c:v copy -c:a aac -shortest /tmp/final.mp4

# Add background music (lower volume)
ffmpeg -i /tmp/final.mp4 -i /tmp/bgmusic.mp3 -filter_complex "[1:a]volume=0.15[music];[0:a][music]amix=inputs=2:duration=first" /tmp/final_with_music.mp4
```

## Output format

- Resolution: 1920x1080 (or 1080x1920 for vertical/Reels)
- Duration: 30–120 seconds
- Format: MP4, H.264

## Delivery

```bash
# Send to Telegram
BOT_TOKEN=$(grep TELEGRAM_BOT_TOKEN /Users/opoclaw1/claudeclaw/.env | cut -d= -f2)
CHAT_ID=$(grep TELEGRAM_CHAT_ID /Users/opoclaw1/claudeclaw/.env | cut -d= -f2)
curl -s -F "chat_id=$CHAT_ID" -F "video=@/tmp/final.mp4" -F "caption=VIDEO TITLE" \
  "https://api.telegram.org/bot$BOT_TOKEN/sendVideo"

# Save to Brain
bash /Users/opoclaw1/claudeclaw/scripts/brain-save.sh "/tmp/final.mp4" "Negocio"
```
