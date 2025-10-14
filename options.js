// options.js

// --- PKCE Utility Functions (NEW) ---

// Generate a random string for state or verifier (must be URL-safe)
function generateRandomString(length = 64) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    let randomString = '';
    const array = new Uint8Array(length);
    window.crypto.getRandomValues(array);
    for (let i = 0; i < length; i++) {
        randomString += chars[array[i] % chars.length];
    }
    return randomString;
}

// Convert ArrayBuffer to URL-safe base64 string
function base64UrlEncode(buffer) {
    // btoa requires binary string input.
    const binary = String.fromCharCode.apply(null, new Uint8Array(buffer));
    return btoa(binary)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, ''); // Remove padding
}

// Generate the S256 code challenge from the code verifier
async function generateCodeChallenge(codeVerifier) {
    const data = new TextEncoder().encode(codeVerifier);
    const digest = await window.crypto.subtle.digest('SHA-256', data);
    return base64UrlEncode(digest);
}

// --- Tab Switching Logic ---
document.querySelectorAll('.tab').forEach(t=>{
  t.addEventListener('click', ()=> {
    document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
    t.classList.add('active');
    document.getElementById(t.dataset.target).classList.add('active');
  });
});

// utility: normalize channel input -> array of tokens
function parseList(s){
  if(!s) return [];
  return s.split(/\s*[,\n]\s*/).map(x=>x.trim()).filter(Boolean);
}

// --- save / load helpers ---
// helper cookie functions (url should match the host that should receive the cookie)
async function setAccessTokenCookie(url, name, value, days = 7){
  const expires = Math.floor(Date.now()/1000) + days*24*60*60;
  await browser.cookies.set({
    url,
    name,
    value: value || '',
    path: '/',
    secure: true,
    sameSite: 'lax',
    expirationDate: expires
  });
}

async function getAccessTokenCookie(url, name){
  const cookie = await browser.cookies.get({ url, name });
  return cookie?.value || '';
}

async function removeAccessTokenCookie(url, name){
  await browser.cookies.remove({ url, name });
}

// saveSettings: store non-access-token fields in storage.local and access token in cookies
async function saveSettings(platform, obj){
  // keep storage.local structure
  const st = await browser.storage.local.get('streamtime') || {};
  st.streamtime = st.streamtime || {};
  st.streamtime[platform] = Object.assign(st.streamtime[platform]||{}, obj);

  // Extract and remove accessToken if present in obj
  const accessToken = obj.accessToken;
  if(accessToken !== undefined){
    delete st.streamtime[platform].accessToken; // do not persist access token in storage.local
  }

  await browser.storage.local.set(st);

  // Set cookie for access token if provided (or remove if empty)
  if(platform === 'twitch'){
    const url = 'https://api.twitch.tv/'; 
    if(accessToken) await setAccessTokenCookie(url, 'twitch_access_token', accessToken);
    else await removeAccessTokenCookie(url, 'twitch_access_token');
  } else if(platform === 'kick'){
    const url = 'https://kick.com/';
    if(accessToken) await setAccessTokenCookie(url, 'kick_access_token', accessToken);
    else await removeAccessTokenCookie(url, 'kick_access_token');
  } else if(platform === 'youtube'){
    const url = 'https://www.googleapis.com/';
    if(accessToken) await setAccessTokenCookie(url, 'youtube_access_token', accessToken);
    else await removeAccessTokenCookie(url, 'youtube_access_token');
  }
}

// loadAll: read storage.local for non-access-token fields and read cookies for access tokens
async function loadAll(){
  const data = (await browser.storage.local.get('streamtime'))?.streamtime || {};

  if(data.twitch){
    document.getElementById('twitch-client-id').value = data.twitch.clientId || '';
    document.getElementById('twitch-client-secret').value = data.twitch.clientSecret || '';
    document.getElementById('twitch-access-token').value =
      await getAccessTokenCookie('https://api.twitch.tv/', 'twitch_access_token') || '';
    document.getElementById('twitch-refresh-token').value = data.twitch.refreshToken || '';
    document.getElementById('twitch-channels').value = (data.twitch.channels || []).map(c=>c.login||c.name||c.id||'').join('\n');
    if(data.twitch.channels && data.twitch.channels.length) showConverted('twitch', data.twitch.channels);
  }

  if(data.kick){
    document.getElementById('kick-client-id').value = data.kick.clientId || '';
    document.getElementById('kick-client-secret').value = data.kick.clientSecret || '';
    document.getElementById('kick-access-token').value =
      await getAccessTokenCookie('https://kick.com/', 'kick_access_token') || '';
    document.getElementById('kick-refresh-token').value = data.kick.refreshToken || '';
    document.getElementById('kick-channels').value = (data.kick.channels || []).map(c=>c.slug || c.id || '').join('\n');
    if(data.kick.channels && data.kick.channels.length) showConverted('kick', data.kick.channels);
  }

  if(data.youtube){
    document.getElementById('youtube-client-id').value = data.youtube.clientId || '';
    document.getElementById('youtube-access-token').value =
      await getAccessTokenCookie('https://www.googleapis.com/', 'youtube_access_token') || '';
    document.getElementById('youtube-channels').value = (data.youtube.channels || []).map(c=>c.id||'').join('\n');
    if(data.youtube.channels && data.youtube.channels.length) showConverted('youtube', data.youtube.channels);
  }
}

