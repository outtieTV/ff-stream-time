// ------------------------------------------------------------
// popup.js – updated with safety checks
// ------------------------------------------------------------

// Clear the “Loading…” placeholders right away
function clearPlaceholders() {
  document.getElementById('twitch-list').innerHTML = '';
  document.getElementById('kick-list').innerHTML   = '';
  document.getElementById('youtube-list').innerHTML = '';
}
clearPlaceholders();

// ------------------------------------------------------------
// Main render – fetches stored data and populates the UI
// ------------------------------------------------------------
async function render() {
  try {
    const s = await browser.storage.local.get(['streamtime', 'streamtime_live']);
    const settings = s.streamtime || {};
    const live = s.streamtime_live || {};

    // ----------------------------------------------------------------
    // Helper to render a platform list (unchanged except for the name order)
    // ----------------------------------------------------------------
    function renderList(containerId, platformSettings, platformLive, platformName) {
      const el = document.getElementById(containerId);
      el.innerHTML = '';

      const liveList = platformLive || [];
      if (!liveList.length) {
        el.innerHTML = '<div class="empty">No channels live</div>';
        return;
      }

      for (const item of liveList) {
        const div = document.createElement('div');
        div.className = 'entry';

        // name – prefer channel name before title
        const name = item.display_name ||
                     item.channel_name ||
                     item.slug ||
                     item.name ||
                     (item.user_login || item.login) ||
                     item.title ||
                     item.channelId ||
                     'unknown';

        // URL construction
        let url = '#';
        if (platformName === 'twitch' && item.user_login) url = `https://twitch.tv/${item.user_login}`;
        else if (platformName === 'twitch' && item.user_name) url = `https://twitch.tv/${item.user_name}`;
        else if (platformName === 'kick' && (item.slug || item.link)) url = `https://kick.com/${item.slug || item.link}`;
        else if (platformName === 'youtube' && item.channelId) url = `https://www.youtube.com/channel/${item.channelId}`;
        else if (item.url) url = item.url;

        // left side (name + game / title)
        const left = document.createElement('div');
        left.innerHTML = `<a target="_blank" rel="noopener noreferrer" href="${url}">${escapeHtml(name)}</a>` +
                         `<div class="small muted">${escapeHtml(item.game || item.title || '')}</div>`;

        // right side (uptime / duration)
        const right = document.createElement('div');
        right.innerHTML = `<div class="small">${escapeHtml(item.uptime || item.duration || '')}</div>`;

        div.appendChild(left);
        div.appendChild(right);
        el.appendChild(div);
      }
    }

    // Populate each platform
    renderList('twitch-list',   settings.twitch,   live.twitch,   'twitch');
    renderList('kick-list',     settings.kick,     live.kick,     'kick');
    renderList('youtube-list',  settings.youtube,  live.youtube,  'youtube');

  } catch (e) {
    console.error('❌ render() failed:', e);
  }
}

// ------------------------------------------------------------
// Show the OAuth redirect URL (unchanged)
// ------------------------------------------------------------
async function displayRedirectURL() {
  const el = document.getElementById('redirect-url');
  try {
    const redirectURL = browser.identity.getRedirectURL();
    el.innerHTML = `<code>${escapeHtml(redirectURL)}</code>`;
  } catch (e) {
    console.error('Failed to get redirect URL:', e);
    el.innerHTML = `<code style="color:red;">Error getting URL. Check "identity" permission in manifest.</code>`;
  }
}

// ------------------------------------------------------------
// HTML‑escaping helper (unchanged)
// ------------------------------------------------------------
function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);
}

// ------------------------------------------------------------
// UI wiring – options buttons
// ------------------------------------------------------------
document.getElementById('open-options-twitch').addEventListener('click', () => {
  browser.runtime.openOptionsPage();
});
document.getElementById('open-options-kick').addEventListener('click', () => {
  browser.runtime.openOptionsPage();
});
document.getElementById('open-options-youtube').addEventListener('click', () => {
  browser.runtime.openOptionsPage();
});

// ------------------------------------------------------------
// Initial load – wait for render before showing the OAuth URL
// ------------------------------------------------------------
(async () => {
  await render();          // ensures the list is populated
  displayRedirectURL();    // then show the redirect URL
})();

// ------------------------------------------------------------
// Keep UI in sync when storage changes
// ------------------------------------------------------------
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    render();   // fire‑and‑forget; errors are caught inside render()
  }
});
