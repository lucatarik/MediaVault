/**
 * Extractor — Universal video/audio URL extractor
 *
 * Strategia per piattaforma:
 *  YouTube   → Invidious API  (CDN googlevideo ha CORS nativo ✅)
 *  Vimeo     → player config API via proxy
 *  Reddit    → .json API (CORS nativo ✅)
 *  Instagram → vxinstagram + corsproxy chain
 *  TikTok    → Cobalt API
 *  Twitter/X → Cobalt API
 *  Facebook  → Cobalt API
 *  Twitch    → Cobalt API
 *  Spotify   → embed iframe (nessun audio diretto)
 *  Tutto il resto → Pyodide + yt-dlp (WASM, lazy load, ~40MB)
 */

const Extractor = (() => {

  // ═══════════════════════════════════════════════════════════════════════════
  //  CORS PROXY UTILITIES
  // ═══════════════════════════════════════════════════════════════════════════

  // Proxy per leggere pagine HTML / JSON (restituiscono il body)
  const FETCH_PROXIES = [
    u => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`,
    u => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
    u => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
    u => `https://thingproxy.freeboard.io/fetch/${u}`,
  ];

  // Proxy per wrappare URL video come <video src> (seguono redirect, aggiungono CORS)
  const VIDEO_PROXIES = [
    u => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
    u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    u => `https://thingproxy.freeboard.io/fetch/${u}`,
  ];

  // Fetcha HTML/JSON di una pagina tramite proxy chain
  async function proxyFetch(targetUrl, asJson = false) {
    for (const buildProxy of FETCH_PROXIES) {
      try {
        const res = await fetch(buildProxy(targetUrl), {
          signal: AbortSignal.timeout(9000),
        });
        if (!res.ok) continue;
        const text = await res.text();
        // allorigins wrappa in { contents, status }
        try {
          const j = JSON.parse(text);
          if (j?.contents) return asJson ? JSON.parse(j.contents) : j.contents;
          if (j?.status?.http_code === 200 && j.contents) return asJson ? JSON.parse(j.contents) : j.contents;
        } catch {}
        // risposta diretta (corsproxy, codetabs, thingproxy)
        if (text.length > 50) return asJson ? JSON.parse(text) : text;
      } catch (e) {
        console.warn(`[proxy] fetch fallito per ${targetUrl.slice(0,40)}:`, e.message);
      }
    }
    return null;
  }

  // Wrappa un URL video con proxy (con HEAD probe per verificare)
  async function proxyVideoUrl(rawUrl) {
    if (!rawUrl) return null;
    for (const buildProxy of VIDEO_PROXIES) {
      const proxied = buildProxy(rawUrl);
      try {
        const probe = await fetch(proxied, {
          method: 'HEAD',
          signal: AbortSignal.timeout(5000),
        });
        if (probe.ok || probe.status === 206 || probe.status === 302) {
          return proxied;
        }
      } catch {}
    }
    // HEAD fallito per tutti → restituisce comunque corsproxy (alcuni non supportano HEAD)
    return VIDEO_PROXIES[0](rawUrl);
  }

  function decodeHtmlEntities(str) {
    return (str || '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  YOUTUBE  — Invidious API
  //  Le URL googlevideo.com hanno CORS nativo → nessun video proxy necessario
  // ═══════════════════════════════════════════════════════════════════════════

  const INVIDIOUS_INSTANCES = [
    'https://inv.nadeko.net',
    'https://invidious.privacydev.net',
    'https://yt.artemislena.eu',
    'https://invidious.flokinet.to',
    'https://iv.melmac.space',
    'https://invidious.nerdvpn.de',
  ];

  function extractYouTubeId(url) {
    const m = url.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
  }

  async function extractYouTube(url, quality = '720', onProgress) {
    const id = extractYouTubeId(url);
    if (!id) return null;

    for (const instance of INVIDIOUS_INSTANCES) {
      onProgress?.(`YouTube via ${instance.replace('https://', '')}…`);
      try {
        const apiUrl = `${instance}/api/v1/videos/${id}`;
        const data = await proxyFetch(apiUrl, true);
        if (!data) continue;

        // adaptiveFormats = solo video o solo audio (separati)
        // formatStreams = video+audio combinati (preferibili)
        const streams = (data.formatStreams || []);
        const adaptive = (data.adaptiveFormats || []);

        // Cerca il formato combinato video+audio alla qualità desiderata
        const qualityNum = parseInt(quality);
        const sorted = streams
          .filter(f => f.url && f.type?.includes('video'))
          .sort((a, b) => {
            const qa = parseInt(a.quality) || 0;
            const qb = parseInt(b.quality) || 0;
            // preferisce la qualità più vicina a quella richiesta senza superarla
            const da = Math.abs(qa - qualityNum);
            const db = Math.abs(qb - qualityNum);
            return da - db;
          });

        const best = sorted[0] || streams[0] || adaptive.find(f => f.url && f.type?.includes('video'));
        if (best?.url) {
          // googlevideo.com supporta CORS nativo — nessun proxy video necessario
          console.log(`[YT] Stream trovato via ${instance}: ${best.quality || '?'}`);
          return { url: best.url, needsProxy: false, quality: best.quality };
        }
      } catch (e) {
        console.warn(`[YT] ${instance} fallito:`, e.message);
      }
    }
    return null;
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  VIMEO  — player config endpoint
  // ═══════════════════════════════════════════════════════════════════════════

  function extractVimeoId(url) {
    const m = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
    return m ? m[1] : null;
  }

  async function extractVimeo(url, quality = '720', onProgress) {
    const id = extractVimeoId(url);
    if (!id) return null;

    onProgress?.('Vimeo config API…');
    try {
      const configUrl = `https://player.vimeo.com/video/${id}/config`;
      const data = await proxyFetch(configUrl, true);
      if (!data) return null;

      const files = data?.request?.files;
      if (!files) return null;

      // Progressive download files (video+audio combined)
      const progressive = files.progressive || [];
      if (progressive.length > 0) {
        const qualityNum = parseInt(quality);
        const sorted = progressive.sort((a, b) => {
          return Math.abs((a.quality||0) - qualityNum) - Math.abs((b.quality||0) - qualityNum);
        });
        const best = sorted[0];
        if (best?.url) {
          console.log(`[Vimeo] Stream trovato: ${best.quality}p`);
          const proxied = await proxyVideoUrl(best.url);
          return { url: proxied, needsProxy: true };
        }
      }

      // HLS fallback
      const hls = files.hls?.cdns;
      if (hls) {
        const cdn = Object.values(hls)[0];
        if (cdn?.url) {
          const proxied = await proxyVideoUrl(cdn.url);
          return { url: proxied, needsProxy: true };
        }
      }
    } catch (e) {
      console.warn('[Vimeo] Estrazione fallita:', e.message);
    }
    return null;
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  REDDIT  — .json API (CORS nativo ✅)
  // ═══════════════════════════════════════════════════════════════════════════

  async function extractReddit(url, onProgress) {
    onProgress?.('Reddit JSON API…');
    try {
      // Normalizza URL e aggiungi .json
      const cleanUrl = url.replace(/\/$/, '').replace(/\?.*$/, '');
      const jsonUrl = cleanUrl + '.json';

      // Reddit permette CORS direttamente
      let data = null;
      try {
        const res = await fetch(jsonUrl, {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) data = await res.json();
      } catch {}

      // Fallback via proxy
      if (!data) data = await proxyFetch(jsonUrl, true);
      if (!data) return null;

      const post = Array.isArray(data) ? data[0]?.data?.children?.[0]?.data : data?.data?.children?.[0]?.data;
      if (!post) return null;

      // reddit_video
      const redditVideo = post.media?.reddit_video || post.secure_media?.reddit_video;
      if (redditVideo?.fallback_url) {
        // fallback_url è il video senza audio — prova a ottenere anche l'audio
        const videoUrl = redditVideo.fallback_url.replace('?source=fallback', '');
        const proxied = await proxyVideoUrl(videoUrl);
        console.log('[Reddit] Video trovato:', videoUrl.slice(0, 60));
        return { url: proxied, needsProxy: true };
      }

      // Direct URL
      const directUrl = post.url_overridden_by_dest || post.url;
      if (directUrl?.match(/\.(mp4|webm|gifv)(\?.*)?$/i)) {
        const finalUrl = directUrl.replace('.gifv', '.mp4');
        const proxied = await proxyVideoUrl(finalUrl);
        return { url: proxied, needsProxy: true };
      }

      // Imgur gifv
      if (directUrl?.includes('imgur.com') && directUrl.includes('.gifv')) {
        const mp4 = directUrl.replace('.gifv', '.mp4');
        const proxied = await proxyVideoUrl(mp4);
        return { url: proxied, needsProxy: true };
      }

    } catch (e) {
      console.warn('[Reddit] Estrazione fallita:', e.message);
    }
    return null;
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  INSTAGRAM  — vxinstagram + corsproxy
  // ═══════════════════════════════════════════════════════════════════════════

  function buildVxUrl(igUrl) {
    try {
      const u = new URL(igUrl);
      return `https://www.vxinstagram.com${u.pathname}`;
    } catch { return null; }
  }

  function extractSourceFromHtml(html) {
    const t = (s) => decodeHtmlEntities(s);

    // <source src="...">  — il più diretto dalla pagina vxinstagram
    const src = html.match(/<source[^>]+src=["']([^"']+)["']/i);
    if (src?.[1]) return t(src[1]);

    // og:video:secure_url
    const ogS = html.match(/property=["']og:video:secure_url["'][^>]*content=["']([^"']+)["']/i)
              || html.match(/content=["']([^"']+)["'][^>]*property=["']og:video:secure_url["']/i);
    if (ogS?.[1]) return t(ogS[1]);

    // og:video
    const ogV = html.match(/property=["']og:video["'][^>]*content=["']([^"']+)["']/i)
              || html.match(/content=["']([^"']+)["'][^>]*property=["']og:video["']/i);
    if (ogV?.[1]) return t(ogV[1]);

    return null;
  }

  async function extractInstagram(url, onProgress) {
    const vxUrl = buildVxUrl(url);
    if (!vxUrl) return null;

    onProgress?.('vxinstagram…');
    const html = await proxyFetch(vxUrl);
    if (!html) return null;

    const rawUrl = extractSourceFromHtml(html);
    if (!rawUrl) return null;

    onProgress?.('CORS proxy per il video…');
    const proxied = await proxyVideoUrl(rawUrl);
    return { url: proxied, needsProxy: true };
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  COBALT API  — TikTok, Twitter/X, Facebook, Twitch, + fallback generale
  // ═══════════════════════════════════════════════════════════════════════════

  const COBALT_INSTANCES = [
    'https://api.cobalt.tools',
    'https://cobalt.api.timelessnesses.me',
    'https://cobalt.catto.zip',
    'https://co.wuk.sh',
  ];

  async function extractViaCobalt(url, quality = '720', onProgress) {
    for (const instance of COBALT_INSTANCES) {
      onProgress?.(`Cobalt (${instance.replace('https://','').split('.')[0]})…`);
      try {
        const res = await fetch(instance, {
          method: 'POST',
          headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url, videoQuality: quality,
            audioFormat: 'mp3', filenameStyle: 'basic',
            downloadMode: 'auto', twitterGif: false,
          }),
          signal: AbortSignal.timeout(9000),
        });
        if (!res.ok) continue;
        const data = await res.json();

        if (data.status === 'error') continue;
        if (data.status === 'stream' || data.status === 'redirect' || data.status === 'tunnel') {
          // Cobalt restituisce URL già accessibili (spesso non richiedono proxy)
          const proxied = await proxyVideoUrl(data.url);
          return { url: proxied || data.url, needsProxy: true };
        }
        if (data.status === 'picker' && data.picker?.length) {
          return {
            picker: data.picker.map(i => ({
              url: i.url,
              thumb: i.thumb,
            })),
          };
        }
      } catch (e) {
        console.warn(`[Cobalt] ${instance} fallito:`, e.message);
      }
    }
    return null;
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  PYODIDE + yt-dlp  — Fallback universale (WASM, lazy load ~40MB)
  // ═══════════════════════════════════════════════════════════════════════════

  let _pyodide = null;
  let _pyodideLoading = false;
  let _pyodideLoadCallbacks = [];
  let _ytdlpReady = false;

  const PYODIDE_CDN = 'https://cdn.jsdelivr.net/pyodide/v0.27.4/full/pyodide.js';

  async function loadPyodide(onProgress) {
    if (_pyodide && _ytdlpReady) return _pyodide;

    // Se già in caricamento, aspetta
    if (_pyodideLoading) {
      return new Promise((resolve) => {
        _pyodideLoadCallbacks.push(resolve);
      });
    }

    _pyodideLoading = true;
    onProgress?.('Caricamento Pyodide (WASM)…', 'Prima volta ~40MB, poi in cache');

    // Carica script Pyodide dinamicamente
    if (!window.loadPyodide) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = PYODIDE_CDN;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
    }

    onProgress?.('Inizializzazione Pyodide…', 'Ambiente Python WASM');
    _pyodide = await window.loadPyodide({
      indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.27.4/full/',
    });

    onProgress?.('Installazione yt-dlp…', 'Via micropip (puro Python)');
    await _pyodide.loadPackage('micropip');
    await _pyodide.runPythonAsync(`
import micropip
await micropip.install('yt-dlp')
print('yt-dlp installato correttamente')
`);

    // Patch urllib per usare CORS proxy su tutte le richieste di yt-dlp
    onProgress?.('Configurazione proxy CORS…', '');
    await _pyodide.runPythonAsync(`
import urllib.request as _ur
import urllib.parse as _up
import urllib.error

_CORS_PROXIES = [
    "https://corsproxy.io/?url=",
    "https://api.allorigins.win/raw?url=",
    "https://thingproxy.freeboard.io/fetch/",
]
_proxy_idx = [0]
_orig_urlopen = _ur.urlopen
_orig_opener = _ur.build_opener

def _make_proxied(url_or_req):
    proxy = _CORS_PROXIES[_proxy_idx[0] % len(_CORS_PROXIES)]
    if isinstance(url_or_req, str):
        return proxy + _up.quote(url_or_req, safe='')
    elif hasattr(url_or_req, 'full_url'):
        req = url_or_req
        new_url = proxy + _up.quote(req.full_url, safe='')
        new_req = _ur.Request(
            new_url,
            data=req.data,
            headers=dict(req.headers),
            method=req.get_method(),
        )
        return new_req
    return url_or_req

def _proxied_urlopen(url_or_req, data=None, timeout=30, **kwargs):
    tries = 0
    last_err = None
    while tries < len(_CORS_PROXIES):
        _proxy_idx[0] = tries
        try:
            proxied = _make_proxied(url_or_req)
            return _orig_urlopen(proxied, data=data, timeout=timeout)
        except Exception as e:
            last_err = e
            tries += 1
    raise last_err or urllib.error.URLError("All proxies failed")

_ur.urlopen = _proxied_urlopen
print('urllib patched con CORS proxy')
`);

    _ytdlpReady = true;
    _pyodideLoading = false;

    // Risolvi le callback in attesa
    _pyodideLoadCallbacks.forEach(cb => cb(_pyodide));
    _pyodideLoadCallbacks = [];

    return _pyodide;
  }

  async function extractWithYtDlp(url, quality = '720', onProgress) {
    onProgress?.('Caricamento Pyodide + yt-dlp…', 'Potrebbe richiedere 30-60s alla prima apertura');

    let pyodide;
    try {
      pyodide = await loadPyodide(onProgress);
    } catch (e) {
      console.error('[yt-dlp] Pyodide load failed:', e);
      return null;
    }

    onProgress?.('yt-dlp in esecuzione…', url.slice(0, 50) + '…');

    // Imposta variabili globali in Pyodide
    pyodide.globals.set('_target_url', url);
    pyodide.globals.set('_quality', quality);

    try {
      const resultJson = await pyodide.runPythonAsync(`
import yt_dlp, json

_ydl_opts = {
    'quiet': True,
    'no_warnings': True,
    'format': f'bestvideo[height<={_quality}]+bestaudio/best[height<={_quality}]/best',
    'noplaylist': True,
}

_result = None
try:
    with yt_dlp.YoutubeDL(_ydl_opts) as ydl:
        info = ydl.extract_info(_target_url, download=False)
        
        # Cerca il miglior formato
        formats = info.get('formats', [info])
        best = None
        for f in reversed(formats):
            if f.get('url') and f.get('vcodec', 'none') != 'none':
                best = f
                break
        if not best:
            best = formats[-1] if formats else None
        
        _result = json.dumps({
            'url': best.get('url') if best else info.get('url'),
            'ext': best.get('ext', 'mp4') if best else 'mp4',
            'title': info.get('title', ''),
            'thumbnail': info.get('thumbnail', ''),
            'quality': str(best.get('height', '')) + 'p' if best and best.get('height') else '?',
        })
except Exception as e:
    _result = json.dumps({'error': str(e)})

_result
`);

      const result = JSON.parse(resultJson);
      if (result.error) {
        console.warn('[yt-dlp] Estrazione fallita:', result.error);
        return null;
      }
      if (!result.url) return null;

      console.log(`[yt-dlp] Estratto ${result.quality}: ${result.url.slice(0, 80)}…`);

      // Wrappa con proxy video se necessario
      const proxied = await proxyVideoUrl(result.url);
      return { url: proxied || result.url, needsProxy: true, quality: result.quality };

    } catch (e) {
      console.error('[yt-dlp] Errore Python:', e);
      return null;
    }
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  ROUTER PRINCIPALE
  // ═══════════════════════════════════════════════════════════════════════════

  // Piattaforme per cui usiamo embed iframe (non ha senso estrarre stream)
  const EMBED_ONLY = ['spotify', 'twitch'];

  // Piattaforme gestite da Cobalt prima del fallback yt-dlp
  const COBALT_PLATFORMS = ['tiktok', 'twitter', 'facebook'];

  async function extract(url, platform, quality = '720', onProgress) {
    const notify = (msg, sub = '') => {
      onProgress?.(msg, sub);
      console.log(`[Extractor] ${msg} ${sub}`);
    };

    // ── File diretto (mp4, webm, m3u8 ecc.) ──────────────────────────────
    if (/\.(mp4|webm|mov|ogg|m3u8|ts)(\?.*)?$/i.test(url)) {
      notify('File diretto…');
      return { url, needsProxy: false, direct: true };
    }

    // ── Embed-only ────────────────────────────────────────────────────────
    if (EMBED_ONLY.includes(platform)) {
      return { embedOnly: true };
    }

    // ── YouTube ───────────────────────────────────────────────────────────
    if (platform === 'youtube' || /youtu\.?be/.test(url)) {
      notify('YouTube · Invidious API…');
      const r = await extractYouTube(url, quality, notify);
      if (r) return r;
      notify('YouTube · fallback yt-dlp…');
      return extractWithYtDlp(url, quality, notify);
    }

    // ── Vimeo ─────────────────────────────────────────────────────────────
    if (platform === 'vimeo' || url.includes('vimeo.com')) {
      notify('Vimeo · config API…');
      const r = await extractVimeo(url, quality, notify);
      if (r) return r;
      notify('Vimeo · fallback yt-dlp…');
      return extractWithYtDlp(url, quality, notify);
    }

    // ── Reddit ────────────────────────────────────────────────────────────
    if (platform === 'reddit' || url.includes('reddit.com')) {
      notify('Reddit · JSON API…');
      const r = await extractReddit(url, notify);
      if (r) return r;
      notify('Reddit · fallback Cobalt…');
      return extractViaCobalt(url, quality, notify);
    }

    // ── Instagram ─────────────────────────────────────────────────────────
    if (platform === 'instagram' || /instagram\.com\/(reels?|p|tv|stories|share)\//.test(url)) {
      notify('Instagram · vxinstagram…');
      const r = await extractInstagram(url, notify);
      if (r) return r;
      notify('Instagram · fallback Cobalt…');
      return extractViaCobalt(url, quality, notify);
    }

    // ── Cobalt platforms (TikTok, Twitter, Facebook) ──────────────────────
    if (COBALT_PLATFORMS.includes(platform) || COBALT_PLATFORMS.some(p => url.includes(p))) {
      notify('Cobalt API…');
      const r = await extractViaCobalt(url, quality, notify);
      if (r) return r;
      notify('Fallback yt-dlp…');
      return extractWithYtDlp(url, quality, notify);
    }

    // ── Fallback universale: Pyodide + yt-dlp ────────────────────────────
    notify('yt-dlp universale…', 'Pyodide WASM');
    return extractWithYtDlp(url, quality, notify);
  }

  // Preload Pyodide in background (opzionale, chiamato quando l'app è idle)
  function preloadPyodide() {
    if (_pyodide || _pyodideLoading) return;
    setTimeout(() => loadPyodide(() => {}), 5000);
  }

  // Esponi buildVxUrl per player.js
  function getVxInstagramUrl(url) {
    return buildVxUrl(url);
  }

  return { extract, preloadPyodide, getVxInstagramUrl, extractViaCobalt };

})();
