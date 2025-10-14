// background.js
// Periodically polls platforms for live channels and writes short "live" lists to browser.storage.local.streamtime_live
// Note: This file uses Fetch and browser.alarms for reliable periodic execution in a Service Worker.

// --- Configuration Constants ---
const POLL_INTERVAL_SECONDS = 60; // Main data poll (1 minute)
const NOTIFICATION_CHECK_SECONDS = 5 * 60; // Notification checks (5 minutes)
const TWITCH_REFRESH_INTERVAL_SECONDS = 3.5 * 60 * 60; // Twitch token refresh (3.5 hours)
const KICK_REFRESH_INTERVAL_SECONDS = 3.5 * 60 * 60; // Kick token refresh (3.5 hours)

// Kick's OAuth and API endpoints
const KICK_TOKEN_URL = "https://id.kick.com/oauth/token"; 
// Kick stream check is already correctly set to https://api.kick.com/public/v1/channels

// --- Cookie Helper Functions (NEW) ---

async function setAccessTokenCookie(url, name, value, days = 7){
    const expires = Math.floor(Date.now()/1000) + days*24*60*60;
    await browser.cookies.set({
        url,
        name,
        value: value || '',
        path: '/',
        secure: true,
        sameSite: 'lax', // Fix for "Invalid enumeration value "Lax""
        expirationDate: expires
    });
}

async function getAccessTokenCookie(url, name){
    const cookie = await browser.cookies.get({ url, name });
    return cookie?.value || '';
}

// --- Global Utilities ---

/**
 * Loads the main settings object from browser storage and merges in access tokens from cookies. (MODIFIED)
 * @returns {Promise<object>} The full settings object (e.g., {twitch: {...}, kick: {...}}).
 */
async function loadSettings(){
    const st = (await browser.storage.local.get('streamtime'))?.streamtime || {};

    // Load Twitch access token from cookie
    st.twitch = st.twitch || {};
    st.twitch.accessToken = await getAccessTokenCookie('https://api.twitch.tv/', 'twitch_access_token');

    // Load Kick access token from cookie
    st.kick = st.kick || {};
    st.kick.accessToken = await getAccessTokenCookie('https://kick.com/', 'kick_access_token');

    return st;
}

function nowIso(){ return new Date().toISOString(); }

/**
 * Calculates the uptime string (e.g., "1h 30m").
 * @param {string} startedAtIso - ISO timestamp of when the stream started.
 * @returns {string} Formatted uptime.
 */
function computeUptime(startedAtIso){
    try{
        const start = new Date(startedAtIso);
        const diff = Math.max(0, Date.now() - start.getTime());
        const s = Math.floor(diff/1000);
        const h = Math.floor(s/3600); 
        const m = Math.floor((s%3600)/60);
        if(h>0) return `${h}h ${m}m`;
        return `${m}m`;
    }catch(e){
        return '';
    }
}

// --- Platform Check Functions ---

async function checkTwitch(twitchSettings){
    if(!twitchSettings || !twitchSettings.clientId || !twitchSettings.accessToken || !twitchSettings.channels) return [];
    const ids = twitchSettings.channels.map(c => c.id || c.user_id || c.broadcaster_id).filter(Boolean);
    if(!ids.length) return [];
    try {
        const url = 'https://api.twitch.tv/helix/streams?' + ids.map(i=>'user_id='+encodeURIComponent(i)).join('&');
        const res = await fetch(url, {
            headers: {
                'Client-ID': twitchSettings.clientId,
                'Authorization': 'Bearer ' + twitchSettings.accessToken
            }
        });

        // --- lazy refresh logic ---
        if(res.status === 401 || res.status === 403) {
            console.warn('[Twitch] Access token expired, refreshing...');
            const newToken = await refreshTwitchToken(
                twitchSettings.clientId,
                twitchSettings.clientSecret,
                twitchSettings.refreshToken
            );
            if (newToken) {
                // Since loadSettings pulls from cookie, we need to manually update the setting for the retry
                twitchSettings.accessToken = newToken; 
                // retry once
                return await checkTwitch(twitchSettings);
            } else {
                console.error('[Twitch] Token refresh failed, skipping.');
                return [];
            }
        }

        if(!res.ok) {
            console.warn('Twitch streams fetch failed', res.status);
            return [];
        }

        const j = await res.json();
        return j.data.map(s => ({
            user_id: s.user_id,
            user_login: s.user_login,
            display_name: s.user_name,
            title: s.title,
            game: s.game_name,
            viewers: s.viewer_count,
            started_at: s.started_at,
            uptime: computeUptime(s.started_at),
            url: 'https://twitch.tv/' + s.user_login
        }));
    } catch(e) {
        console.error('Twitch check error', e);
        return [];
    }
}


