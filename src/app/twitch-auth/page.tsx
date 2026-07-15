'use client';

import { useEffect, useState, Suspense } from 'react';
import { useRouter } from 'next/navigation';

function TwitchAuthHandler() {
  const router = useRouter();
  const [status, setStatus] = useState('Connecting to Twitch...');

  useEffect(() => {
    const handleAuth = async () => {
      try {
        // Parse the hash from the URL
        const hash = window.location.hash.substring(1);
        if (!hash) {
          setStatus('Error: No authentication data found.');
          setTimeout(() => router.push('/'), 3000);
          return;
        }

        const params = new URLSearchParams(hash);
        const accessToken = params.get('access_token');

        if (!accessToken) {
          setStatus('Error: Access token missing.');
          setTimeout(() => router.push('/'), 3000);
          return;
        }

        setStatus('Authenticating with Twitch...');

        // Fetch user data from Twitch to get Broadcaster ID and Username
        const res = await fetch('https://api.twitch.tv/helix/users', {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Client-Id': 'xjl7wqa2c3pyrb7u1d9wyzp6xlyyiw' // Hardcoded client ID as requested
          }
        });

        if (!res.ok) {
          throw new Error('Failed to fetch Twitch user data');
        }

        const data = await res.json();
        
        if (!data.data || data.data.length === 0) {
          throw new Error('Invalid user data received from Twitch');
        }

        const user = data.data[0];
        const broadcasterId = user.id;
        const username = user.display_name;

        setStatus(`Connected as ${username}! Saving settings...`);

        // Get existing settings first to merge
        const settingsRes = await fetch('/api/get-settings');
        const currentSettings = await settingsRes.json();

        // Save new settings
        await fetch('/api/save-settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...currentSettings,
            twitchToken: accessToken,
            twitchBroadcasterId: broadcasterId,
            twitchUsername: username,
            twitchClientId: 'xjl7wqa2c3pyrb7u1d9wyzp6xlyyiw'
          })
        });

        setStatus('Success! Redirecting back to dashboard...');
        
        // Clear hash and redirect
        window.history.replaceState(null, '', window.location.pathname);
        setTimeout(() => router.push('/'), 1000);

      } catch (error) {
        console.error('Twitch Auth Error:', error);
        setStatus(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        setTimeout(() => router.push('/'), 4000);
      }
    };

    handleAuth();
  }, [router]);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      backgroundColor: '#0f0f11',
      color: '#fff',
      fontFamily: 'Inter, sans-serif'
    }}>
      <h1 style={{ fontSize: '24px', marginBottom: '16px' }}>Twitch Authentication</h1>
      <p style={{ fontSize: '16px', opacity: 0.8 }}>{status}</p>
    </div>
  );
}

export default function TwitchAuthPage() {
  return (
    <Suspense fallback={<div style={{ color: 'white', padding: '20px', textAlign: 'center' }}>Loading...</div>}>
      <TwitchAuthHandler />
    </Suspense>
  );
}
