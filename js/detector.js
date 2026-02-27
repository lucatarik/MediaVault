/**
 * detector.js — Platform detection, metadata fetching, embed URL building
 * File: js/detector.js
 *
 * FLUSSO analyze(url):
 *   1. detectPlatform(url)   → pattern matching su PLATFORM_PATTERNS
 *   2. fetchMetadata(url)    → microlink.io → fallback CF Worker + OG parsing
 *   3. buildEmbedUrl()       → URL iframe per ogni piattaforma
 *   4. buildThumbnailUrl()   → thumbnail diretta (YouTube, immagini)
 *   5. Ritorna oggetto post completo
 *
 * PROXY POLICY: solo CF Worker (mediavault.lucatarik.workers.dev)
 *   allorigins usato come fallback SOLO se Settings → useAlloriginsFallback = true
 */

const MediaDetector = (() => {
  const FILE = 'detector.js';
  const L  = (fn, msg, d) => MV.log(FILE, fn, msg, d);
  const W  = (fn, msg, d) => MV.warn(FILE, fn, msg, d);
  const E  = (fn, msg, d) => MV.error(FILE, fn, msg, d);
  const G  = (fn, t)      => MV.group(FILE, fn, t);
  const GE = ()           => MV.groupEnd();

  const CF_BASE = 'https://mediavault.lucatarik.workers.dev';
  const CF_KEY  = 'supersegreta123';
  const cfUrl   = u => `${CF_BASE}/?url=${encodeURIComponent(u)}&key=${CF_KEY}`;

  // ─── Platform patterns ────────────────────────────────────────────────────
  // Ogni riga: piattaforma, colore brand, classe icon FontAwesome, pattern URL
  const PLATFORM_PATTERNS = [
    { platform: 'youtube',          color: '#FF0000', icon: 'fab fa-youtube',
      patterns: [/youtube\.com\/watch/, /youtube\.com\/shorts/, /youtu\.be\//] },
    { platform: 'instagram',        color: '#E1306C', icon: 'fab fa-instagram',
      patterns: [/instagram\.com\/(p|reels?|tv|stories|share)\//] },
    { platform: 'instagram-profile',color: '#833AB4', icon: 'fab fa-instagram',
      patterns: [/instagram\.com\/(?!p\/|reels?\/|tv\/|stories\/|share\/)[^/]+\/?$/] },
    { platform: 'facebook',         color: '#1877F2', icon: 'fab fa-facebook',
      patterns: [/facebook\.com\//, /fb\.watch\//] },
    { platform: 'twitter',          color: '#1DA1F2', icon: 'fab fa-twitter',
      patterns: [/twitter\.com\//, /x\.com\//] },
    { platform: 'tiktok',           color: '#000000', icon: 'fab fa-tiktok',
      patterns: [/tiktok\.com\//] },
    { platform: 'vimeo',            color: '#1AB7EA', icon: 'fab fa-vimeo',
      patterns: [/vimeo\.com\//] },
    { platform: 'reddit',           color: '#FF4500', icon: 'fab fa-reddit',
      patterns: [/reddit\.com\//] },
    { platform: 'twitch',           color: '#9146FF', icon: 'fab fa-twitch',
      patterns: [/twitch\.tv\//] },
    { platform: 'pinterest',        color: '#E60023', icon: 'fab fa-pinterest',
      patterns: [/pinterest\.(com|it)\//] },
    { platform: 'linkedin',         color: '#0077B5', icon: 'fab fa-linkedin',
      patterns: [/linkedin\.com\//] },
    { platform: 'spotify',          color: '#1DB954', icon: 'fab fa-spotify',
      patterns: [/spotify\.com\//] },
  ];

  const IMAGE_EXT = /\.(jpg|jpeg|png|gif|webp|bmp|svg|avif)(\?.*)?$/i;
  const VIDEO_EXT = /\.(mp4|webm|mov|avi|mkv|ogg)(\?.*)?$/i;

  // ─── detectPlatform ───────────────────────────────────────────────────────
  // Analizza l'URL contro ogni pattern in PLATFORM_PATTERNS.
  // Restituisce { platform, color, icon }.
  function detectPlatform(url) {
    const FN = 'detectPlatform';
    L(FN, `Analisi URL: "${url}"`);
    L(FN, `LOGICA: scorro ${PLATFORM_PATTERNS.length} pattern in ordine fino al primo match`);

    for (const p of PLATFORM_PATTERNS) {
      for (const pattern of p.patterns) {
        const match = pattern.test(url);
        L(FN, `  Pattern "${p.platform}" (${pattern}) → ${match ? '✓ MATCH' : 'no'}`);
        if (match) {
          L(FN, `✓ Piattaforma rilevata: "${p.platform}" color=${p.color}`);
          return { platform: p.platform, color: p.color, icon: p.icon };
        }
      }
    }

    if (IMAGE_EXT.test(url)) {
      L(FN, `✓ Rilevata come immagine diretta (estensione file)`);
      return { platform: 'image', color: '#6C63FF', icon: 'fas fa-image' };
    }
    if (VIDEO_EXT.test(url)) {
      L(FN, `✓ Rilevato come video diretto (estensione file)`);
      return { platform: 'video', color: '#FF6B6B', icon: 'fas fa-video' };
    }

    L(FN, `Nessun pattern corrisponde → platform="web"`);
    return { platform: 'web', color: '#64FFDA', icon: 'fas fa-globe' };
  }

  // ─── ID Extractors ─────────────────────────────────────────────────────────
  function extractYouTubeId(url) {
    const FN = 'extractYouTubeId';
    const patterns = [
      /youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,
      /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
      /youtu\.be\/([a-zA-Z0-9_-]{11})/,
      /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    ];
    for (const p of patterns) {
      const m = url.match(p);
      if (m) { L(FN, `✓ YouTube ID: "${m[1]}" (pattern: ${p})`); return m[1]; }
    }
    W(FN, `Nessun ID YouTube trovato in: "${url}"`);
    return null;
  }

  function extractVimeoId(url) {
    const FN = 'extractVimeoId';
    const m = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
    if (m) { L(FN, `✓ Vimeo ID: "${m[1]}"`); return m[1]; }
    W(FN, `Nessun ID Vimeo in: "${url}"`); return null;
  }

  function extractInstagramId(url) {
    const FN = 'extractInstagramId';
    const m = url.match(/instagram\.com\/(?:p|reels?|tv|share\/(?:p|reel))\/([A-Za-z0-9_-]+)/);
    if (m) { L(FN, `✓ Instagram ID: "${m[1]}"`); return m[1]; }
    W(FN, `Nessun ID Instagram in: "${url}"`); return null;
  }

  function extractInstagramType(url) {
    const FN = 'extractInstagramType';
    if (/instagram\.com\/reels?\//.test(url)) { L(FN,'type=reel'); return 'reel'; }
    if (/instagram\.com\/tv\//.test(url))     { L(FN,'type=tv');   return 'tv'; }
    L(FN,'type=p (default)'); return 'p';
  }

  function extractTikTokId(url) {
    const FN = 'extractTikTokId';
    const m = url.match(/tiktok\.com\/@[^/]+\/video\/(\d+)/);
    if (m) { L(FN, `✓ TikTok ID: "${m[1]}"`); return m[1]; }
    W(FN, `Nessun ID TikTok in: "${url}"`); return null;
  }

  // ─── buildEmbedUrl ────────────────────────────────────────────────────────
  // Costruisce l'URL iframe embed per ogni piattaforma.
  // Usato come FALLBACK quando il player HTML5 non riesce a ottenere lo stream.
  function buildEmbedUrl(url, platform) {
    const FN = 'buildEmbedUrl';
    L(FN, `Costruisco embed URL per platform="${platform}" url="${url.slice(0,60)}"`);

    let result = null;
    switch (platform) {
      case 'youtube': {
        const id = extractYouTubeId(url);
        result = id ? `https://www.youtube.com/embed/${id}?rel=0&modestbranding=1` : null;
        break;
      }
      case 'vimeo': {
        const id = extractVimeoId(url);
        result = id ? `https://player.vimeo.com/video/${id}?dnt=1` : null;
        break;
      }
      case 'instagram': {
        try {
          const u = new URL(url);
          result = `https://www.vxinstagram.com${u.pathname}`;
        } catch { result = null; }
        break;
      }
      case 'facebook': {
        result = `https://www.facebook.com/plugins/post.php?href=${encodeURIComponent(url)}&show_text=true&width=500`;
        break;
      }
      case 'twitter': {
        result = null; // gestito via oEmbed script injection in app.js
        break;
      }
      case 'tiktok': {
        const id = extractTikTokId(url);
        result = id ? `https://www.tiktok.com/embed/v2/${id}` : null;
        break;
      }
      case 'spotify': {
        const m = url.match(/spotify\.com\/(track|album|playlist|episode)\/([a-zA-Z0-9]+)/);
        result = m ? `https://open.spotify.com/embed/${m[1]}/${m[2]}` : null;
        break;
      }
      default:
        result = null;
    }

    if (result) L(FN, `✓ Embed URL: "${result.slice(0,80)}"`);
    else        W(FN, `Nessun embed URL per platform="${platform}"`);
    return result;
  }

  function buildThumbnailUrl(url, platform) {
    const FN = 'buildThumbnailUrl';
    let result = null;
    if (platform === 'youtube') {
      const id = extractYouTubeId(url);
      result = id ? `https://img.youtube.com/vi/${id}/hqdefault.jpg` : null;
    } else if (platform === 'image') {
      result = url;
    }
    L(FN, `platform="${platform}" → thumbnail=${result ? result.slice(0,60)+'…' : 'null'}`);
    return result;
  }

  // ─── fetchMetadata ────────────────────────────────────────────────────────
  // Recupera titolo, descrizione, thumbnail via:
  //   1. microlink.io (JSON API pubblica, nessun CORS)
  //   2. CF Worker + parsing OG tags (fallback)
  //   3. allorigins (solo se useAlloriginsFallback attivo in settings)
  async function fetchMetadata(url) {
    const FN = 'fetchMetadata';
    G(FN, `Fetch metadata per: ${url.slice(0,70)}…`);
    L(FN, `LOGICA: microlink.io → CF Worker+OG → (allorigins se abilitato in settings)`);

    // 1. Microlink.io — JSON API gratuita, CORS aperto
    L(FN, `[1/3] Provo microlink.io API…`);
    try {
      const apiUrl = `https://api.microlink.io/?url=${encodeURIComponent(url)}&meta=true&screenshot=false&video=false`;
      L(FN, `Microlink request: ${apiUrl.slice(0,80)}…`);
      const res = await fetch(apiUrl, { signal: AbortSignal.timeout(7000) });
      L(FN, `Microlink → HTTP ${res.status}`);
      if (res.ok) {
        const data = await res.json();
        L(FN, `Microlink status="${data.status}"`, { title: data.data?.title, desc: data.data?.description?.slice(0,60) });
        if (data.status === 'success') {
          const meta = {
            title:       data.data.title || '',
            description: data.data.description || '',
            thumbnail:   data.data.image?.url || data.data.logo?.url || null,
            author:      data.data.author || '',
            publisher:   data.data.publisher || '',
          };
          L(FN, `✓ Microlink OK — title="${meta.title.slice(0,50)}" thumb=${!!meta.thumbnail}`);
          GE(); return meta;
        }
      }
      W(FN, `Microlink non ha restituito successo (status="${res.status}")`);
    } catch (e) {
      W(FN, `Microlink eccezione: ${e.message} → fallback CF Worker`);
    }

    // 2. CF Worker → scarica HTML → parsa OG tags
    L(FN, `[2/3] Provo CF Worker + OG parsing…`);
    try {
      const proxyUrl = cfUrl(url);
      L(FN, `CF Worker request: ${proxyUrl.slice(0,80)}…`);
      const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(8000) });
      L(FN, `CF Worker → HTTP ${res.status}`);
      if (res.ok) {
        const text = await res.text();
        L(FN, `CF Worker → ${text.length} chars HTML ricevuti`);
        const meta = parseOgTags(text, FN);
        if (meta.title || meta.description) {
          L(FN, `✓ CF Worker OG OK — title="${meta.title.slice(0,50)}" thumb=${!!meta.thumbnail}`);
          GE(); return meta;
        }
        W(FN, `CF Worker: nessun OG tag trovato nell'HTML`);
      }
    } catch (e) {
      W(FN, `CF Worker eccezione: ${e.message}`);
    }

    // 3. allorigins — solo se abilitato in settings
    if (MV.getProxySettings().useAlloriginsFallback) {
      L(FN, `[3/3] useAlloriginsFallback=true → provo allorigins…`);
      try {
        const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
        L(FN, `allorigins: ${proxyUrl.slice(0,80)}…`);
        const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(6000) });
        L(FN, `allorigins → HTTP ${res.status}`);
        if (res.ok) {
          const data = await res.json();
          if (data.contents) {
            const meta = parseOgTags(data.contents, FN);
            L(FN, `✓ allorigins OG — title="${meta.title.slice(0,50)}"`);
            GE(); return meta;
          }
        }
      } catch (e) {
        W(FN, `allorigins fallito: ${e.message}`);
      }
    } else {
      L(FN, `[3/3] allorigins saltato (useAlloriginsFallback=false in settings)`);
    }

    W(FN, `Tutti i metodi metadata falliti → restituisco oggetto vuoto`);
    GE();
    return { title: '', description: '', thumbnail: null, author: '', publisher: '' };
  }

  function parseOgTags(html, callerFn) {
    const FN = 'parseOgTags';
    L(FN, `Parsing OG tags da ${html.length} chars HTML (chiamato da ${callerFn})`);
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const og = (prop) => doc.querySelector(`meta[property="${prop}"]`)?.content || '';
      const meta = (name) => doc.querySelector(`meta[name="${name}"]`)?.content || '';
      const result = {
        title:       og('og:title')       || doc.querySelector('title')?.textContent || '',
        description: og('og:description') || meta('description') || '',
        thumbnail:   og('og:image')       || null,
        author:      og('og:author')      || meta('author') || '',
        publisher:   og('og:site_name')   || '',
      };
      L(FN, `OG result:`, { title: result.title.slice(0,50), thumb: result.thumbnail?.slice(0,50) });
      return result;
    } catch (e) {
      W(FN, `DOMParser fallito: ${e.message}`);
      return { title: '', description: '', thumbnail: null, author: '', publisher: '' };
    }
  }

  // ─── Hashtag extraction ───────────────────────────────────────────────────
  function extractHashtags(text) {
    const FN = 'extractHashtags';
    if (!text) return [];
    const matches = (text.match(/#[\w\u00C0-\u024F]+/g) || []).map(h => h.toLowerCase().replace('#',''));
    L(FN, `"${text.slice(0,60)}…" → [${matches.join(', ')}]`);
    return matches;
  }

  function extractFromUrl(url) {
    try {
      const u = new URL(url);
      const pathParts = u.pathname.split('/').filter(Boolean);
      const hashtags = extractHashtags(u.hash + ' ' + u.search);
      return { pathParts, hashtags };
    } catch { return { pathParts: [], hashtags: [] }; }
  }

  // ─── analyze — funzione principale ───────────────────────────────────────
  // Orchestratore: detectPlatform → fetchMetadata → buildEmbedUrl → ritorna post
  async function analyze(url, onProgress) {
    const FN = 'analyze';
    MV.section(`[detector.js] ANALISI URL: ${url.slice(0,60)}`);
    L(FN, `URL completo: ${url}`);
    L(FN, `FLUSSO: detectPlatform → fetchMetadata → buildEmbedUrl → buildThumbnailUrl → assembla post`);

    onProgress?.('Rilevamento piattaforma…');
    L(FN, `Step 1: detectPlatform…`);
    const platformInfo = detectPlatform(url);
    const { platform } = platformInfo;
    L(FN, `Step 1 OK → platform="${platform}" color="${platformInfo.color}"`);

    onProgress?.('Recupero metadati…');
    L(FN, `Step 2: fetchMetadata…`);
    const meta = await fetchMetadata(url);
    L(FN, `Step 2 OK → title="${meta.title.slice(0,50)}" desc="${meta.description.slice(0,50)}" thumb=${!!meta.thumbnail}`);

    L(FN, `Step 3: buildThumbnailUrl…`);
    const thumbnail = meta.thumbnail || buildThumbnailUrl(url, platform);
    L(FN, `Step 3 OK → thumbnail="${thumbnail?.slice(0,60) || 'null'}"`);

    L(FN, `Step 4: buildEmbedUrl…`);
    const embedUrl = buildEmbedUrl(url, platform);
    L(FN, `Step 4 OK → embedUrl="${embedUrl?.slice(0,70) || 'null'}"`);

    // Determina mediaType
    let mediaType = 'link';
    if (['youtube','vimeo','tiktok','video'].includes(platform)) mediaType = 'video';
    else if (platform === 'image')                               mediaType = 'image';
    else if (['instagram','twitter','facebook'].includes(platform)) mediaType = 'post';
    else if (platform === 'spotify')                             mediaType = 'audio';
    else if (platform === 'reddit')                              mediaType = 'post';
    L(FN, `mediaType = "${mediaType}"`);

    const hashtags = [
      ...extractHashtags(meta.description),
      ...extractHashtags(meta.title),
      ...extractFromUrl(url).hashtags,
    ].filter((v, i, a) => a.indexOf(v) === i).slice(0, 20);
    L(FN, `hashtags (${hashtags.length}): [${hashtags.join(', ')}]`);

    const result = {
      url,
      ...platformInfo,
      mediaType,
      title:       meta.title,
      description: meta.description,
      thumbnail,
      embedUrl,
      author:      meta.author,
      publisher:   meta.publisher,
      hashtags,
      youtubeId:   platform === 'youtube' ? extractYouTubeId(url) : null,
    };

    L(FN, `✓ Analisi completata:`, result);
    MV.groupEnd();
    return result;
  }

  L('init', '✓ MediaDetector pronto');
  return {
    analyze, detectPlatform, extractHashtags,
    buildEmbedUrl, buildThumbnailUrl,
    extractYouTubeId, extractVimeoId,
    extractInstagramId, extractInstagramType, extractTikTokId,
  };
})();