async function checkKick(kickSettings) {
    if (!kickSettings || !kickSettings.channels) return [];

    const ids = kickSettings.channels.map(c => c.id || c.broadcaster_user_id).filter(Boolean);
    if (!ids.length) return [];

    // Endpoint: https://api.kick.com/public/v1/channels (Correct)
    const idsString = ids.join(',');
    const url = new URL("https://api.kick.com/public/v1/channels");
    url.searchParams.set("broadcaster_user_id", idsString);

    const headers = { "Accept": "application/json" };
    if (kickSettings.accessToken) headers.Authorization = 'Bearer ' + kickSettings.accessToken;

    try {
        const res = await fetch(url, { headers });

        // --- lazy refresh logic ---
        if (res.status === 401 || res.status === 403) {
            console.warn('[Kick] Access token expired, refreshing...');
            const newToken = await refreshKickToken(
                kickSettings.clientId,
                kickSettings.clientSecret,
                kickSettings.refreshToken
            );
            if (newToken) {
                // Since loadSettings pulls from cookie, we need to manually update the setting for the retry
                kickSettings.accessToken = newToken;
                return await checkKick(kickSettings); // retry once
            } else {
                console.error('[Kick] Token refresh failed, skipping.');
                return [];
            }
        }

        if (!res.ok) {
            console.warn(`Kick API error ${res.status}: ${res.statusText}`);
            return [];
        }

        const json = await res.json();
        const channels = json.data || [];

        return channels.filter(ch => ch.stream && ch.stream.is_live)
            .map(ch => ({
                id: ch.broadcaster_user_id,
                slug: ch.slug,
                title: ch.stream_title || `Live on ${ch.slug}`,
                game: ch.category?.name || "Unknown",
                viewers: ch.stream.viewer_count || 0,
                started_at: ch.stream.start_time || null,
                uptime: ch.stream.start_time ? computeUptime(ch.stream.start_time) : "",
                url: `https://kick.com/${ch.slug}`,
            }));
    } catch (e) {
        console.error("Kick check error:", e);
        return [];
    }
}


async function checkYouTube(ytSettings){
    // ... (YouTube logic remains the same)
    if(!ytSettings || !ytSettings.channels || !ytSettings.clientId) return [];
    const apiKey = ytSettings.clientId;
    const out = [];
    for(const ch of ytSettings.channels){
        const channelId = ch.id || ch.channelId || ch;
        if(!channelId) continue;
        try{
            // Use search endpoint to find any live broadcast for the channel
            const url = 'https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=' + encodeURIComponent(channelId) + '&type=video&eventType=live&key=' + encodeURIComponent(apiKey);
            const r = await fetch(url);
            if(!r.ok){
                console.warn('YouTube search failed', r.status);
                continue;
            }
            const j = await r.json();
            if(j.items && j.items.length){
                // the first live video is the stream
                const v = j.items[0];
                out.push({
                    channelId: channelId,
                    title: v.snippet.title,
                    url: 'https://www.youtube.com/watch?v=' + v.id.videoId,
                    started_at: v.snippet.publishedAt,
                    duration: v.snippet.publishedAt ? computeUptime(v.snippet.publishedAt) : ''
                });
            }
        }catch(e){
            console.error('YouTube check error', e);
        }
    }
    return out;
}

// --- Main Polling Function ---
async function mergeSettings(newData) {
    const current = (await browser.storage.local.get('streamtime')).streamtime || {};
    const merged = structuredClone(current);

    for (const key of Object.keys(newData)) {
        merged[key] = Object.assign(merged[key] || {}, newData[key]);
    }

    await browser.storage.local.set({ streamtime: merged });
    return merged;
}