// --- save buttons ---
document.getElementById('twitch-save').addEventListener('click', async ()=> {
  const clientId = document.getElementById('twitch-client-id').value.trim();
  const clientSecret = document.getElementById('twitch-client-secret').value.trim();
  const accessToken = document.getElementById('twitch-access-token').value.trim();
  const refreshToken = document.getElementById('twitch-refresh-token').value.trim();
  const convertedRaw = document.getElementById('twitch-converted').dataset.value;
  const channels = convertedRaw ? JSON.parse(convertedRaw) : parseList(document.getElementById('twitch-channels').value).map(s=>({ login: s }));

  await saveSettings('twitch', { clientId, clientSecret, accessToken, refreshToken, channels });
  browser.runtime.sendMessage({ action: 'poll_now' });
  alert('Saved Twitch settings and updated live list.');
});

document.getElementById('kick-save').addEventListener('click', async ()=> {
  const clientId = document.getElementById('kick-client-id').value.trim();
  const clientSecret = document.getElementById('kick-client-secret').value.trim();
  const accessToken = document.getElementById('kick-access-token').value.trim();
  const refreshToken = document.getElementById('kick-refresh-token').value.trim();
  const convertedRaw = document.getElementById('kick-converted').dataset.value;
  const channels = convertedRaw ? JSON.parse(convertedRaw) : parseList(document.getElementById('kick-channels').value).map(s=>({ slug: s }));

  await saveSettings('kick', { clientId, clientSecret, accessToken, refreshToken, channels });
  browser.runtime.sendMessage({ action: 'poll_now' });
  alert('Saved Kick settings and updated live list.');
});

document.getElementById('youtube-save').addEventListener('click', async ()=> {
  const apiKey = document.getElementById('youtube-client-id').value.trim();
  const convertedRaw = document.getElementById('youtube-converted').dataset.value;
  const channels = convertedRaw ? JSON.parse(convertedRaw) : parseList(document.getElementById('youtube-channels').value).map(s=>({ id: s }));

  await saveSettings('youtube', { clientId: apiKey, channels });
  browser.runtime.sendMessage({ action: 'poll_now' });
  alert('Saved YouTube settings and updated live list.');
});


function showConverted(platform, list){
  const el = document.getElementById(platform+'-converted');
  el.style.display='block';
  el.innerHTML = '<strong>Converted:</strong><br>' + list.map(x=>{
    if(typeof x === 'string') return x;
    // x is object
    return (x.login || x.name || x.slug || x.id) + ' → ' + (x.id || x.user_id || x.channel_id || x.slug);
  }).join('<br>');
}

// Twitch: convert usernames to ids via Helix /users?login=
async function twitchConvert(usernames, clientId, accessToken){
  if(!usernames.length) return [];
  if(!clientId || !accessToken) throw new Error('Twitch client id and access token required for conversion.');
  const chunks = [];
  for(let i=0;i<usernames.length;i+=100) chunks.push(usernames.slice(i,i+100));
  const results = [];
  for(const chunk of chunks){
    const url = 'https://api.twitch.tv/helix/users?'+ new URLSearchParams(chunk.map(u=>['login',u]));
    const res = await fetch(url, {
      headers: {
        'Client-ID': clientId,
        'Authorization': 'Bearer ' + accessToken,
      }
    });
    if(!res.ok) {
      const txt = await res.text();
      throw new Error('Twitch users lookup failed: '+res.status+' '+txt);
    }
    const data = await res.json();
    // data.data is an array of user objects with id and login
    results.push(...(data.data||[]));
  }
  return results;
}

