/**
 * MediaVault App — Main Application Logic
 */

// ─── State ────────────────────────────────────────────────────────────────────
const State = {
  posts: [],
  currentPage: 'all',
  filter: { platform: null, category: null },
  search: '',
  viewMode: 'grid', // 'grid' | 'list'
  editPost: null,   // post being edited
};

// ─── Utility ──────────────────────────────────────────────────────────────────
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'ora';
  if (m < 60) return `${m}m fa`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h fa`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}g fa`;
  const mo = Math.floor(d / 30);
  return `${mo}me fa`;
}

function showToast(msg, type = 'info', duration = 3000) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icon = type === 'success' ? '✓' : type === 'error' ? '✗' : 'ℹ';
  toast.innerHTML = `<span>${icon}</span> ${msg}`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'toastOut 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

function getPlatformLabel(platform) {
  const labels = {
    youtube: 'YouTube', instagram: 'Instagram', 'instagram-profile': 'Instagram',
    facebook: 'Facebook', twitter: 'X / Twitter', tiktok: 'TikTok',
    vimeo: 'Vimeo', reddit: 'Reddit', twitch: 'Twitch', pinterest: 'Pinterest',
    linkedin: 'LinkedIn', spotify: 'Spotify', image: 'Immagine', video: 'Video', web: 'Web'
  };
  return labels[platform] || platform;
}

function platformDotStyle(color) {
  return `background:${color}`;
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  // Register SW
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./sw.js');
    } catch (e) { console.warn('SW registration failed:', e); }
  }

  // Load data
  State.posts = await StorageManager.init();
  
  // Render everything
  renderSidebar();
  renderNavBadges();
  renderPage();

  // Wire up events
  setupEvents();

  // Check for ?action=add (PWA shortcut)
  if (new URLSearchParams(location.search).get('action') === 'add') {
    openAddModal();
  }

  // Update stats badge
  renderStats();
}

// ─── Render ───────────────────────────────────────────────────────────────────
function renderSidebar() {
  const categories = Categorizer.getCategoryList();
  
  // Count per platform
  const platformCounts = {};
  const catCounts = {};
  State.posts.forEach(p => {
    platformCounts[p.platform] = (platformCounts[p.platform] || 0) + 1;
    (p.categories || []).forEach(c => { catCounts[c] = (catCounts[c] || 0) + 1; });
  });

  // Platform nav
  const platforms = ['youtube', 'instagram', 'facebook', 'twitter', 'tiktok', 'vimeo'];
  const platformColors = { youtube: '#FF0000', instagram: '#E1306C', facebook: '#1877F2', twitter: '#1DA1F2', tiktok: '#000000', vimeo: '#1AB7EA' };
  const platformIcons = { youtube: 'fab fa-youtube', instagram: 'fab fa-instagram', facebook: 'fab fa-facebook', twitter: 'fab fa-twitter', tiktok: 'fab fa-tiktok', vimeo: 'fab fa-vimeo' };

  let platformHtml = '';
  platforms.forEach(platform => {
    const count = platformCounts[platform] || 0;
    if (count > 0 || true) {
      platformHtml += `
        <div class="nav-item ${State.filter.platform === platform ? 'active' : ''}" onclick="setFilter('platform','${platform}')">
          <span class="platform-dot" style="${platformDotStyle(platformColors[platform])}"></span>
          ${getPlatformLabel(platform)}
          ${count > 0 ? `<span class="badge">${count}</span>` : ''}
        </div>
      `;
    }
  });

  // Category nav
  let catHtml = '';
  categories.forEach(cat => {
    const count = catCounts[cat.id] || 0;
    if (count > 0) {
      catHtml += `
        <div class="nav-item ${State.filter.category === cat.id ? 'active' : ''}" onclick="setFilter('category','${cat.id}')">
          <span style="font-size:0.85rem">${cat.icon}</span>
          ${cat.label}
          <span class="badge">${count}</span>
        </div>
      `;
    }
  });

  document.getElementById('sidebar-platforms').innerHTML = platformHtml;
  document.getElementById('sidebar-categories').innerHTML = catHtml || '<div style="padding:6px 20px;font-size:0.78rem;color:var(--text-400)">Nessuna categoria</div>';
}

