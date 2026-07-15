const { createClient } = require('@vercel/kv');
const fs = require('fs');
const path = require('path');

// Manually parse .env.local
const envPath = path.join(__dirname, '..', '.env.local');
const envContent = fs.readFileSync(envPath, 'utf8');
const envVars = {};
envContent.split('\n').forEach(line => {
  const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
  if (match) {
    const key = match[1];
    let value = match[2] || '';
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    envVars[key] = value;
  }
});

// Configure KV client manually
const kv = createClient({
  url: envVars.KV_REST_API_URL,
  token: envVars.KV_REST_API_TOKEN,
});

async function run() {
  try {
    const settings = await kv.get('overlay_settings');
    const token = settings.streamElementsToken;
    const channelId = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()).channel;

    const res = await fetch(`https://api.streamelements.com/kappa/v2/sessions/${channelId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const result = await res.json();
    const data = result.data;
    
    // Print all keys containing "sub"
    const subKeys = {};
    for (const key of Object.keys(data)) {
      if (key.includes('sub')) {
        subKeys[key] = data[key];
      }
    }
    console.log('Sub Keys:', JSON.stringify(subKeys, null, 2));
  } catch (err) {
    console.error('Fetch error:', err);
  }
}

run();
