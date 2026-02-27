/**
 * storage.js — Persistenza locale (localStorage) + sync Upstash Redis
 * File: js/storage.js
 *
 * FLUSSO:
 *   init()           → carica da Redis (se configurato), merge con locale
 *   save(post)       → salva in localStorage → schedula sync Redis (2s debounce)
 *   remove(id)       → rimuove da localStorage → schedula sync Redis
 *   toggleFavorite() → toggle favorite → salva
 *
 * Settings memorizzate in localStorage['mediavault_settings']:
 *   redisUrl, redisToken, useAlloriginsFallback (flag proxy)
 */

const StorageManager = (() => {
  const FILE = 'storage.js';
  const L  = (fn, msg, d) => MV.log(FILE, fn, msg, d);
  const W  = (fn, msg, d) => MV.warn(FILE, fn, msg, d);
  const E  = (fn, msg, d) => MV.error(FILE, fn, msg, d);

  const LOCAL_KEY    = 'mediavault_posts';
  const SETTINGS_KEY = 'mediavault_settings';
  let syncTimeout = null;

  // ─── Settings ──────────────────────────────────────────────────────────────
  function getSettings() {
    const FN = 'getSettings';
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      const s = raw ? JSON.parse(raw) : {};
      L(FN, `Lette impostazioni:`, { redisUrl: s.redisUrl ? '(set)' : '(vuoto)', redisToken: s.redisToken ? '(set)' : '(vuoto)', useAlloriginsFallback: s.useAlloriginsFallback });
      return s;
    } catch (e) {
      W(FN, `JSON.parse fallito: ${e.message} → {}` );
      return {};
    }
  }

  function saveSettings(settings) {
    const FN = 'saveSettings';
    L(FN, `Salvo impostazioni:`, { redisUrl: settings.redisUrl ? '(set)' : '(vuoto)', useAlloriginsFallback: settings.useAlloriginsFallback });
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    L(FN, `✓ Settings salvate in localStorage["${SETTINGS_KEY}"]`);
  }

  function hasRedis() {
    const s = getSettings();
    const ok = !!(s.redisUrl && s.redisToken);
    MV.log(FILE, 'hasRedis', `→ ${ok} (redisUrl=${!!s.redisUrl} redisToken=${!!s.redisToken})`);
    return ok;
  }

  // ─── localStorage ─────────────────────────────────────────────────────────
  function getLocal() {
    const FN = 'getLocal';
    try {
      const raw = localStorage.getItem(LOCAL_KEY);
      const posts = raw ? JSON.parse(raw) : [];
      L(FN, `Letti ${posts.length} post da localStorage["${LOCAL_KEY}"]`);
      return posts;
    } catch (e) {
      W(FN, `JSON.parse fallito: ${e.message} → []`);
      return [];
    }
  }

  function saveLocal(posts) {
    const FN = 'saveLocal';
    L(FN, `Salvo ${posts.length} post in localStorage["${LOCAL_KEY}"]`);
    localStorage.setItem(LOCAL_KEY, JSON.stringify(posts));
    L(FN, `✓ Saved (${JSON.stringify(posts).length} bytes)`);
  }

  // ─── Upstash Redis ─────────────────────────────────────────────────────────
  async function redisGet(key) {
    const FN = 'redisGet';
    const { redisUrl, redisToken } = getSettings();
    if (!redisUrl || !redisToken) { W(FN, 'Redis non configurato → skip'); return null; }
    const endpoint = `${redisUrl}/get/${encodeURIComponent(key)}`;
    L(FN, `GET ${endpoint}`);
    try {
      const res = await fetch(endpoint, { headers: { Authorization: `Bearer ${redisToken}` } });
      L(FN, `HTTP ${res.status}`);
      if (!res.ok) { W(FN, `HTTP ${res.status}`); return null; }
      const data = await res.json();
      L(FN, `result type=${typeof data.result} hasValue=${!!data.result}`);
      return data.result ? JSON.parse(data.result) : null;
    } catch (e) {
      W(FN, `Eccezione: ${e.message}`);
      return null;
    }
  }

  async function redisSet(key, value) {
    const FN = 'redisSet';
    const { redisUrl, redisToken } = getSettings();
    if (!redisUrl || !redisToken) { W(FN, 'Redis non configurato → skip'); return false; }
    const endpoint = `${redisUrl}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}`;
    L(FN, `SET key="${key}" value=[${Array.isArray(value) ? value.length + ' items' : typeof value}]`);
    L(FN, `Endpoint: ${endpoint.slice(0,80)}…`);
    try {
      const res = await fetch(endpoint, {
        method: 'GET',
        headers: { Authorization: `Bearer ${redisToken}` }
      });
      L(FN, `HTTP ${res.status}`);
      const data = await res.json();
      const ok = data.result === 'OK';
      if (ok) L(FN, `✓ Redis SET OK`);
      else    W(FN, `Redis SET result="${data.result}" (atteso "OK")`);
      return ok;
    } catch (e) {
      W(FN, `Eccezione: ${e.message}`);
      return false;
    }
  }

  function scheduleRedisSync(posts) {
    const FN = 'scheduleRedisSync';
    if (!hasRedis()) { L(FN,'Redis non configurato → nessun sync'); return; }
    clearTimeout(syncTimeout);
    L(FN, `Schedulo sync Redis tra 2s (debounce — evita troppe scritture consecutive)`);
    syncTimeout = setTimeout(async () => {
      L(FN, `Sync Redis: scrivo ${posts.length} post…`);
      const ok = await redisSet('mediavault:posts', posts);
      showSyncIndicator(ok ? 'synced' : 'error');
      L(FN, ok ? `✓ Sync Redis OK` : `✗ Sync Redis fallito`);
    }, 2000);
  }

  function showSyncIndicator(status) {
    const el = document.getElementById('sync-indicator');
    if (!el) return;
    el.className = `sync-indicator ${status}`;
    el.title = status === 'synced' ? 'Sincronizzato con Redis' : 'Errore sincronizzazione';
    setTimeout(() => { el.className = 'sync-indicator'; }, 3000);
  }

  // ─── Public API ────────────────────────────────────────────────────────────
  async function init() {
    const FN = 'init';
    MV.section('[storage.js] INIZIALIZZAZIONE');
    L(FN, `LOGICA: se Redis configurato → carica da Redis → merge con locale → restituisce merged`);
    L(FN, `Altrimenti → restituisce solo localStorage`);

    if (hasRedis()) {
      L(FN, `Redis configurato → carico dati remoti…`);
      showSyncIndicator('syncing');
      const remote = await redisGet('mediavault:posts');
      L(FN, `Dati Redis: ${remote ? remote.length + ' post' : 'null/vuoto'}`);
      if (remote && Array.isArray(remote) && remote.length > 0) {
        const local = getLocal();
        L(FN, `Merge: ${local.length} locali + ${remote.length} remoti`);
        const merged = mergePostArrays(local, remote);
        L(FN, `Merge OK → ${merged.length} post totali`);
        saveLocal(merged);
        showSyncIndicator('synced');
        MV.groupEnd();
        return merged;
      }
      W(FN, `Redis vuoto o null → uso solo localStorage`);
    } else {
      L(FN, `Redis non configurato → uso solo localStorage`);
    }

    const local = getLocal();
    L(FN, `✓ Init completata → ${local.length} post`);
    MV.groupEnd();
    return local;
  }

  function mergePostArrays(local, remote) {
    const FN = 'mergePostArrays';
    L(FN, `Merge ${local.length} locali + ${remote.length} remoti`);
    L(FN, `LOGICA: per ogni post, vince il più recente (updatedAt maggiore)`);
    const map = new Map();
    [...local, ...remote].forEach(p => {
      const existing = map.get(p.id);
      if (!existing || (p.updatedAt || 0) > (existing.updatedAt || 0)) {
        if (existing) L(FN, `  Override: id="${p.id}" (remote ${p.updatedAt} > local ${existing.updatedAt})`);
        map.set(p.id, p);
      }
    });
    const result = Array.from(map.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    L(FN, `✓ Merge risultato: ${result.length} post unici`);
    return result;
  }

  async function getAll() {
    const FN = 'getAll';
    const posts = getLocal();
    L(FN, `→ ${posts.length} post`);
    return posts;
  }

  async function save(post) {
    const FN = 'save';
    L(FN, `Salvo post id="${post.id}" platform="${post.platform}" title="${(post.title||'').slice(0,40)}"`);
    const posts = getLocal();
    const idx = posts.findIndex(p => p.id === post.id);

    if (idx >= 0) {
      L(FN, `Post esistente (idx=${idx}) → update`);
      posts[idx] = { ...posts[idx], ...post, updatedAt: Date.now() };
    } else {
      L(FN, `Nuovo post → unshift in cima alla lista`);
      posts.unshift({ ...post, createdAt: post.createdAt || Date.now(), updatedAt: Date.now() });
    }

    saveLocal(posts);
    scheduleRedisSync(posts);
    L(FN, `✓ Post salvato — totale: ${posts.length} post in localStorage`);
    return post;
  }

  async function remove(id) {
    const FN = 'remove';
    L(FN, `Rimuovo post id="${id}"`);
    const before = getLocal();
    const posts = before.filter(p => p.id !== id);
    L(FN, `Prima: ${before.length} post → Dopo: ${posts.length} post (rimossi: ${before.length - posts.length})`);
    saveLocal(posts);
    scheduleRedisSync(posts);
    L(FN, `✓ Rimozione completata`);
  }

  async function toggleFavorite(id) {
    const FN = 'toggleFavorite';
    L(FN, `Toggle favorite per post id="${id}"`);
    const posts = getLocal();
    const post = posts.find(p => p.id === id);
    if (post) {
      const oldVal = post.favorite;
      post.favorite = !post.favorite;
      post.updatedAt = Date.now();
      L(FN, `✓ favorite: ${oldVal} → ${post.favorite}`);
      saveLocal(posts);
      scheduleRedisSync(posts);
      return post.favorite;
    }
    W(FN, `Post id="${id}" non trovato`);
    return false;
  }

  // ─── Import / Export ───────────────────────────────────────────────────────
  function exportDB() {
    const FN = 'exportDB';
    const posts    = getLocal();
    const settings = getSettings();
    L(FN, `Export di ${posts.length} post + settings`);
    const blob = new Blob([JSON.stringify({ posts, exportedAt: new Date().toISOString(), version: '1.0' }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mediavault-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    L(FN, `✓ Download avviato`);
  }

  async function importDB(file) {
    const FN = 'importDB';
    L(FN, `Import da file: "${file.name}" (${file.size} bytes)`);
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const data = JSON.parse(e.target.result);
          L(FN, `JSON parsato. Keys: ${Object.keys(data).join(', ')}`);
          let posts = [];
          if (Array.isArray(data))                         posts = data;
          else if (data.posts && Array.isArray(data.posts)) posts = data.posts;
          else throw new Error('Formato non valido — atteso array o {posts:[]}');
          posts = posts.filter(p => p.id && p.url);
          L(FN, `Post validi da import: ${posts.length}`);
          const existing = getLocal();
          const merged = mergePostArrays(existing, posts);
          saveLocal(merged);
          scheduleRedisSync(merged);
          L(FN, `✓ Import OK — ${posts.length} importati, ${merged.length} totali dopo merge`);
          resolve({ count: posts.length, total: merged.length });
        } catch (err) {
          E(FN, `Import fallito: ${err.message}`);
          reject(err);
        }
      };
      reader.onerror = () => { E(FN,'FileReader error'); reject(new Error('Errore lettura file')); };
      reader.readAsText(file);
    });
  }

  async function clearAll() {
    const FN = 'clearAll';
    W(FN, `ELIMINO TUTTI I DATI (localStorage + Redis se configurato)`);
    saveLocal([]);
    if (hasRedis()) {
      const ok = await redisSet('mediavault:posts', []);
      L(FN, ok ? '✓ Redis svuotato' : '✗ Redis svuotamento fallito');
    }
    L(FN, `✓ clearAll completato`);
  }

  async function syncToRedis() {
    const FN = 'syncToRedis';
    const posts = getLocal();
    L(FN, `Sync ${posts.length} post → Redis…`);
    const ok = await redisSet('mediavault:posts', posts);
    L(FN, ok ? '✓ Sync OK' : '✗ Sync fallito');
    return ok;
  }

  async function syncFromRedis() {
    const FN = 'syncFromRedis';
    L(FN, `Fetch da Redis…`);
    const remote = await redisGet('mediavault:posts');
    L(FN, `Remote: ${remote ? remote.length + ' post' : 'null'}`);
    if (remote && Array.isArray(remote)) {
      const local = getLocal();
      const merged = mergePostArrays(local, remote);
      saveLocal(merged);
      L(FN, `✓ syncFromRedis OK — ${merged.length} post dopo merge`);
      return merged;
    }
    W(FN, 'Redis vuoto o nessun dato');
    return null;
  }

  L('init', '✓ StorageManager pronto');
  return {
    init, getAll, save, remove, toggleFavorite,
    exportDB, importDB, clearAll,
    getSettings, saveSettings, hasRedis,
    syncToRedis, syncFromRedis,
  };
})();
