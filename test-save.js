const http = require('http');
const https = require('https');

async function run() {
  // Login
  const loginRes = await fetch('http://localhost:3000/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'admin' })
  });
  
  const setCookie = loginRes.headers.get('set-cookie');
  console.log('Set-Cookie:', setCookie);
  
  // Save settings
  const saveRes = await fetch('http://localhost:3000/api/save-settings', {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Cookie': setCookie
    },
    body: JSON.stringify({ settings: { socialLoopAnimation: true, socialLoopShowDuration: 10, socialLoopHideDuration: 5 } })
  });
  
  const text = await saveRes.text();
  console.log('Save status:', saveRes.status);
  console.log('Save response:', text);
}
run();
