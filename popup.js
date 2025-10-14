// popup.js

async function render(){
  // get cached live lists from storage (background polls and sets them)
  const s = (await browser.storage.local.get(['streamtime','streamtime_live'])) || {};
  const settings = s.streamtime || {};
  const live = s.streamtime_live || {};

  // helper to render entries
  function renderList(containerId, platformSettings, platformLive, platformName){
    const el = document.getElementById(containerId);
    el.innerHTML = '';
    const liveList = platformLive || [];
    if(!liveList.length){
      el.innerHTML = '<div class="empty">No channels live</div>';
      return;
    }
    for(const item of liveList){
      const div = document.createElement('div');
      div.className = 'entry';
      // build link and uptime if available
      let name = item.display_name || item.title || item.channel_name || item.slug || item.name || (item.user_login || item.login) || item.channelId || 'unknown';
      let url = '#';
      if(platformName === 'twitch' && item.user_login) url = 'https://twitch.tv/' + item.user_login;
      else if(platformName === 'twitch' && item.user_name) url = 'https://twitch.tv/' + item.user_name;
      else if(platformName === 'kick' && (item.slug || item.link)) url = 'https://kick.com/' + (item.slug || item.link || '');
      else if(platformName === 'youtube' && item.channelId) url = 'https://www.youtube.com/channel/' + item.channelId;
      else if(item.url) url = item.url;

      const left = document.createElement('div');
      left.innerHTML = '<a target="_blank" rel="noopener noreferrer" href="' + url + '">' + escapeHtml(name) + '</a><div class="small muted">' + (item.game || item.title || '') + '</div>';

      const right = document.createElement('div');
      right.innerHTML = '<div class="small">' + (item.uptime || item.duration || '') + '</div>';
      div.appendChild(left);
      div.appendChild(right);
      el.appendChild(div);
    }
  }

  renderList('twitch-list', settings.twitch, live.twitch, 'twitch');
  renderList('kick-list', settings.kick, live.kick, 'kick');
  renderList('youtube-list', settings.youtube, live.youtube, 'youtube');
}

// NEW FUNCTION: Generate and display the Mozilla OAuth URL
async function displayRedirectURL() {
    const el = document.getElementById('redirect-url');
    try {
        // browser.identity.getRedirectURL() generates the unique hash URL
        const redirectURL = browser.identity.getRedirectURL();
        el.innerHTML = '<code>' + escapeHtml(redirectURL) + '</code>';
    } catch (e) {
        console.error("Failed to get redirect URL:", e);
        el.innerHTML = '<code style="color:red;">Error getting URL. Check "identity" permission in manifest.</code>';
    }
}

function escapeHtml(s){ return (s||'').replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]); }

document.getElementById('open-options-twitch').addEventListener('click', ()=>{
  browser.runtime.openOptionsPage();
});
document.getElementById('open-options-kick').addEventListener('click', ()=>{
  browser.runtime.openOptionsPage();
});
document.getElementById('open-options-youtube').addEventListener('click', ()=>{
  browser.runtime.openOptionsPage();
});

// Initial load functions
render();
displayRedirectURL(); // <-- NEW: Call the URL display function

// update when storage changes
browser.storage.onChanged.addListener((changes, area) => {
  if(area === 'local'){
    render();
  }
});