async function pollAll(){
    console.log("[Alarm: Main Poll] Starting poll...");
    // loadSettings now gets access tokens from cookies
    const settings = await loadSettings(); 
    const live = { twitch: [], kick: [], youtube: [] };

    try{
        live.twitch = await checkTwitch(settings.twitch || {});
    }catch(e){ console.error(e); }
    try{
        live.kick = await checkKick(settings.kick || {});
    }catch(e){ console.error(e); }
    try{
        live.youtube = await checkYouTube(settings.youtube || {});
    }catch(e){ console.error(e); }

    // write to storage
    await browser.storage.local.set({ streamtime_live: live });
    // also keep a timestamp
    await browser.storage.local.set({ streamtime_last_poll: nowIso() });
    console.log("[Alarm: Main Poll] Poll complete. Live channels:", 
        live.twitch.length + live.kick.length + live.youtube.length);
}

// --- Notification Check Function (Retained for completeness) ---

let previousLiveChannels = new Set();

async function checkLiveChannels() {
    console.log("[Alarm: Notification] Checking for new live streams...");
    const data = await browser.storage.local.get();
    const liveData = data.streamtime_live || {};

    // Combine all currently live IDs across platforms
    const currentLiveIds = new Set([
        ...(liveData.twitch || []).map(s => `twitch-${s.user_id}`),
        ...(liveData.kick || []).map(s => `kick-${s.id}`),
        ...(liveData.youtube || []).map(s => `yt-${s.channelId}`)
    ]);

    // --- TWITCH notifications ---
    for (const stream of liveData.twitch || []) {
        const id = `twitch-${stream.user_id}`;
        if (!previousLiveChannels.has(id)) {
            browser.notifications.create(id, {
                type: "basic",
                iconUrl: "icon-48.png",
                title: `${stream.display_name} is live on Twitch!`,
                message: stream.title
            });
        }
    }

    // --- KICK notifications ---
    for (const stream of liveData.kick || []) {
        const id = `kick-${stream.id}`;
        if (!previousLiveChannels.has(id)) {
            browser.notifications.create(id, {
                type: "basic",
                iconUrl: "icon-48.png",
                title: `${stream.slug} is live on Kick!`,
                message: stream.title
            });
        }
    }

    // --- YOUTUBE notifications (optional) ---
    for (const stream of liveData.youtube || []) {
        const id = `yt-${stream.channelId}`;
        if (!previousLiveChannels.has(id)) {
            browser.notifications.create(id, {
                type: "basic",
                iconUrl: "icon-48.png",
                title: `YouTube Live: ${stream.title}`,
                message: "A subscribed channel just went live!"
            });
        }
    }

    // Save this poll’s channels for next comparison
    previousLiveChannels = currentLiveIds;
    console.log("[Alarm: Notification] Notification check complete.");
}


// --- Token Refresh Logic ---

async function refreshTwitchToken(clientId, clientSecret, refreshToken) {
    console.log("[Alarm: Token Refresh] Attempting to refresh Twitch token...");
    try {
        const response = await fetch("https://id.twitch.tv/oauth2/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: refreshToken,
                client_id: clientId,
                client_secret: clientSecret
            })
        });

        if (!response.ok) {
            console.error(`[Twitch] Token refresh failed with status ${response.status}: ${response.statusText}`);
            return null;
        }

        const data = await response.json();

        if (data.access_token) {
            console.log("[Twitch] Access token refreshed successfully.");
            
            // 1. Save new ACCESS TOKEN to COOKIE (NEW)
            await setAccessTokenCookie('https://api.twitch.tv/', 'twitch_access_token', data.access_token);

            // 2. Save new REFRESH TOKEN (only) to STORAGE.LOCAL (MODIFIED)
            await mergeSettings({
                twitch: {
                    refreshToken: data.refresh_token || refreshToken
                }
            });

            return data.access_token;
        } else {
            console.error("[Twitch] Failed to refresh token:", data);
            return null;
        }
    } catch (err) {
        console.error("[Twitch] Refresh token error:", err);
        return null;
    }
}