function renderNavBadges() {
  const favCount = State.posts.filter(p => p.favorite).length;
  document.getElementById('badge-all').textContent = State.posts.length;
  document.getElementById('badge-favs').textContent = favCount;
}

function renderStats() {
  const posts = State.posts;
  document.getElementById('stat-total').textContent = posts.length;
  document.getElementById('stat-favs').textContent = posts.filter(p => p.favorite).length;
  document.getElementById('stat-videos').textContent = posts.filter(p => p.mediaType === 'video').length;
  document.getElementById('stat-images').textContent = posts.filter(p => p.mediaType === 'image' || p.mediaType === 'post').length;
}

function getFilteredPosts() {
  let posts = State.posts;

  if (State.currentPage === 'favorites') {
    posts = posts.filter(p => p.favorite);
  }

  if (State.filter.platform) {
    posts = posts.filter(p => p.platform === State.filter.platform || p.platform === State.filter.platform + '-profile');
  }
  if (State.filter.category) {
    posts = posts.filter(p => (p.categories || []).includes(State.filter.category));
  }
  if (State.search) {
    const q = State.search.toLowerCase();
    posts = posts.filter(p =>
      (p.title || '').toLowerCase().includes(q) ||
      (p.description || '').toLowerCase().includes(q) ||
      (p.url || '').toLowerCase().includes(q) ||
      (p.hashtags || []).some(h => h.includes(q)) ||
      (p.categories || []).some(c => c.includes(q))
    );
  }

  return posts;
}

