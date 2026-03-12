#!/usr/bin/env node
/**
 * setup-heygen-avatar.cjs
 * One-time setup: uploads Thorn's photo to HeyGen and saves the avatar ID to .env
 * Run once after adding HEYGEN_API_KEY to .env:
 *   node scripts/setup-heygen-avatar.cjs
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ENV_FILE = path.join(__dirname, '../.env');

function readEnv() {
  const env = {};
  fs.readFileSync(ENV_FILE, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) env[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '');
  });
  return env;
}

function setEnvVar(key, value) {
  let content = fs.readFileSync(ENV_FILE, 'utf8');
  if (content.includes(`${key}=`)) {
    content = content.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
  } else {
    content += `\n${key}=${value}`;
  }
  fs.writeFileSync(ENV_FILE, content);
}

async function uploadTalkingPhoto(apiKey, photoPath) {
  // HeyGen requires raw binary POST with Content-Type: image/jpeg
  const fileBuffer = fs.readFileSync(photoPath);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'upload.heygen.com',
      path: '/v1/talking_photo',
      method: 'POST',
      headers: {
        'X-Api-Key': apiKey,
        'Content-Type': 'image/jpeg',
        'Content-Length': fileBuffer.length,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          reject(new Error('Invalid JSON response: ' + data));
        }
      });
    });

    req.on('error', reject);
    req.write(fileBuffer);
    req.end();
  });
}

async function main() {
  const env = readEnv();
  const apiKey = env.HEYGEN_API_KEY;

  if (!apiKey) {
    console.error('ERROR: HEYGEN_API_KEY is not set in .env');
    console.error('Get your key at: https://app.heygen.com/settings/api');
    process.exit(1);
  }

  if (env.HEYGEN_THORN_AVATAR_ID) {
    console.log('Thorn avatar already set:', env.HEYGEN_THORN_AVATAR_ID);
    console.log('To re-upload, clear HEYGEN_THORN_AVATAR_ID in .env and re-run.');
    process.exit(0);
  }

  const photoPath = path.join(__dirname, '../dashboard/public/avatars/thorn.jpg');
  if (!fs.existsSync(photoPath)) {
    console.error('ERROR: thorn.jpg not found at', photoPath);
    process.exit(1);
  }

  console.log('Uploading Thorn photo to HeyGen...');
  console.log('Photo:', photoPath);

  const result = await uploadTalkingPhoto(apiKey, photoPath);
  console.log('HeyGen response:', JSON.stringify(result, null, 2));

  const avatarId = result?.data?.talking_photo_id || result?.talking_photo_id;
  if (!avatarId) {
    console.error('ERROR: No talking_photo_id in response. Full response:', result);
    process.exit(1);
  }

  setEnvVar('HEYGEN_THORN_AVATAR_ID', avatarId);
  console.log('\nSuccess! Thorn avatar ID saved to .env:', avatarId);
  console.log('You can now use: node scripts/generate-video.cjs "Your script here"');
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