async function refreshKickToken(clientId, clientSecret, refreshToken) {
    if (!clientId || !clientSecret || !refreshToken) {
        console.warn("[Kick] Missing credentials for token refresh. Skipping.");
        return null;
    }
    
    // Debug logging for troubleshooting 401 errors
    console.log(`[Kick Token Refresh Debug] Preparing request to: ${KICK_TOKEN_URL}`);
    console.log(`[Kick Token Refresh Debug] Client ID (start): ${clientId.substring(0, 8)}...`);
    console.log(`[Kick Token Refresh Debug] Refresh Token (end): ...${refreshToken.substring(refreshToken.length - 8)}`);
    
    try {
        // Endpoint: https://id.kick.com/oauth/token (Correct)
        const response = await fetch(KICK_TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: refreshToken,
                client_id: clientId,
                client_secret: clientSecret
            })
        });

        // IMPORTANT: Check status before parsing JSON
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[Kick] Token refresh failed with status ${response.status}: ${errorText}`);
            return null;
        }

        const data = await response.json();

        if (data.access_token) {
            console.log("[Kick] Access token refreshed successfully.");
            
            // 1. Save new ACCESS TOKEN to COOKIE (NEW)
            await setAccessTokenCookie('https://kick.com/', 'kick_access_token', data.access_token);
            
            // 2. Save new REFRESH TOKEN (only) to STORAGE.LOCAL (MODIFIED)
            await mergeSettings({
                kick: {
                    refreshToken: data.refresh_token || refreshToken
                }
            });
            return data.access_token;
        } else {
            console.error("[Kick] Failed to refresh token (unexpected response structure):", data);
            return null;
        }
    } catch (err) {
        console.error("[Kick] Refresh token error:", err);
        return null;
    }
}

// --- ALARM INITIALIZATION LOGIC ---

async function initAlarms() {
    console.log("Checking and setting up periodic alarms.");
    
    // Check if the main poll alarm already exists
    const mainAlarm = await browser.alarms.get('streamtime-main-poll');

    if (!mainAlarm) {
        console.log("Alarms not found. Initializing and running first poll...");
        
        // Define Alarms
        browser.alarms.create('streamtime-main-poll', { periodInMinutes: POLL_INTERVAL_SECONDS / 60 });
        browser.alarms.create('streamtime-notification-check', { periodInMinutes: NOTIFICATION_CHECK_SECONDS / 60 });
        browser.alarms.create('twitch-token-refresh', { periodInMinutes: TWITCH_REFRESH_INTERVAL_SECONDS / 60 });
        browser.alarms.create('kick-token-refresh', { periodInMinutes: KICK_REFRESH_INTERVAL_SECONDS / 60 });
        
        // --- IMMEDIATE POLLS ---
        await pollAll();
        await checkLiveChannels();
        
        const settings = await loadSettings();

        // --- Twitch Token Refresh ---
        const twitchSettings = settings.twitch || {};
        if (twitchSettings.clientId && twitchSettings.clientSecret && twitchSettings.refreshToken) {
            // No need to check for accessToken existence, refreshTwitchToken will fetch the accessToken from cookie
            await refreshTwitchToken(twitchSettings.clientId, twitchSettings.clientSecret, twitchSettings.refreshToken);
        } else {
            console.warn("[Twitch] Missing credentials for initial token refresh.");
        }
        
        // --- Kick Token Refresh ---
        const kickSettings = settings.kick || {}; 
        if (kickSettings.clientId && kickSettings.clientSecret && kickSettings.refreshToken) {
            // No need to check for accessToken existence
            await refreshKickToken(kickSettings.clientId, kickSettings.clientSecret, kickSettings.refreshToken);
        } else {
            console.warn("[Kick] Missing credentials for initial token refresh.");
        }
    }
}

// --- ALARM EXECUTION LISTENER ---

browser.alarms.onAlarm.addListener(async (alarm) => {
    try {
        if (alarm.name === 'streamtime-main-poll') {
            await pollAll();
        } 
        else if (alarm.name === 'streamtime-notification-check') {
            await checkLiveChannels();
        }
        else if (alarm.name === 'twitch-token-refresh') {
            // Load credentials from storage/cookies for consistency
            const settings = await loadSettings();
            const twitchSettings = settings.twitch || {};
            await refreshTwitchToken(twitchSettings.clientId, twitchSettings.clientSecret, twitchSettings.refreshToken);
        }
        else if (alarm.name === 'kick-token-refresh') {
            // Load credentials from storage/cookies for consistency
            const settings = await loadSettings();
            const kickSettings = settings.kick || {};
            await refreshKickToken(kickSettings.clientId, kickSettings.clientSecret, kickSettings.refreshToken);
        }
    } catch (e) {
        console.error(`Error handling alarm ${alarm.name}:`, e);
    }
});


// --- Runtime Message Listener ---

browser.runtime.onMessage.addListener(async (msg) => {
    if (msg?.action === 'poll_now') {
        console.log('[StreamTime] Manual poll triggered from options.');
        await pollAll();
        return true;
    }
});

// --- EXECUTION ON SERVICE WORKER STARTUP ---

initAlarms().catch(console.error);