// Kick: attempt to convert slugs to channel objects.
async function kickConvert(slugs, accessToken){
    if(!slugs.length) return [];
    
    // Store results in a map for easy lookup by original slug
    const resultsMap = new Map(slugs.map(s => [s, { slug: s, id: null }]));

    // 1. Build the API URL for batch lookup using the 'slug' parameter
    const url = new URL("https://api.kick.com/public/v1/channels");
    
    // Append multiple 'slug' parameters for batch lookup
    for (const s of slugs) {
        url.searchParams.append("slug", s);
    }

    const headers = {
        "Accept": "application/json",
    };
    if (accessToken) {
        headers.Authorization = 'Bearer ' + accessToken;
		console.log("Kick has an access token! Yay!");
    }
    
    try {
        console.log(`[Kick Convert] Attempting batch lookup for ${slugs.length} slugs.`);
        const res = await fetch(url.toString(), { headers });
        
        if (!res.ok) {
            console.error(`Kick API lookup failed with status ${res.status}: ${res.statusText}`);
            // Do not throw, just return the list of non-converted slugs
            return Array.from(resultsMap.values());
        }

        const json = await res.json();
        const channels = json.data || [];

        // 2. Process the batch response
        for (const ch of channels) {
            const slug = ch.slug;
            const id = ch.broadcaster_user_id;

            if (slug && id) {
                // If a channel was successfully found, update the results map
                resultsMap.set(slug, { 
                    slug: slug,
                    id: id,
                    user_id: id, // For consistency with previous logic
                    name: ch.name || ch.slug 
                });
            } else {
                console.warn(`[Kick Convert] Found channel object but missing slug or ID:`, ch);
            }
        }
        
        console.log(`[Kick Convert] Successfully converted ${channels.length} slugs.`);
        
    } catch(e){
        console.error(`Kick batch conversion error:`, e);
    }

    // 3. Return the array of all results (converted or not)
    return Array.from(resultsMap.values());
}


// YouTube: convert names/handles to channel IDs using Data API v3
async function youtubeConvert(list, apiKey){
  if(!list.length) return [];
  const results = [];
  for(const token of list){
    // If it already looks like a channel ID (starts with UC), keep it
    if(/^UC[A-Za-z0-9_-]{20,}$/.test(token)){
      results.push({ id: token });
      continue;
    }
    // try "forUsername" first
    try {
      const urlByName = 'https://www.googleapis.com/youtube/v3/channels?part=snippet&forUsername=' + encodeURIComponent(token) + '&key=' + encodeURIComponent(apiKey);
      const r1 = await fetch(urlByName);
      if(r1.ok){
        const j1 = await r1.json();
        if(j1.items && j1.items.length){
          results.push({ id: j1.items[0].id, title: j1.items[0].snippet.title });
          continue;
        }
      }
    } catch(e){}
    // fallback: try search by channel handle / custom url using search endpoint
    try {
      const urlSearch = 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&q=' + encodeURIComponent(token) + '&key=' + encodeURIComponent(apiKey);
      const r2 = await fetch(urlSearch);
      if(r2.ok){
        const j2 = await r2.json();
        if(j2.items && j2.items.length){
          results.push({ id: j2.items[0].snippet.channelId, title: j2.items[0].snippet.channelTitle });
          continue;
        }
      }
    } catch(e){}
    results.push({ query: token, id: null });
  }
  return results;
}

// EVENT HANDLERS for UI buttons
document.getElementById('twitch-convert').addEventListener('click', async ()=>{
  const clientId = document.getElementById('twitch-client-id').value.trim();
  const accessToken = document.getElementById('twitch-access-token').value.trim();
  const raw = parseList(document.getElementById('twitch-channels').value);
  try{
    const r = await twitchConvert(raw, clientId, accessToken);
    document.getElementById('twitch-converted').style.display='block';
    document.getElementById('twitch-converted').innerHTML = '<strong>Converted:</strong><br>' + (r.map(u=>`${u.login || u.display_name || u.broadcaster_login || ''} → ${u.id}`).join('<br>'));
    document.getElementById('twitch-converted').dataset.value = JSON.stringify(r);
  }catch(err){
    alert('Twitch convert failed: '+err.message);
  }
});

document.getElementById('kick-convert').addEventListener('click', async ()=>{
  const accessToken = document.getElementById('kick-access-token').value.trim();
  const raw = parseList(document.getElementById('kick-channels').value);
  try{
    const r = await kickConvert(raw, accessToken);
    document.getElementById('kick-converted').style.display='block';
    document.getElementById('kick-converted').innerHTML = '<strong>Converted:</strong><br>' + (r.map(c=>`${c.slug || c.name || ''} → ${c.id || 'Failed'}`).join('<br>'));
    document.getElementById('kick-converted').dataset.value = JSON.stringify(r);
  }catch(err){
    alert('Kick conversion failed: '+err.message);
  }
});

