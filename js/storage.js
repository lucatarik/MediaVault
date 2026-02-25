/**
 * StorageManager - localStorage + Upstash Redis sync
 */
const StorageManager = (() => {
  const LOCAL_KEY = 'mediavault_posts';
  const SETTINGS_KEY = 'mediavault_settings';
  let syncTimeout = null;

  // ─── Settings ─────────────────────────────────────────────────────────────
  function getSettings() {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
    } catch { return {}; }
  }

  function saveSettings(settings) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  function hasRedis() {
    const s = getSettings();
    return s.redisUrl && s.redisToken;
  }

  // ─── Local Storage ────────────────────────────────────────────────────────
  function getLocal() {
    try {
      return JSON.parse(localStorage.getItem(LOCAL_KEY)) || [];
    } catch { return []; }
  }

  function saveLocal(posts) {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(posts));
  }

  // ─── Upstash Redis ────────────────────────────────────────────────────────
  async function redisGet(key) {
    const { redisUrl, redisToken } = getSettings();
    if (!redisUrl || !redisToken) return null;
    try {
      const res = await fetch(`${redisUrl}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${redisToken}` }
      });
      const data = await res.json();
      return data.result ? JSON.parse(data.result) : null;
    } catch (e) {
      console.warn('Redis GET error:', e);
      return null;
    }
  }

  async function redisSet(key, value) {
    const { redisUrl, redisToken } = getSettings();
    if (!redisUrl || !redisToken) return false;
    try {
      const res = await fetch(`${redisUrl}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${redisToken}` }
      });
      const data = await res.json();
      return data.result === 'OK';
    } catch (e) {
      console.warn('Redis SET error:', e);
      return false;
    }
  }

  // Throttled Redis sync - wait 2s after last change
  function schedulRedisSync(posts) {
    if (!hasRedis()) return;
    clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => {
      redisSet('mediavault:posts', posts).then(ok => {
        if (ok) showSyncIndicator('synced');
        else showSyncIndicator('error');
      });
    }, 2000);
  }

  function showSyncIndicator(status) {
    const el = document.getElementById('sync-indicator');
    if (!el) return;
    el.className = `sync-indicator ${status}`;
    el.title = status === 'synced' ? 'Sincronizzato con Redis' : 'Errore sincronizzazione';
    setTimeout(() => { el.className = 'sync-indicator'; }, 3000);
  }

  // ─── Public API ───────────────────────────────────────────────────────────
  async function init() {
    // Try to load from Redis on startup
    if (hasRedis()) {
      showSyncIndicator('syncing');
      const remote = await redisGet('mediavault:posts');
      if (remote && Array.isArray(remote) && remote.length > 0) {
        const local = getLocal();
        // Merge: prefer remote if newer/more records, else merge unique
        const merged = mergePostArrays(local, remote);
        saveLocal(merged);
        showSyncIndicator('synced');
        return merged;
      }
    }
    return getLocal();
  }

  function mergePostArrays(local, remote) {
    const map = new Map();
    [...local, ...remote].forEach(p => {
      const existing = map.get(p.id);
      if (!existing || (p.updatedAt || 0) > (existing.updatedAt || 0)) {
        map.set(p.id, p);
      }
    });
    return Array.from(map.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  async function getAll() {
    return getLocal();
  }

  async function save(post) {
    const posts = getLocal();
    const idx = posts.findIndex(p => p.id === post.id);
    if (idx >= 0) posts[idx] = { ...posts[idx], ...post, updatedAt: Date.now() };
    else posts.unshift({ ...post, createdAt: post.createdAt || Date.now(), updatedAt: Date.now() });
    saveLocal(posts);
    schedulRedisSync(posts);
    return post;
  }

  async function remove(id) {
    const posts = getLocal().filter(p => p.id !== id);
    saveLocal(posts);
    schedulRedisSync(posts);
  }

  async function toggleFavorite(id) {
    const posts = getLocal();
    const post = posts.find(p => p.id === id);
    if (post) {
      post.favorite = !post.favorite;
      post.updatedAt = Date.now();
      saveLocal(posts);
      schedulRedisSync(posts);
      return post.favorite;
    }
    return false;
  }

  // ─── Import / Export ──────────────────────────────────────────────────────
  function exportDB() {
    const posts = getLocal();
    const settings = getSettings();
    const blob = new Blob([JSON.stringify({ posts, exportedAt: new Date().toISOString(), version: '1.0' }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mediavault-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importDB(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const data = JSON.parse(e.target.result);
          let posts = [];
          if (Array.isArray(data)) posts = data;
          else if (data.posts && Array.isArray(data.posts)) posts = data.posts;
          else throw new Error('Formato non valido');
          
          // Validate basic structure
          posts = posts.filter(p => p.id && p.url);
          
          // Merge with existing
          const existing = getLocal();
          const merged = mergePostArrays(existing, posts);
          saveLocal(merged);
          schedulRedisSync(merged);
          resolve({ count: posts.length, total: merged.length });
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(new Error('Errore lettura file'));
      reader.readAsText(file);
    });
  }

  async function clearAll() {
    saveLocal([]);
    if (hasRedis()) await redisSet('mediavault:posts', []);
  }

  async function syncToRedis() {
    const posts = getLocal();
    const ok = await redisSet('mediavault:posts', posts);
    return ok;
  }

  async function syncFromRedis() {
    const remote = await redisGet('mediavault:posts');
    if (remote && Array.isArray(remote)) {
      const local = getLocal();
      const merged = mergePostArrays(local, remote);
      saveLocal(merged);
      return merged;
    }
    return null;
  }

  return { init, getAll, save, remove, toggleFavorite, exportDB, importDB, clearAll, getSettings, saveSettings, hasRedis, syncToRedis, syncFromRedis };
})();
