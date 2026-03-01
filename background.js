// background.js
// Periodically polls platforms for live channels and writes short "live" lists to browser.storage.local.streamtime_live

// --- Configuration Constants ---
const POLL_INTERVAL_SECONDS = 60; 
const NOTIFICATION_CHECK_SECONDS = 5 * 60; 
const TWITCH_REFRESH_INTERVAL_SECONDS = 3.5 * 60 * 60; 
const KICK_REFRESH_INTERVAL_SECONDS = 3.5 * 60 * 60; 

const KICK_TOKEN_URL = "https://id.kick.com/oauth/token"; 

// --- Internet Connectivity Utilities (NEW) ---

/**
 * Attempts to "ping" Google via a lightweight fetch request.
 * Useful for VPN users with killswitches to ensure the tunnel is up.
 */
async function isOnline() {
    try {
        // Use method: 'HEAD' to keep the request tiny (headers only)
        // cache: 'no-store' ensures we aren't getting a local cached result
        await fetch("https://www.google.com", { 
            method: 'HEAD', 
            mode: 'no-cors', 
            cache: 'no-store' 
        });
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Waits for an internet connection before proceeding.
 * @param {number} maxRetries - How many times to try before giving up for this cycle.
 * @param {number} delayMs - Delay between retries.
 */
async function ensureConnection(maxRetries = 10, delayMs = 5000) {
    for (let i = 0; i < maxRetries; i++) {
        if (await isOnline()) {
            if (i > 0) console.log("[Connection] Internet restored.");
            return true;
        }
        console.warn(`[Connection] Internet unreachable (VPN Killswitch?). Retry ${i + 1}/${maxRetries} in ${delayMs/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    return false;
}

// --- Cookie Helper Functions ---

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

// --- Global Utilities ---

async function loadSettings(){
    const st = (await browser.storage.local.get('streamtime'))?.streamtime || {};
    st.twitch = st.twitch || {};
    st.twitch.accessToken = await getAccessTokenCookie('https://api.twitch.tv/', 'twitch_access_token');
    st.kick = st.kick || {};
    st.kick.accessToken = await getAccessTokenCookie('https://kick.com/', 'kick_access_token');
    return st;
}

function nowIso(){ return new Date().toISOString(); }

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

        if(res.status === 401 || res.status === 403) {
            console.warn('[Twitch] Access token expired, refreshing...');
            const newToken = await refreshTwitchToken(
                twitchSettings.clientId,
                twitchSettings.clientSecret,
                twitchSettings.refreshToken
            );
            if (newToken) {
                twitchSettings.accessToken = newToken; 
                return await checkTwitch(twitchSettings);
            }
            return [];
        }

        if(!res.ok) return [];
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
        return [];
    }
}


async function checkKick(kickSettings) {
    if (!kickSettings || !kickSettings.channels) return [];
    const ids = kickSettings.channels.map(c => c.id || c.broadcaster_user_id).filter(Boolean);
    if (!ids.length) return [];

    const url = new URL("https://api.kick.com/public/v1/channels");
    ids.forEach(id => url.searchParams.append("broadcaster_user_id", id));

    const headers = { "Accept": "application/json" };
    if (kickSettings.accessToken) headers.Authorization = 'Bearer ' + kickSettings.accessToken;

    try {
        const res = await fetch(url, { headers });
        if (res.status === 401 || res.status === 403) {
            const newToken = await refreshKickToken(
                kickSettings.clientId,
                kickSettings.clientSecret,
                kickSettings.refreshToken
            );
            if (newToken) {
                kickSettings.accessToken = newToken;
                return await checkKick(kickSettings);
            }
            return [];
        }
        if (!res.ok) return [];
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
        return [];
    }
}


async function checkYouTube(ytSettings){
    if(!ytSettings || !ytSettings.channels || !ytSettings.clientId) return [];
    const apiKey = ytSettings.clientId;
    const out = [];
    for(const ch of ytSettings.channels){
        const channelId = ch.id || ch.channelId || ch;
        if(!channelId) continue;
        try{
            const url = 'https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=' + encodeURIComponent(channelId) + '&type=video&eventType=live&key=' + encodeURIComponent(apiKey);
            const r = await fetch(url);
            if(!r.ok) continue;
            const j = await r.json();
            if(j.items && j.items.length){
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
    const settings = await loadSettings(); 
    const live = { twitch: [], kick: [], youtube: [] };

    try{ live.twitch = await checkTwitch(settings.twitch || {}); }catch(e){ console.error(e); }
    try{ live.kick = await checkKick(settings.kick || {}); }catch(e){ console.error(e); }
    try{ live.youtube = await checkYouTube(settings.youtube || {}); }catch(e){ console.error(e); }

    await browser.storage.local.set({ streamtime_live: live });
    await browser.storage.local.set({ streamtime_last_poll: nowIso() });
    console.log("[Alarm: Main Poll] Poll complete.");
}

// --- Notification Logic ---

let previousLiveChannels = new Set();

async function checkLiveChannels() {
    const data = await browser.storage.local.get();
    const liveData = data.streamtime_live || {};

    const currentLiveIds = new Set([
        ...(liveData.twitch || []).map(s => `twitch-${s.user_id}`),
        ...(liveData.kick || []).map(s => `kick-${s.id}`),
        ...(liveData.youtube || []).map(s => `yt-${s.channelId}`)
    ]);

    for (const stream of liveData.twitch || []) {
        const id = `twitch-${stream.user_id}`;
        if (!previousLiveChannels.has(id)) {
            browser.notifications.create(id, {
                type: "basic", iconUrl: "icon-48.png",
                title: `${stream.display_name} is live on Twitch!`,
                message: stream.title
            });
        }
    }

    for (const stream of liveData.kick || []) {
        const id = `kick-${stream.id}`;
        if (!previousLiveChannels.has(id)) {
            browser.notifications.create(id, {
                type: "basic", iconUrl: "icon-48.png",
                title: `${stream.slug} is live on Kick!`,
                message: stream.title
            });
        }
    }

    previousLiveChannels = currentLiveIds;
}


// --- Token Refresh Logic ---

async function refreshTwitchToken(clientId, clientSecret, refreshToken) {
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

        if (!response.ok) return null;
        const data = await response.json();

        if (data.access_token) {
            await setAccessTokenCookie('https://api.twitch.tv/', 'twitch_access_token', data.access_token);
            await mergeSettings({ twitch: { refreshToken: data.refresh_token || refreshToken } });
            return data.access_token;
        }
        return null;
    } catch (err) {
        return null;
    }
}

async function refreshKickToken(clientId, clientSecret, refreshToken) {
    if (!clientId || !clientSecret || !refreshToken) return null;
    try {
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

        if (!response.ok) return null;
        const data = await response.json();

        if (data.access_token) {
            await setAccessTokenCookie('https://kick.com/', 'kick_access_token', data.access_token);
            await mergeSettings({ kick: { refreshToken: data.refresh_token || refreshToken } });
            return data.access_token;
        }
        return null;
    } catch (err) {
        return null;
    }
}

// --- ALARM INITIALIZATION LOGIC ---

async function initAlarms() {
    const mainAlarm = await browser.alarms.get('streamtime-main-poll');

    if (!mainAlarm) {
        browser.alarms.create('streamtime-main-poll', { periodInMinutes: POLL_INTERVAL_SECONDS / 60 });
        browser.alarms.create('streamtime-notification-check', { periodInMinutes: NOTIFICATION_CHECK_SECONDS / 60 });
        browser.alarms.create('twitch-token-refresh', { periodInMinutes: TWITCH_REFRESH_INTERVAL_SECONDS / 60 });
        browser.alarms.create('kick-token-refresh', { periodInMinutes: KICK_REFRESH_INTERVAL_SECONDS / 60 });
        
        // Wait for connection before initial data fetch
        const connected = await ensureConnection(5, 3000);
        if (!connected) return;

        await pollAll();
        await checkLiveChannels();
        
        const settings = await loadSettings();
        const twitchSettings = settings.twitch || {};
        if (twitchSettings.clientId && twitchSettings.clientSecret && twitchSettings.refreshToken) {
            await refreshTwitchToken(twitchSettings.clientId, twitchSettings.clientSecret, twitchSettings.refreshToken);
        }
        
        const kickSettings = settings.kick || {}; 
        if (kickSettings.clientId && kickSettings.clientSecret && kickSettings.refreshToken) {
            await refreshKickToken(kickSettings.clientId, kickSettings.clientSecret, kickSettings.refreshToken);
        }
    }
}

// --- ALARM EXECUTION LISTENER ---

browser.alarms.onAlarm.addListener(async (alarm) => {
    try {
        // For any network-based alarm, wait for the VPN/Internet to be active
        const connected = await ensureConnection(12, 5000); // Try for 1 minute total
        if (!connected) {
            console.error(`[Alarm] ${alarm.name} aborted: No internet connection.`);
            return;
        }

        if (alarm.name === 'streamtime-main-poll') {
            await pollAll();
        } 
        else if (alarm.name === 'streamtime-notification-check') {
            await checkLiveChannels();
        }
        else if (alarm.name === 'twitch-token-refresh') {
            const settings = await loadSettings();
            const twitchSettings = settings.twitch || {};
            await refreshTwitchToken(twitchSettings.clientId, twitchSettings.clientSecret, twitchSettings.refreshToken);
        }
        else if (alarm.name === 'kick-token-refresh') {
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
        if (await ensureConnection(2, 2000)) {
            await pollAll();
        }
        return true;
    }
});

// --- EXECUTION ON SERVICE WORKER STARTUP ---

initAlarms().catch(console.error);