function renderPage() {
  const posts = getFilteredPosts();
  const grid = document.getElementById('cards-grid');
  
  // Update section title
  let title = 'Tutti';
  if (State.currentPage === 'favorites') title = '⭐ Preferiti';
  else if (State.filter.platform) title = getPlatformLabel(State.filter.platform);
  else if (State.filter.category) {
    const cat = Categorizer.getCategoryInfo(State.filter.category);
    title = cat.icon + ' ' + cat.label;
  }
  document.getElementById('section-title').textContent = title;
  document.getElementById('section-count').textContent = `${posts.length} elementi`;

  if (posts.length === 0) {
    const isFiltered = State.filter.platform || State.filter.category || State.search;
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">${State.currentPage === 'favorites' ? '⭐' : '📦'}</div>
        <h3>${isFiltered ? 'Nessun risultato' : 'Niente ancora'}</h3>
        <p>${isFiltered ? 'Prova con altri filtri o termini di ricerca.' : 'Aggiungi il tuo primo link, foto o video!'}</p>
        ${!isFiltered ? `<button class="btn-primary" onclick="openAddModal()"><i class="fas fa-plus"></i> Aggiungi</button>` : ''}
      </div>
    `;
    return;
  }

  grid.innerHTML = posts.map(renderCard).join('');
}

function renderCard(post) {
  const platform = post.platform || 'web';
  const color = post.color || '#64748B';
  const icon = post.icon || 'fas fa-globe';
  const isFav = post.favorite;
  const categories = (post.categories || []).slice(0, 2);
  const hashtags = (post.hashtags || []).slice(0, 3);
  const mediaType = post.mediaType || 'link';

  let thumbHtml = '';
  if (post.thumbnail) {
    thumbHtml = `<img src="${post.thumbnail}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
                 <div class="thumb-placeholder" style="display:none">${getMediaIcon(mediaType)}</div>`;
  } else {
    thumbHtml = `<div class="thumb-placeholder">${getMediaIcon(mediaType)}</div>`;
  }

  const hasEmbed = !!post.embedUrl;
  const isVideo = mediaType === 'video' || mediaType === 'audio';

  return `
    <div class="media-card" data-id="${post.id}">
      <div class="card-thumb" onclick="openViewer('${post.id}')">
        ${thumbHtml}
        <div class="platform-overlay" style="background:${hexToRgba(color, 0.85)};color:#fff">
          <i class="${icon}"></i>
          ${getPlatformLabel(platform)}
        </div>
        ${isVideo || hasEmbed ? `<div class="play-btn"><i class="fas fa-play"></i></div>` : ''}
        ${isFav ? `<div class="fav-badge"><i class="fas fa-star"></i></div>` : ''}
      </div>
      <div class="card-body">
        <div class="card-title">${escHtml(post.title || extractDomain(post.url))}</div>
        ${post.description ? `<div class="card-desc">${escHtml(post.description)}</div>` : ''}
        <div class="card-categories">
          ${categories.map(c => {
            const ci = Categorizer.getCategoryInfo(c);
            return `<span class="cat-badge" style="color:${ci.color};background:${hexToRgba(ci.color,0.1)}">${ci.icon} ${ci.label}</span>`;
          }).join('')}
          ${hashtags.map(h => `<span class="hashtag">#${h}</span>`).join('')}
        </div>
      </div>
      <div class="card-footer">
        <span class="card-date">${timeAgo(post.createdAt)}</span>
        <button class="card-action ${isFav ? 'active-fav' : ''}" onclick="toggleFavorite('${post.id}')" title="Preferiti">
          <i class="${isFav ? 'fas' : 'far'} fa-star"></i>
        </button>
        <a class="card-action" href="${post.url}" target="_blank" rel="noopener" title="Apri originale">
          <i class="fas fa-external-link-alt"></i>
        </a>
        <button class="card-action" onclick="editPost('${post.id}')" title="Modifica">
          <i class="fas fa-pen"></i>
        </button>
        <button class="card-action delete" onclick="deletePost('${post.id}')" title="Elimina">
          <i class="fas fa-trash"></i>
        </button>
      </div>
    </div>
  `;
}

function getMediaIcon(mediaType) {
  const icons = { video: '🎬', image: '🖼️', audio: '🎵', post: '📱', link: '🔗' };
  return icons[mediaType] || '🔗';
}

function hexToRgba(hex, alpha) {
  if (!hex || !hex.startsWith('#')) return `rgba(100,116,139,${alpha})`;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function extractDomain(url) {
  try { return new URL(url).hostname.replace('www.', ''); }
  catch { return url; }
}

// ─── Navigation ───────────────────────────────────────────────────────────────
function navigate(page) {
  State.currentPage = page;
  State.filter = { platform: null, category: null };
  State.search = '';
  document.getElementById('search-input').value = '';
  
  // Active states sidebar
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const active = document.querySelector(`[data-page="${page}"]`);
  if (active) active.classList.add('active');

  // Bottom nav
  document.querySelectorAll('.bottom-nav-item[data-page]').forEach(el => el.classList.remove('active'));
  const activeBottom = document.querySelector(`.bottom-nav-item[data-page="${page}"]`);
  if (activeBottom) activeBottom.classList.add('active');

  // Show/hide settings vs content
  document.getElementById('content-area').style.display = page === 'settings' ? 'none' : 'block';
  document.getElementById('settings-area').style.display = page === 'settings' ? 'block' : 'none';

  if (page === 'settings') {
    renderSettingsPage();
  } else {
    renderSidebar();
    renderPage();
    renderNavBadges();
  }
}

function setFilter(type, value) {
  State.currentPage = 'all';
  if (State.filter[type] === value) {
    State.filter[type] = null; // toggle off
  } else {
    State.filter = { platform: null, category: null };
    State.filter[type] = value;
  }
  renderSidebar();
  renderPage();
}

// ─── Add / Edit Post ──────────────────────────────────────────────────────────
let analyzedData = null;
let currentTags = [];

function openAddModal(editId = null) {
  State.editPost = editId ? State.posts.find(p => p.id === editId) : null;
  analyzedData = null;
  currentTags = State.editPost?.hashtags ? [...State.editPost.hashtags] : [];

  const modal = document.getElementById('add-modal');
  document.getElementById('modal-title').textContent = State.editPost ? 'Modifica' : 'Aggiungi media';
  document.getElementById('url-input').value = State.editPost?.url || '';
  document.getElementById('post-title').value = State.editPost?.title || '';
  document.getElementById('post-desc').value = State.editPost?.description || '';
  document.getElementById('analyze-progress').textContent = '';
  
  // Reset preview
  document.getElementById('url-preview').classList.remove('show');
  
  // Render categories
  renderCategorySelector(State.editPost?.categories || []);
  
  // Render tags
  renderTagsInput();

  modal.classList.add('open');
  
  if (State.editPost) {
    // Pre-populate with existing data
    analyzedData = { ...State.editPost };
    showUrlPreview(State.editPost);
  }
  
  setTimeout(() => document.getElementById('url-input').focus(), 100);
}

function closeAddModal() {
  document.getElementById('add-modal').classList.remove('open');
  State.editPost = null;
  analyzedData = null;
}

function renderCategorySelector(selected = []) {
  const categories = Categorizer.getCategoryList();
  const html = categories.map(cat => `
    <span class="cat-select-chip ${selected.includes(cat.id) ? 'selected' : ''}" 
          style="${selected.includes(cat.id) ? `color:${cat.color};border-color:${cat.color}` : ''}"
          data-cat="${cat.id}" onclick="toggleCategory(this,'${cat.id}','${cat.color}')">
      ${cat.icon} ${cat.label}
    </span>
  `).join('');
  document.getElementById('cat-selector').innerHTML = html;
}

function toggleCategory(el, catId, color) {
  el.classList.toggle('selected');
  if (el.classList.contains('selected')) {
    el.style.color = color;
    el.style.borderColor = color;
  } else {
    el.style.color = '';
    el.style.borderColor = '';
  }
}

function getSelectedCategories() {
  return Array.from(document.querySelectorAll('.cat-select-chip.selected')).map(el => el.dataset.cat);
}

function renderTagsInput() {
  const wrap = document.getElementById('tags-wrap');
  const input = document.getElementById('tags-input');
  const existing = wrap.querySelectorAll('.tag-pill');
  existing.forEach(e => e.remove());
  currentTags.forEach(tag => {
    const pill = document.createElement('span');
    pill.className = 'tag-pill';
    pill.innerHTML = `#${escHtml(tag)} <button onclick="removeTag('${tag}')"><i class="fas fa-times"></i></button>`;
    wrap.insertBefore(pill, input);
  });
}

