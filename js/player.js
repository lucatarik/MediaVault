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

  // ─── Player Controls ──────────────────────────────────────────────────────
  // NOTA: tutta la logica di estrazione URL è in extractor.js
  // player.js gestisce SOLO il rendering del player e i controlli UI.
  // Gli URL arrivano già pronti da Extractor.extract() e vanno DIRETTAMENTE
  // nel tag <video src="..."> senza alcun proxy intermedio.

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

  // ─── Player log helper ────────────────────────────────────────────────────
  // FILE: js/player.js — log con prefisso colorato e nome funzione
  function PL(fn, msg, data) {
    const s = 'color:#f5a623;font-weight:bold';
    data !== undefined
      ? console.log(`%c[player.js · ${fn}] ${msg}`, s, data)
      : console.log(`%c[player.js · ${fn}] ${msg}`, s);
  }

  function showLoading(text, sub) {
    PL('showLoading', `Mostro schermata loading — text="${text}" sub="${sub}"`);
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
    PL('showError', `Mostro errore: "${text}"`);
    document.getElementById('mv-loading').style.display = 'none';
    document.getElementById('mv-video-wrap').style.display = 'none';
    document.getElementById('mv-picker').style.display = 'none';
    const errEl = document.getElementById('mv-error');
    errEl.style.display = 'flex';
    document.getElementById('mv-error-text').textContent = text || 'Stream non disponibile';
  }

  function showPicker(items) {
    PL('showPicker', `Mostro picker con ${items.length} stream disponibili`);
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
    PL('loadVideoUrl', `══ CARICO VIDEO ══`);
    PL('loadVideoUrl', `URL (${url.length} char): ${url.slice(0, 120)}…`);
    PL('loadVideoUrl', `startTime: ${startTime}s`);
    PL('loadVideoUrl', `STRATEGIA: URL va DIRETTAMENTE in <video src="..."> — nessun proxy video`);
    PL('loadVideoUrl', `Il tag <video> gestisce autonomamente redirect e autenticazione CDN`);

    document.getElementById('mv-loading').style.display = 'none';
    document.getElementById('mv-error').style.display = 'none';
    document.getElementById('mv-picker').style.display = 'none';
    const videoWrap = document.getElementById('mv-video-wrap');
    videoWrap.style.display = 'block';
    videoWrap.style.opacity = '0';

    // IMPORTANTE: prima setupVideoEvents() (che fa cloneNode e aggiorna videoEl),
    // POI impostiamo src — così il src finisce sul nodo corretto (il clone)
    // e non sul nodo originale che viene rimosso dal DOM durante il clone.
    videoEl = document.getElementById('mv-video');
    PL('loadVideoUrl', `videoEl trovato: id="${videoEl?.id}" — ora chiamo setupVideoEvents() (cloneNode interno)`);
    setupVideoEvents();
    // Dopo setupVideoEvents(), videoEl punta al nodo clonato nel DOM
    PL('loadVideoUrl', `Imposto src sul nodo clonato: "${url.slice(0, 100)}…"`);
    videoEl.removeAttribute('src'); // pulisci attributo residuo se c'era
    videoEl.src = url;
    if (startTime > 0) videoEl.currentTime = startTime;
    videoEl.load(); // forza il browser a riconoscere il nuovo src

    PL('loadVideoUrl', `videoEl.src impostato ✓ — chiamo play()`);
    videoEl.play().then(() => {
      PL('loadVideoUrl', `play() riuscito ✓ — fade-in del player`);
      videoWrap.style.transition = 'opacity 0.3s';
      videoWrap.style.opacity = '1';
    }).catch(e => {
      PL('loadVideoUrl', `play() bloccato dal browser (autoplay policy) — mostro comunque il player con tasto play`, e.message);
      videoWrap.style.opacity = '1';
    });
  }

  function setupVideoEvents() {
    if (!videoEl) { PL('setupVideoEvents','WARN: videoEl è null, skip'); return; }
    PL('setupVideoEvents', `Registro event listeners su <video id="${videoEl.id}">`);

    // Rimuovi listener precedenti clonando il nodo (evita duplicati su re-open)
    const oldVideo = videoEl;
    const newVideo = oldVideo.cloneNode(true);
    oldVideo.parentNode.replaceChild(newVideo, oldVideo);
    videoEl = newVideo;
    PL('setupVideoEvents', `Video node clonato per evitare listener duplicati`);

    videoEl.addEventListener('loadstart',      (e) => PL('videoEvent', `loadstart — browser ha iniziato a caricare: ${(e.target?.src||'').slice(0,80)}…`));
    videoEl.addEventListener('loadedmetadata', (e) => PL('videoEvent', `loadedmetadata — durata: ${e.target?.duration?.toFixed(1)}s, dimensioni: ${e.target?.videoWidth}x${e.target?.videoHeight}`));
    videoEl.addEventListener('canplay',        ()  => PL('videoEvent', `canplay — buffer sufficiente per iniziare`));
    videoEl.addEventListener('waiting',        ()  => PL('videoEvent', `waiting — buffering in corso…`));
    videoEl.addEventListener('stalled',        ()  => PL('videoEvent', `stalled — rete lenta o server non risponde`));
    videoEl.addEventListener('timeupdate', updateProgress);
    videoEl.addEventListener('progress',   updateBuffered);

    videoEl.addEventListener('play', () => {
      PL('videoEvent', `play — riproduzione avviata ✓`);
      document.getElementById('mv-play-icon').className = 'fas fa-pause';
      startHideControls();
    });
    videoEl.addEventListener('pause', () => {
      PL('videoEvent', `pause — riproduzione in pausa`);
      document.getElementById('mv-play-icon').className = 'fas fa-play';
      clearTimeout(hideControlsTimer);
      showControls();
    });
    videoEl.addEventListener('ended', () => {
      PL('videoEvent', `ended — video terminato`);
      document.getElementById('mv-play-icon').className = 'fas fa-play';
      showControls();
    });

    videoEl.addEventListener('error', (e) => {
      const ve = e.target?.error;
      const codes = { 1:'MEDIA_ERR_ABORTED', 2:'MEDIA_ERR_NETWORK', 3:'MEDIA_ERR_DECODE', 4:'MEDIA_ERR_SRC_NOT_SUPPORTED' };
      const codeStr = ve ? (codes[ve.code] || `code=${ve.code}`) : 'unknown';
      const msg = ve?.message || '';
      console.error(`[player.js · videoEvent] ✗ ERRORE VIDEO — ${codeStr}: ${msg}`);
      console.error(`[player.js · videoEvent]   src era: ${(e.target?.src||'').slice(0,120)}`);
      console.error(`[player.js · videoEvent]   Causa più comune per MEDIA_ERR_NETWORK: CORS bloccato sul CDN`);
      console.error(`[player.js · videoEvent]   Causa più comune per MEDIA_ERR_SRC_NOT_SUPPORTED: formato non supportato o URL non valido`);
      showError(`Errore ${codeStr}${msg ? ': '+msg : ''} — prova a cambiare qualità o usa embed`);
    });

    videoEl.addEventListener('dblclick', toggleFullscreen);

    document.addEventListener('fullscreenchange', () => {
      const icon = document.getElementById('mv-fs-icon');
      if (icon) icon.className = document.fullscreenElement ? 'fas fa-compress' : 'fas fa-expand';
    });

    const overlay = document.getElementById('mv-controls-overlay');
    if (overlay) {
      overlay.addEventListener('mousemove', showAndScheduleHide);
      overlay.addEventListener('touchstart', showAndScheduleHide, { passive: true });
    }

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
    PL('setupVideoEvents', `Tutti i listener registrati ✓`);
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
    PL('open', `══ APRO VIEWER ══ id=${post.id} platform=${post.platform}`);
    PL('open', `URL: ${post.url}`);
    PL('open', `mediaType: ${post.mediaType} — quality: ${currentQuality}p`);

    currentPost = post;
    videoEl = null;
    currentQuality = '720';
    if (document._mvKeyHandler) {
      document.removeEventListener('keydown', document._mvKeyHandler);
      PL('open', 'Rimosso keyHandler precedente');
    }

    viewerContentEl.innerHTML = buildPlayerHTML(post);
    showLoading('Avvio riproduzione…', 'Analisi piattaforma…');

    const { platform, url } = post;

    // Spotify → sempre embed (nessun stream audio diretto disponibile)
    if (platform === 'spotify') {
      PL('open', 'Spotify → embed-only → chiamo _viewerFallbackEmbed');
      cleanup();
      window._viewerFallbackEmbed(post);
      return;
    }

    PL('open', `Chiamo Extractor.extract(url, platform="${platform}", quality="${currentQuality}")`);
    PL('open', `Extractor proverà: fast-path piattaforma → Cobalt → yt-dlp WASM`);

    const result = await Extractor.extract(
      url, platform, currentQuality,
      (msg, sub) => {
        PL('open·progress', `${msg} ${sub||''}`);
        const textEl = document.getElementById('mv-loading-text');
        const subEl  = document.getElementById('mv-loading-sub');
        if (textEl) textEl.textContent = msg;
        if (subEl)  subEl.textContent  = sub || '';
      }
    );

    PL('open', `Extractor.extract() completato — risultato:`, result);

    if (!result) {
      PL('open', 'Risultato null → nessun metodo ha funzionato → mostro errore');
      showError('Nessuno stream trovato. Prova "Usa embed" o apri l\'originale.');
      return;
    }

    if (result.embedOnly) {
      PL('open', `embedOnly=true (${platform}) → fallback embed iframe`);
      cleanup();
      window._viewerFallbackEmbed(post);
      return;
    }

    if (result.picker) {
      PL('open', `Picker con ${result.picker.length} stream → mostro selettore`);
      showPicker(result.picker);
      return;
    }

    if (result.url) {
      PL('open', `URL trovato (${result.url.length} char) → chiamo loadVideoUrl()`);
      PL('open', `IMPORTANTE: URL va nel <video src> SENZA proxy — NO corsproxy, NO allorigins`);
      loadVideoUrl(result.url);
      return;
    }

    PL('open', 'result senza url né picker né embedOnly → mostro errore');
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