document.getElementById('youtube-convert').addEventListener('click', async ()=>{
  const apiKey = document.getElementById('youtube-client-id').value.trim();
  const raw = parseList(document.getElementById('youtube-channels').value);
  try{
    const r = await youtubeConvert(raw, apiKey);
    document.getElementById('youtube-converted').style.display='block';
    document.getElementById('youtube-converted').innerHTML = '<strong>Converted:</strong><br>' + (r.map(c=>`${c.query || c.title || ''} → ${c.id || 'Failed'}`).join('<br>'));
    document.getElementById('youtube-converted').dataset.value = JSON.stringify(r);
  }catch(err){
    alert('YouTube conversion failed: '+err.message);
  }
});


// IIFE for initialization and OAuth flows
(async () => {
  // Load settings initially
  await loadAll(); 
  
  const redirectUri = browser.identity.getRedirectURL();
  document.getElementById('twitch-redirect-uri').textContent = redirectUri;
  document.getElementById('kick-redirect-uri').textContent = redirectUri;

  // ---- TWITCH AUTH FLOW ----
  document.getElementById('twitch-auth').addEventListener('click', async () => {
    const clientId = document.getElementById('twitch-client-id').value.trim();
    const clientSecret = document.getElementById('twitch-client-secret').value.trim();
    if (!clientId) return alert('Enter your Twitch Client ID first.');

    const authUrl = `https://id.twitch.tv/oauth2/authorize?` + new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'user:read:email'
    });

    try {
      const redirectData = await browser.identity.launchWebAuthFlow({
        url: authUrl,
        interactive: true
      });

      const code = new URL(redirectData).searchParams.get('code');
      if (!code) throw new Error('No authorization code returned.');

      const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri
        })
      });

      const tokenData = await tokenRes.json();
      console.log('Twitch token response:', tokenData);

      if (tokenData.access_token) {
        document.getElementById('twitch-access-token').value = tokenData.access_token;
      }
      if (tokenData.refresh_token) {
        document.getElementById('twitch-refresh-token').value = tokenData.refresh_token;
      }

      if (!tokenData.access_token && !tokenData.refresh_token) {
        alert('Twitch authorization response received but no tokens returned. Check console for full data.');
      } else {
        alert('Twitch authorization successful! Remember to click Save.');
      }
    } catch (e) {
      console.error('Twitch OAuth failed:', e);
      alert('Twitch authorization failed. Check console.');
    }
  });

  // ---- KICK AUTH FLOW (MODIFIED FOR PKCE) ----
  document.getElementById('kick-auth').addEventListener('click', async () => {
    const clientId = document.getElementById('kick-client-id').value.trim();
    const clientSecret = document.getElementById('kick-client-secret').value.trim();
    if (!clientId) return alert('Enter your Kick Client ID first.');

    // --- PKCE GENERATION ---
    const state = generateRandomString(32);
    const codeVerifier = generateRandomString(); // Default 64 length
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    // -----------------------

    const authUrl = `https://id.kick.com/oauth/authorize?` + new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'user:read channel:read events:subscribe',
      state: state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    });

    console.log(`Generated auth URL for kick.com = ${authUrl}`);

    try {
      const redirectData = await browser.identity.launchWebAuthFlow({
        url: authUrl,
        interactive: true
      });

      const urlParams = new URL(redirectData).searchParams;
      const code = urlParams.get('code');
      const returnedState = urlParams.get('state');

      if (!code) throw new Error('No authorization code returned. Did you click Authorize?');
      if (returnedState !== state) throw new Error('State mismatch. Potential CSRF attack.');

      const tokenRes = await fetch('https://id.kick.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code: code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
          code_verifier: codeVerifier // PKCE parameter
        })
      });

      const tokenData = await tokenRes.json();
      console.log('Kick token response:', tokenData);

      if (tokenData.access_token) {
        document.getElementById('kick-access-token').value = tokenData.access_token;
      }
      if (tokenData.refresh_token) {
        document.getElementById('kick-refresh-token').value = tokenData.refresh_token;
      }

      if (!tokenData.access_token && !tokenData.refresh_token) {
        alert('Kick authorization response received but no tokens returned. Check console for full data.');
      } else {
        alert('Kick authorization successful! Remember to click Save.');
      }
    } catch (e) {
      console.error('Kick OAuth failed:', e);
      alert('Kick authorization failed. See console.');
    }
  });
})();