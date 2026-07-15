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
    console.log('Current Settings:');
    console.log(JSON.stringify(settings, null, 2));
  } catch (error) {
    console.error('Error fetching settings:', error);
  }
}

run();
