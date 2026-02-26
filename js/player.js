/**
 * VideoPlayer — Cobalt.tools integration + custom HTML5 player
 *
 * Cobalt.tools è un servizio open-source gratuito che estrae URL diretti
 * di video da YouTube, TikTok, Instagram, Twitter, Vimeo, Reddit, ecc.
 * https://cobalt.tools / https://github.com/imputnet/cobalt
 */

const VideoPlayer = (() => {

  // ─── Cobalt instances (fallback chain) ────────────────────────────────────
  // Istanze pubbliche della community — se una è giù, proviamo la prossima
  const COBALT_INSTANCES = [
    'https://api.cobalt.tools',
    'https://cobalt.api.timelessnesses.me',
    'https://cobalt.catto.zip',
    'https://co.wuk.sh',
  ];

  const QUALITY_OPTIONS = ['1080', '720', '480', '360'];

  // ─── State ────────────────────────────────────────────────────────────────
  let currentPost = null;
  let videoEl = null;
  let hideControlsTimer = null;
  let currentQuality = '720';

  // ─── Cobalt API ───────────────────────────────────────────────────────────
  async function fetchFromCobalt(url, quality = '720', instanceIdx = 0) {
    if (instanceIdx >= COBALT_INSTANCES.length) return null;
    const instance = COBALT_INSTANCES[instanceIdx];

    try {
      const res = await fetch(instance, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url,
          videoQuality: quality,
          audioFormat: 'mp3',
          filenameStyle: 'basic',
          downloadMode: 'auto',
          twitterGif: false,
        }),
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      // Handle response types
      if (data.status === 'error') {
        console.warn(`Cobalt ${instance} error:`, data.error?.code);
        return null;
      }

      if (data.status === 'stream' || data.status === 'redirect' || data.status === 'tunnel') {
        return { type: 'single', url: data.url };
      }

      if (data.status === 'picker') {
        // Multiple streams available (e.g. Twitter with multiple videos)
        const videos = data.picker.filter(i => i.type === 'video' || !i.type);
        if (videos.length > 0) return { type: 'picker', items: videos };
        return null;
      }

      return null;

    } catch (e) {
      console.warn(`Cobalt instance ${instance} failed:`, e.message);
      // Try next instance
      return fetchFromCobalt(url, quality, instanceIdx + 1);
    }
  }

  // Check which platforms cobalt supports
  function isCobaltSupported(platform, url) {
    const supported = [
      'youtube', 'tiktok', 'instagram', 'twitter', 'vimeo',
      'reddit', 'twitch', 'facebook', 'video'
    ];
    // Also check by URL pattern
    const urlPatterns = [
      /youtube\.com/, /youtu\.be/, /tiktok\.com/, /instagram\.com/,
      /twitter\.com/, /x\.com/, /vimeo\.com/, /reddit\.com/,
      /twitch\.tv/, /facebook\.com/, /fb\.watch/,
    ];
    return supported.includes(platform) || urlPatterns.some(p => p.test(url));
  }

  // ─── Custom Player HTML ───────────────────────────────────────────────────
  function buildPlayerHTML(post) {
    const thumb = post.thumbnail || '';
    return `
      <div class="mv-player" id="mv-player">

        <!-- Loading screen -->
        <div class="mv-loading" id="mv-loading">
          ${thumb ? `<img class="mv-loading-thumb" src="${thumb}" alt="">` : ''}
          <div class="mv-loading-overlay">
            <div class="mv-loading-spinner"></div>
            <p class="mv-loading-text" id="mv-loading-text">Avvio riproduzione…</p>
            <p class="mv-loading-sub" id="mv-loading-sub">Recupero stream diretto via Cobalt</p>
          </div>
        </div>

        <!-- Error screen -->
        <div class="mv-error" id="mv-error" style="display:none">
          <div class="mv-error-icon">⚠️</div>
          <p class="mv-error-text" id="mv-error-text">Stream non disponibile</p>
          <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:16px">
            <button class="mv-btn" onclick="VideoPlayer.retryDirect()">
              <i class="fas fa-redo"></i> Riprova
            </button>
            <button class="mv-btn mv-btn-ghost" onclick="VideoPlayer.fallbackEmbed()">
              <i class="fas fa-code"></i> Usa embed
            </button>
            <a class="mv-btn mv-btn-ghost" href="${post.url}" target="_blank" rel="noopener">
              <i class="fas fa-external-link-alt"></i> Apri originale
            </a>
          </div>
        </div>

        <!-- Picker screen (multiple streams) -->
        <div class="mv-picker" id="mv-picker" style="display:none">
          <p style="color:var(--text-200);margin-bottom:14px;font-size:0.9rem">Scegli uno stream:</p>
          <div class="mv-picker-list" id="mv-picker-list"></div>
        </div>

        <!-- Video element (hidden until ready) -->
        <div class="mv-video-wrap" id="mv-video-wrap" style="display:none">
          <video
            id="mv-video"
            preload="metadata"
            playsinline
            webkit-playsinline
            x-webkit-airplay="allow"
            crossorigin="anonymous"
          ></video>

          <!-- Custom controls overlay -->
          <div class="mv-controls-overlay" id="mv-controls-overlay">

            <!-- Center play/pause hit area -->
            <div class="mv-center-hit" id="mv-center-hit" onclick="VideoPlayer.togglePlay()">
              <div class="mv-center-icon" id="mv-center-icon">
                <i class="fas fa-play"></i>
              </div>
            </div>

            <!-- Bottom controls bar -->
            <div class="mv-controls-bar" id="mv-controls-bar">

              <!-- Progress -->
              <div class="mv-progress-wrap" id="mv-progress-wrap">
                <div class="mv-progress-bg">
                  <div class="mv-progress-buffered" id="mv-progress-buffered"></div>
                  <div class="mv-progress-played" id="mv-progress-played"></div>
                  <div class="mv-progress-thumb" id="mv-progress-thumb"></div>
                </div>
                <input type="range" class="mv-progress-input" id="mv-progress-input"
                       min="0" max="100" value="0" step="0.1"
                       oninput="VideoPlayer.seekTo(this.value)"
                       onmousedown="VideoPlayer.onSeekStart()"
                       onmouseup="VideoPlayer.onSeekEnd()"
                       ontouchstart="VideoPlayer.onSeekStart()"
                       ontouchend="VideoPlayer.onSeekEnd()">
              </div>

              <!-- Controls row -->
              <div class="mv-controls-row">
                <div class="mv-controls-left">
                  <button class="mv-ctrl-btn" id="mv-play-btn" onclick="VideoPlayer.togglePlay()" title="Play/Pausa (Spazio)">
                    <i class="fas fa-play" id="mv-play-icon"></i>
                  </button>
                  <button class="mv-ctrl-btn" onclick="VideoPlayer.skip(-10)" title="Indietro 10s">
                    <i class="fas fa-rotate-left"></i><span class="mv-skip-label">10</span>
                  </button>
                  <button class="mv-ctrl-btn" onclick="VideoPlayer.skip(10)" title="Avanti 10s">
                    <i class="fas fa-rotate-right"></i><span class="mv-skip-label">10</span>
                  </button>
                  <div class="mv-volume-wrap">
                    <button class="mv-ctrl-btn" id="mv-mute-btn" onclick="VideoPlayer.toggleMute()" title="Muto (M)">
                      <i class="fas fa-volume-high" id="mv-vol-icon"></i>
                    </button>
                    <input type="range" class="mv-volume-input" id="mv-volume-input"
                           min="0" max="1" step="0.05" value="1"
                           oninput="VideoPlayer.setVolume(this.value)">
                  </div>
                  <span class="mv-time" id="mv-time">0:00 / 0:00</span>
                </div>
                <div class="mv-controls-right">
                  <div class="mv-quality-wrap">
                    <button class="mv-ctrl-btn mv-quality-btn" id="mv-quality-btn" onclick="VideoPlayer.toggleQualityMenu()" title="Qualità">
                      <i class="fas fa-sliders"></i>
                      <span id="mv-quality-label">${currentQuality}p</span>
                    </button>
                    <div class="mv-quality-menu" id="mv-quality-menu">
                      ${QUALITY_OPTIONS.map(q => `
                        <button class="mv-quality-opt ${q === currentQuality ? 'active' : ''}"
                                onclick="VideoPlayer.changeQuality('${q}')">${q}p</button>
                      `).join('')}
                    </div>
                  </div>
                  <button class="mv-ctrl-btn" onclick="VideoPlayer.togglePiP()" title="Picture in Picture">
                    <i class="fas fa-external-link-square-alt"></i>
                  </button>
                  <button class="mv-ctrl-btn" onclick="VideoPlayer.toggleFullscreen()" title="Schermo intero (F)">
                    <i class="fas fa-expand" id="mv-fs-icon"></i>
                  </button>
                </div>
              </div>
            </div>

          </div><!-- /controls-overlay -->
        </div><!-- /video-wrap -->

      </div><!-- /mv-player -->
    `;
  }

  // ─── CORS Proxy chain ─────────────────────────────────────────────────────
  // Lista di proxy per fetchare pagine HTML (aggira CORS in lettura)
  const FETCH_PROXIES = [
    url => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
    url => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
    url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  ];

  // Lista di proxy per wrappare l'URL video come src del <video> (aggira CORS in streaming)
  const VIDEO_PROXIES = [
    url => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
    url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    url => `https://thingproxy.freeboard.io/fetch/${url}`,
  ];

  // Fetcha HTML di una pagina provando tutti i proxy in cascata
  async function fetchHtmlViaProxy(targetUrl) {
    for (const buildProxy of FETCH_PROXIES) {
      try {
        const proxyUrl = buildProxy(targetUrl);
        const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) continue;
        const data = await res.json().catch(() => null);
        // allorigins e codetabs restituiscono { contents: "..." }
        if (data?.contents) return data.contents;
        // corsproxy restituisce il body diretto
        const text = await res.text().catch(() => null);
        if (text && text.length > 100) return text;
      } catch (e) {
        console.warn(`[proxy] ${buildProxy(targetUrl).slice(0, 40)} fallito:`, e.message);
      }
    }
    return null;
  }

  // Estrae l'URL raw del video dall'HTML di vxinstagram
  // Cerca: <source src="...">, og:video, og:video:secure_url
  function extractSourceUrl(html) {
    // 1. <source src="..."> — il più affidabile, è il tag diretto nel <video>
    const sourceSrc = html.match(/<source[^>]+src=["']([^"']+)["']/i);
    if (sourceSrc?.[1]) return decodeHtmlEntities(sourceSrc[1]);

    // 2. og:video:secure_url
    const ogSecure = html.match(/property=["']og:video:secure_url["'][^>]*content=["']([^"']+)["']/i)
                  || html.match(/content=["']([^"']+)["'][^>]*property=["']og:video:secure_url["']/i);
    if (ogSecure?.[1]) return decodeHtmlEntities(ogSecure[1]);

    // 3. og:video
    const ogVideo = html.match(/property=["']og:video["'][^>]*content=["']([^"']+)["']/i)
                 || html.match(/content=["']([^"']+)["'][^>]*property=["']og:video["']/i);
    if (ogVideo?.[1]) return decodeHtmlEntities(ogVideo[1]);

    return null;
  }

  function decodeHtmlEntities(str) {
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  // Pipeline completa per Instagram:
  // 1. Fetcha vxinstagram via proxy → estrai URL sorgente
  // 2. Wrappa URL sorgente con corsproxy per la riproduzione
  async function getInstagramVideoUrl(igUrl) {
    const vxUrl = buildVxInstagramUrl(igUrl);
    if (!vxUrl) return null;

    console.log('[IG] Fetching vxinstagram:', vxUrl);

    // Step 1: ottieni HTML di vxinstagram tramite proxy
    const html = await fetchHtmlViaProxy(vxUrl);
    if (!html) {
      console.warn('[IG] Impossibile fetchare la pagina vxinstagram');
      return null;
    }

    // Step 2: estrai l'URL del video dalla pagina
    const rawVideoUrl = extractSourceUrl(html);
    if (!rawVideoUrl) {
      console.warn('[IG] Nessun URL video trovato nell\'HTML');
      return null;
    }
    console.log('[IG] URL estratto:', rawVideoUrl.slice(0, 80) + '…');

    // Step 3: wrappa con corsproxy per permettere la riproduzione
    // (l'URL estratto è su vxinstagram/rapidcdn che ha CORS bloccato)
    for (const buildVideoProxy of VIDEO_PROXIES) {
      const proxiedUrl = buildVideoProxy(rawVideoUrl);
      console.log('[IG] Provo video proxy:', proxiedUrl.slice(0, 60) + '…');

      // Verifica veloce che il proxy risponda (HEAD request)
      try {
        const probe = await fetch(proxiedUrl, {
          method: 'HEAD',
          signal: AbortSignal.timeout(5000),
        });
        if (probe.ok || probe.status === 206) {
          console.log('[IG] ✓ Video proxy funzionante:', proxiedUrl.slice(0, 60));
          return proxiedUrl;
        }
      } catch (e) {
        console.warn('[IG] Video proxy HEAD fallito:', e.message);
      }
    }

    // Se HEAD fallisce per tutti, prova comunque il primo (alcuni proxy non supportano HEAD)
    console.warn('[IG] HEAD falliti, provo direttamente corsproxy');
    return VIDEO_PROXIES[0](rawVideoUrl);
  }
  function togglePlay() {
    if (!videoEl) return;
    if (videoEl.paused) {
      videoEl.play();
      showCenterIcon('play');
    } else {
      videoEl.pause();
      showCenterIcon('pause');
    }
  }

  function showCenterIcon(type) {
    const icon = document.getElementById('mv-center-icon');
    if (!icon) return;
    icon.innerHTML = `<i class="fas fa-${type === 'play' ? 'play' : 'pause'}"></i>`;
    icon.classList.remove('mv-center-icon-anim');
    void icon.offsetWidth;
    icon.classList.add('mv-center-icon-anim');
  }

  function skip(seconds) {
    if (!videoEl) return;
    videoEl.currentTime = Math.max(0, Math.min(videoEl.duration || 0, videoEl.currentTime + seconds));
  }

  let isSeeking = false;
  function onSeekStart() { isSeeking = true; }
  function onSeekEnd() { isSeeking = false; }

  function seekTo(pct) {
    if (!videoEl || !videoEl.duration) return;
    videoEl.currentTime = (pct / 100) * videoEl.duration;
  }

  function setVolume(val) {
    if (!videoEl) return;
    videoEl.volume = parseFloat(val);
    videoEl.muted = val == 0;
    updateVolumeIcon();
  }

  function toggleMute() {
    if (!videoEl) return;
    videoEl.muted = !videoEl.muted;
    const volInput = document.getElementById('mv-volume-input');
    if (volInput) volInput.value = videoEl.muted ? 0 : videoEl.volume;
    updateVolumeIcon();
  }

  function updateVolumeIcon() {
    const icon = document.getElementById('mv-vol-icon');
    if (!icon || !videoEl) return;
    if (videoEl.muted || videoEl.volume === 0) icon.className = 'fas fa-volume-xmark';
    else if (videoEl.volume < 0.5) icon.className = 'fas fa-volume-low';
    else icon.className = 'fas fa-volume-high';
  }

  function toggleFullscreen() {
    const player = document.getElementById('mv-player');
    if (!player) return;
    if (!document.fullscreenElement) {
      (player.requestFullscreen || player.webkitRequestFullscreen || player.mozRequestFullScreen).call(player);
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    }
  }

  async function togglePiP() {
    if (!videoEl) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await videoEl.requestPictureInPicture();
    } catch (e) { console.warn('PiP not supported:', e); }
  }

  function toggleQualityMenu() {
    const menu = document.getElementById('mv-quality-menu');
    if (menu) menu.style.display = menu.style.display === 'flex' ? 'none' : 'flex';
  }

  async function changeQuality(quality) {
    if (!currentPost) return;
    currentQuality = quality;
    document.getElementById('mv-quality-label').textContent = quality + 'p';
    document.getElementById('mv-quality-menu').style.display = 'none';
    document.querySelectorAll('.mv-quality-opt').forEach(el => {
      el.classList.toggle('active', el.textContent === quality + 'p');
    });
    const savedTime = videoEl ? videoEl.currentTime : 0;
    showLoading('Cambio qualità ' + quality + 'p…', '');
    const result = await Extractor.extract(
      currentPost.url, currentPost.platform, quality,
      (msg) => { const el = document.getElementById('mv-loading-sub'); if (el) el.textContent = msg; }
    );
    if (result?.url) loadVideoUrl(result.url, savedTime);
    else showError('Qualità non disponibile.');
  }

  function showLoading(text, sub) {
    const loadEl = document.getElementById('mv-loading');
    const videoWrap = document.getElementById('mv-video-wrap');
    const errEl = document.getElementById('mv-error');
    const pickerEl = document.getElementById('mv-picker');
    if (loadEl) { loadEl.style.display = 'flex'; }
    if (videoWrap) videoWrap.style.display = 'none';
    if (errEl) errEl.style.display = 'none';
    if (pickerEl) pickerEl.style.display = 'none';
    if (text) document.getElementById('mv-loading-text').textContent = text;
    if (sub !== undefined) document.getElementById('mv-loading-sub').textContent = sub;
  }

  function showError(text) {
    document.getElementById('mv-loading').style.display = 'none';
    document.getElementById('mv-video-wrap').style.display = 'none';
    document.getElementById('mv-picker').style.display = 'none';
    const errEl = document.getElementById('mv-error');
    errEl.style.display = 'flex';
    document.getElementById('mv-error-text').textContent = text || 'Stream non disponibile';
  }

  function showPicker(items) {
    document.getElementById('mv-loading').style.display = 'none';
    document.getElementById('mv-video-wrap').style.display = 'none';
    document.getElementById('mv-error').style.display = 'none';
    const pickerEl = document.getElementById('mv-picker');
    pickerEl.style.display = 'flex';
    const list = document.getElementById('mv-picker-list');
    list.innerHTML = items.map((item, i) => `
      <button class="mv-picker-item" onclick="VideoPlayer.loadVideoUrl('${item.url}', 0)">
        ${item.thumb ? `<img src="${item.thumb}" class="mv-picker-thumb" alt="">` : `<div class="mv-picker-thumb-ph"><i class="fas fa-video"></i></div>`}
        <span>Video ${i + 1}</span>
      </button>
    `).join('');
  }

  function loadVideoUrl(url, startTime = 0) {
    document.getElementById('mv-loading').style.display = 'none';
    document.getElementById('mv-error').style.display = 'none';
    document.getElementById('mv-picker').style.display = 'none';
    const videoWrap = document.getElementById('mv-video-wrap');
    videoWrap.style.display = 'block';
    videoWrap.style.opacity = '0';

    videoEl = document.getElementById('mv-video');
    videoEl.src = url;
    videoEl.currentTime = startTime;

    setupVideoEvents();

    videoEl.play().then(() => {
      videoWrap.style.transition = 'opacity 0.3s';
      videoWrap.style.opacity = '1';
    }).catch(e => {
      // Autoplay blocked — show play button
      videoWrap.style.opacity = '1';
      console.warn('Autoplay blocked:', e);
    });
  }

  function setupVideoEvents() {
    if (!videoEl) return;

    videoEl.addEventListener('timeupdate', updateProgress);
    videoEl.addEventListener('progress', updateBuffered);
    videoEl.addEventListener('play', () => {
      document.getElementById('mv-play-icon').className = 'fas fa-pause';
      startHideControls();
    });
    videoEl.addEventListener('pause', () => {
      document.getElementById('mv-play-icon').className = 'fas fa-play';
      clearTimeout(hideControlsTimer);
      showControls();
    });
    videoEl.addEventListener('ended', () => {
      document.getElementById('mv-play-icon').className = 'fas fa-play';
      showControls();
    });
    videoEl.addEventListener('error', (e) => {
      console.error('Video error:', e);
      showError('Errore riproduzione. Prova a cambiare qualità o usa embed.');
    });
    videoEl.addEventListener('waiting', () => {
      // buffering indicator
    });
    videoEl.addEventListener('dblclick', toggleFullscreen);

    // Fullscreen change
    document.addEventListener('fullscreenchange', () => {
      const icon = document.getElementById('mv-fs-icon');
      if (icon) icon.className = document.fullscreenElement ? 'fas fa-compress' : 'fas fa-expand';
    });

    // Controls auto-hide
    const overlay = document.getElementById('mv-controls-overlay');
    if (overlay) {
      overlay.addEventListener('mousemove', showAndScheduleHide);
      overlay.addEventListener('touchstart', showAndScheduleHide, { passive: true });
    }

    // Keyboard shortcuts
    document._mvKeyHandler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (!document.getElementById('mv-player')) return;
      switch (e.key) {
        case ' ': case 'k': e.preventDefault(); togglePlay(); break;
        case 'ArrowRight': e.preventDefault(); skip(10); break;
        case 'ArrowLeft': e.preventDefault(); skip(-10); break;
        case 'ArrowUp': e.preventDefault(); setVolume(Math.min(1, (videoEl?.volume || 0) + 0.1)); break;
        case 'ArrowDown': e.preventDefault(); setVolume(Math.max(0, (videoEl?.volume || 0) - 0.1)); break;
        case 'm': case 'M': toggleMute(); break;
        case 'f': case 'F': toggleFullscreen(); break;
      }
    };
    document.addEventListener('keydown', document._mvKeyHandler);
  }

  function updateProgress() {
    if (!videoEl || isSeeking) return;
    const pct = videoEl.duration ? (videoEl.currentTime / videoEl.duration) * 100 : 0;
    const played = document.getElementById('mv-progress-played');
    const thumb = document.getElementById('mv-progress-thumb');
    const input = document.getElementById('mv-progress-input');
    const time = document.getElementById('mv-time');
    if (played) played.style.width = pct + '%';
    if (thumb) thumb.style.left = pct + '%';
    if (input) input.value = pct;
    if (time) time.textContent = `${formatTime(videoEl.currentTime)} / ${formatTime(videoEl.duration)}`;
  }

  function updateBuffered() {
    if (!videoEl || !videoEl.buffered.length) return;
    const pct = videoEl.duration ? (videoEl.buffered.end(videoEl.buffered.length - 1) / videoEl.duration) * 100 : 0;
    const buf = document.getElementById('mv-progress-buffered');
    if (buf) buf.style.width = pct + '%';
  }

  function formatTime(s) {
    if (!s || isNaN(s)) return '0:00';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  function showControls() {
    const bar = document.getElementById('mv-controls-bar');
    if (bar) bar.classList.remove('hidden');
  }

  function startHideControls() {
    if (!videoEl || videoEl.paused) return;
    showControls();
    clearTimeout(hideControlsTimer);
    hideControlsTimer = setTimeout(() => {
      const bar = document.getElementById('mv-controls-bar');
      if (bar && videoEl && !videoEl.paused) bar.classList.add('hidden');
    }, 3000);
  }

  function showAndScheduleHide() {
    showControls();
    startHideControls();
  }

  // ─── vxinstagram URL builder (delegato a Extractor) ──────────────────────
  function buildVxInstagramUrl(url) {
    return Extractor.getVxInstagramUrl(url);
  }

  // ─── Public API ───────────────────────────────────────────────────────────
  async function open(post, viewerContentEl) {
    currentPost = post;
    videoEl = null;
    currentQuality = '720';
    if (document._mvKeyHandler) {
      document.removeEventListener('keydown', document._mvKeyHandler);
    }

    // Build player HTML
    viewerContentEl.innerHTML = buildPlayerHTML(post);
    showLoading('Avvio riproduzione…', 'Analisi piattaforma…');

    const platform = post.platform;
    const url = post.url;

    // Spotify → sempre embed
    if (platform === 'spotify') {
      cleanup();
      window._viewerFallbackEmbed(post);
      return;
    }

    // Usa il modulo Extractor universale
    const result = await Extractor.extract(
      url,
      platform,
      currentQuality,
      (msg, sub) => {
        const textEl = document.getElementById('mv-loading-text');
        const subEl  = document.getElementById('mv-loading-sub');
        if (textEl) textEl.textContent = msg;
        if (subEl)  subEl.textContent  = sub || '';
      }
    );

    if (!result) {
      showError('Nessuno stream trovato. Prova "Usa embed" o apri l\'originale.');
      return;
    }

    // Embed-only (Spotify, Twitch ecc.)
    if (result.embedOnly) {
      cleanup();
      window._viewerFallbackEmbed(post);
      return;
    }

    // Picker (es. Twitter con più video)
    if (result.picker) {
      showPicker(result.picker);
      return;
    }

    // URL diretto → riproduci
    if (result.url) {
      loadVideoUrl(result.url);
      return;
    }

    showError('Formato non supportato. Usa "Usa embed" o apri l\'originale.');
  }

  function retryDirect() {
    if (currentPost) {
      showLoading('Nuovo tentativo…', 'Provo un\'altra istanza Cobalt');
      // Force next instance by clearing cache (just retry from 0, cobalt will try all)
      setTimeout(() => open(currentPost, document.getElementById('viewer-content')), 200);
    }
  }

  function fallbackEmbed() {
    if (!currentPost) return;
    cleanup();
    // Trigger embed fallback in app.js
    if (window._viewerFallbackEmbed) window._viewerFallbackEmbed(currentPost);
  }

  function cleanup() {
    if (videoEl) {
      videoEl.pause();
      videoEl.src = '';
    }
    videoEl = null;
    currentPost = null;
    clearTimeout(hideControlsTimer);
    if (document._mvKeyHandler) {
      document.removeEventListener('keydown', document._mvKeyHandler);
      delete document._mvKeyHandler;
    }
  }

  return {
    open, cleanup, retryDirect, fallbackEmbed, loadVideoUrl,
    togglePlay, skip, seekTo, onSeekStart, onSeekEnd,
    setVolume, toggleMute, toggleFullscreen, togglePiP,
    toggleQualityMenu, changeQuality,
  };

})();