function addTag(tag) {
  tag = tag.toLowerCase().replace(/[^a-z0-9_\u00C0-\u024F]/g, '');
  if (tag && !currentTags.includes(tag) && currentTags.length < 15) {
    currentTags.push(tag);
    renderTagsInput();
  }
}

function removeTag(tag) {
  currentTags = currentTags.filter(t => t !== tag);
  renderTagsInput();
}

async function analyzeUrl() {
  const url = document.getElementById('url-input').value.trim();
  if (!url) { showToast('Inserisci un URL valido', 'error'); return; }

  let cleanUrl = url;
  if (!url.startsWith('http')) cleanUrl = 'https://' + url;

  const btn = document.getElementById('analyze-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Analisi...';

  const progress = document.getElementById('analyze-progress');
  progress.innerHTML = '<span class="spinner"></span> Rilevamento piattaforma...';

  try {
    analyzedData = await MediaDetector.analyze(cleanUrl, msg => {
      progress.innerHTML = `<span class="spinner"></span> ${msg}`;
    });

    progress.textContent = '✓ Completato!';
    setTimeout(() => { progress.textContent = ''; }, 2000);

    // Fill fields
    if (!document.getElementById('post-title').value) {
      document.getElementById('post-title').value = analyzedData.title || '';
    }
    if (!document.getElementById('post-desc').value) {
      document.getElementById('post-desc').value = analyzedData.description || '';
    }

    // Auto-categorize
    const autoCats = Categorizer.categorize(analyzedData);
    renderCategorySelector(autoCats);

    // Auto-tags from hashtags
    if (analyzedData.hashtags && analyzedData.hashtags.length > 0) {
      currentTags = [...new Set([...currentTags, ...analyzedData.hashtags])].slice(0, 15);
      renderTagsInput();
    }

    showUrlPreview(analyzedData);

  } catch (e) {
    progress.textContent = '⚠ Analisi parziale, puoi completare manualmente.';
    console.error(e);
  }

  btn.disabled = false;
  btn.innerHTML = '<i class="fas fa-search"></i> Analizza';
}

function showUrlPreview(data) {
  const preview = document.getElementById('url-preview');
  preview.classList.add('show');

  const color = data.color || '#64748B';
  const icon = data.icon || 'fas fa-globe';
  const thumbEl = document.getElementById('preview-thumb');
  
  if (data.thumbnail) {
    thumbEl.style.display = 'block';
    thumbEl.src = data.thumbnail;
    thumbEl.onerror = () => { thumbEl.style.display = 'none'; };
  } else {
    thumbEl.style.display = 'none';
  }

  document.getElementById('preview-platform').innerHTML = `<i class="${icon}" style="color:${color}"></i> ${getPlatformLabel(data.platform || 'web')}`;
  document.getElementById('preview-platform').style.color = color;
  document.getElementById('preview-title').textContent = data.title || data.url || '';
  document.getElementById('preview-desc').textContent = data.description || '';
}

async function savePost() {
  const url = document.getElementById('url-input').value.trim();
  if (!url) { showToast('URL richiesto', 'error'); return; }

  let cleanUrl = url;
  if (!url.startsWith('http')) cleanUrl = 'https://' + url;

  const title = document.getElementById('post-title').value.trim() || extractDomain(cleanUrl);
  const description = document.getElementById('post-desc').value.trim();
  const categories = getSelectedCategories();

  const post = {
    id: State.editPost?.id || genId(),
    url: cleanUrl,
    title,
    description,
    categories,
    hashtags: currentTags,
    favorite: State.editPost?.favorite || false,
    ...(analyzedData || MediaDetector.detectPlatform(cleanUrl)),
    // Override with user input
    title,
    description,
    categories,
    hashtags: currentTags,
    createdAt: State.editPost?.createdAt || Date.now(),
  };

  // Ensure platform info
  if (!post.color || !post.icon) {
    const platformInfo = MediaDetector.detectPlatform(cleanUrl);
    Object.assign(post, platformInfo);
  }

  const saveBtn = document.getElementById('save-btn');
  saveBtn.disabled = true;
  saveBtn.innerHTML = '<span class="spinner"></span> Salvataggio...';

  await StorageManager.save(post);

  // Update state
  const idx = State.posts.findIndex(p => p.id === post.id);
  if (idx >= 0) State.posts[idx] = post;
  else State.posts.unshift(post);

  closeAddModal();
  renderSidebar();
  renderPage();
  renderNavBadges();
  renderStats();

  saveBtn.disabled = false;
  saveBtn.innerHTML = '<i class="fas fa-save"></i> Salva';
  showToast(State.editPost ? 'Modificato!' : 'Aggiunto!', 'success');
}

function editPost(id) {
  openAddModal(id);
}

async function deletePost(id) {
  if (!confirm('Elimina questo elemento?')) return;
  await StorageManager.remove(id);
  State.posts = State.posts.filter(p => p.id !== id);
  renderSidebar();
  renderPage();
  renderNavBadges();
  renderStats();
  showToast('Eliminato', 'success');
}

async function toggleFavorite(id) {
  const isFav = await StorageManager.toggleFavorite(id);
  const post = State.posts.find(p => p.id === id);
  if (post) post.favorite = isFav;
  renderPage();
  renderNavBadges();
  renderStats();
  showToast(isFav ? '⭐ Aggiunto ai preferiti' : 'Rimosso dai preferiti');
}

// ─── Media Viewer ─────────────────────────────────────────────────────────────
function openViewer(id) {
  const post = State.posts.find(p => p.id === id);
  if (!post) return;

  const viewer = document.getElementById('viewer-overlay');
  document.getElementById('viewer-title').textContent = post.title || extractDomain(post.url);

  const content = document.getElementById('viewer-content');
  content.innerHTML = '';

  if (post.embedUrl) {
    const iframe = document.createElement('iframe');
    iframe.src = post.embedUrl;
    iframe.allowFullscreen = true;
    iframe.allow = 'autoplay; encrypted-media; fullscreen';
    content.appendChild(iframe);
  } else if (post.mediaType === 'image' || post.platform === 'image') {
    const img = document.createElement('img');
    img.src = post.url;
    img.alt = post.title || '';
    content.appendChild(img);
  } else if (post.platform === 'video' || post.url.match(/\.(mp4|webm|mov|ogg)(\?.*)?$/i)) {
    const video = document.createElement('video');
    video.src = post.url;
    video.controls = true;
    video.autoplay = false;
    content.appendChild(video);
  } else if (post.platform === 'twitter') {
    // Twitter/X embed via blockquote
    const div = document.createElement('div');
    div.className = 'twitter-embed';
    div.innerHTML = `
      <blockquote class="twitter-tweet" data-theme="dark">
        <a href="${post.url}"></a>
      </blockquote>
      <div style="padding:20px;text-align:center">
        <a href="${post.url}" target="_blank" class="btn-primary" style="display:inline-flex">
          <i class="fab fa-twitter"></i> Apri su X/Twitter
        </a>
      </div>
    `;
    content.appendChild(div);
    // Load twitter widget
    if (!document.querySelector('script[src*="twitter"]')) {
      const s = document.createElement('script');
      s.src = 'https://platform.twitter.com/widgets.js';
      s.async = true;
      document.head.appendChild(s);
    } else if (window.twttr) {
      window.twttr.widgets.load(div);
    }
  } else {
    // Fallback: link + thumbnail
    content.innerHTML = `
      <div style="text-align:center;padding:40px 20px">
        ${post.thumbnail ? `<img src="${post.thumbnail}" style="max-height:300px;border-radius:12px;margin:0 auto 24px">` : ''}
        <h2 style="font-family:var(--font-display);margin-bottom:12px">${escHtml(post.title || '')}</h2>
        <p style="color:var(--text-300);margin-bottom:24px;max-width:480px;margin-left:auto;margin-right:auto">${escHtml(post.description || '')}</p>
        <a href="${post.url}" target="_blank" rel="noopener" class="btn-primary">
          <i class="fas fa-external-link-alt"></i> Apri originale
        </a>
      </div>
    `;
  }

  viewer.classList.add('open');
}

function closeViewer() {
  document.getElementById('viewer-overlay').classList.remove('open');
  // Stop any playing media
  const iframe = document.querySelector('#viewer-content iframe');
  if (iframe) { const src = iframe.src; iframe.src = ''; iframe.src = src; }
  const video = document.querySelector('#viewer-content video');
  if (video) { video.pause(); }
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function renderSettingsPage() {
  const s = StorageManager.getSettings();
  document.getElementById('redis-url').value = s.redisUrl || '';
  document.getElementById('redis-token').value = s.redisToken || '';
  updateRedisStatus();
  renderStats();
}

function saveSettings() {
  const settings = StorageManager.getSettings();
  settings.redisUrl = document.getElementById('redis-url').value.trim();
  settings.redisToken = document.getElementById('redis-token').value.trim();
  StorageManager.saveSettings(settings);
  showToast('Impostazioni salvate', 'success');
  updateRedisStatus();
}

function updateRedisStatus() {
  const s = StorageManager.getSettings();
  const el = document.getElementById('redis-connection-status');
  if (s.redisUrl && s.redisToken) {
    el.className = 'redis-status connected';
    el.innerHTML = '<i class="fas fa-circle" style="font-size:0.5rem"></i> Configurato';
  } else {
    el.className = 'redis-status';
    el.innerHTML = '<i class="fas fa-circle" style="font-size:0.5rem"></i> Non configurato';
  }
}

async function testRedisConnection() {
  const btn = document.getElementById('test-redis-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Test...';
  saveSettings();
  const ok = await StorageManager.syncToRedis();
  btn.disabled = false;
  btn.innerHTML = '<i class="fas fa-plug"></i> Test connessione';
  if (ok) {
    showToast('✓ Redis connesso correttamente!', 'success');
    document.getElementById('redis-connection-status').className = 'redis-status connected';
  } else {
    showToast('✗ Connessione Redis fallita. Controlla URL e token.', 'error', 5000);
  }
}

async function syncFromRedis() {
  const btn = document.getElementById('sync-redis-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Sincronizzazione...';
  const result = await StorageManager.syncFromRedis();
  btn.disabled = false;
  btn.innerHTML = '<i class="fas fa-cloud-download-alt"></i> Sincronizza da Redis';
  if (result) {
    State.posts = result;
    renderSidebar();
    renderPage();
    renderNavBadges();
    renderStats();
    showToast(`Sincronizzati ${result.length} elementi da Redis`, 'success');
  } else {
    showToast('Nessun dato trovato su Redis', 'error');
  }
}

function triggerImport() {
  document.getElementById('import-file').click();
}

async function handleImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const result = await StorageManager.importDB(file);
    State.posts = await StorageManager.getAll();
    renderSidebar();
    renderPage();
    renderNavBadges();
    renderStats();
    showToast(`Importati ${result.count} elementi (totale: ${result.total})`, 'success');
  } catch (err) {
    showToast('Errore importazione: ' + err.message, 'error');
  }
  e.target.value = '';
}

async function clearAllData() {
  if (!confirm('Eliminare TUTTI i dati? Questa azione è irreversibile.')) return;
  await StorageManager.clearAll();
  State.posts = [];
  renderSidebar();
  renderPage();
  renderNavBadges();
  renderStats();
  showToast('Dati eliminati', 'success');
}

// ─── Event Setup ──────────────────────────────────────────────────────────────
function setupEvents() {
  // Search
  const searchInput = document.getElementById('search-input');
  let searchTimeout;
  searchInput.addEventListener('input', e => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      State.search = e.target.value.toLowerCase();
      renderPage();
    }, 200);
  });

  // View mode toggle
  document.getElementById('view-grid').addEventListener('click', () => {
    State.viewMode = 'grid';
    document.getElementById('cards-grid').classList.remove('list-view');
    document.getElementById('view-grid').classList.add('active');
    document.getElementById('view-list').classList.remove('active');
  });
  document.getElementById('view-list').addEventListener('click', () => {
    State.viewMode = 'list';
    document.getElementById('cards-grid').classList.add('list-view');
    document.getElementById('view-list').classList.add('active');
    document.getElementById('view-grid').classList.remove('active');
  });

  // URL input - analyze on enter
  document.getElementById('url-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') analyzeUrl();
  });

  // Tags input
  const tagsInput = document.getElementById('tags-input');
  tagsInput.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ',' || e.key === ' ') && tagsInput.value.trim()) {
      e.preventDefault();
      addTag(tagsInput.value.trim().replace(/,| /g, ''));
      tagsInput.value = '';
    } else if (e.key === 'Backspace' && !tagsInput.value && currentTags.length > 0) {
      removeTag(currentTags[currentTags.length - 1]);
    }
  });
  document.getElementById('tags-wrap').addEventListener('click', () => tagsInput.focus());

  // Modal close on overlay click
  document.getElementById('add-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('add-modal')) closeAddModal();
  });

  // Viewer close on overlay click
  document.getElementById('viewer-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('viewer-overlay')) closeViewer();
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeViewer();
      closeAddModal();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      document.getElementById('search-input').focus();
    }
  });

  // PWA install prompt
  let deferredPrompt;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
    document.getElementById('pwa-install-btn').style.display = 'flex';
    document.getElementById('pwa-install-btn').onclick = async () => {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') showToast('App installata!', 'success');
      deferredPrompt = null;
    };
  });
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
