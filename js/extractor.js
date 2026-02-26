/**
 * extractor.js — Universal video URL extractor
 * Strategia per piattaforma:
 *   YouTube   → Invidious API (googlevideo ha CORS nativo ✅)
 *   Vimeo     → player config API via proxy HTML
 *   Reddit    → .json API (CORS nativo ✅)
 *   Instagram → vxinstagram + proxyFetch per leggere la pagina, URL diretto nel <video>
 *   TikTok / Twitter / Facebook / Twitch → Cobalt API
 *   Tutto il resto → Pyodide + yt-dlp (WASM, lazy load ~40MB)
 *
 * IMPORTANTE: gli URL video vengono messi DIRETTAMENTE nel tag <video src>
 * senza passare per corsproxy.io o altri proxy video.
 * I proxy vengono usati SOLO per leggere pagine HTML/JSON.
 */

const Extractor = (() => {

  const LOG_PREFIX = '[extractor.js]';
  function log(fn, msg, data) {
    const out = `${LOG_PREFIX}[${fn}] ${msg}`;
    if (data !== undefined) console.log(out, data); else console.log(out);
  }
  function warn(fn, msg, data) {
    const out = `${LOG_PREFIX}[${fn}] ⚠ ${msg}`;
    if (data !== undefined) console.warn(out, data); else console.warn(out);
  }
  function err(fn, msg, data) {
    const out = `${LOG_PREFIX}[${fn}] ✗ ${msg}`;
    if (data !== undefined) console.error(out, data); else console.error(out);
  }

  // ── CORS Proxy (solo per leggere HTML/JSON — MAI come src di <video>) ──────
  const FETCH_PROXIES = [
    u => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`,
    u => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
    u => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
    u => `https://thingproxy.freeboard.io/fetch/${u}`,
  ];

  async function proxyFetch(targetUrl, asJson = false) {
    const FN = 'proxyFetch';
    log(FN, `Fetch di: ${targetUrl.slice(0,80)}… [modo: ${asJson?'JSON':'text'}]`);
    for (let i = 0; i < FETCH_PROXIES.length; i++) {
      const proxyUrl = FETCH_PROXIES[i](targetUrl);
      log(FN, `Proxy ${i+1}/${FETCH_PROXIES.length}: ${proxyUrl.slice(0,70)}…`);
      try {
        const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(10000) });
        log(FN, `Proxy ${i+1} → HTTP ${res.status}`);
        if (!res.ok) { warn(FN, `Proxy ${i+1} HTTP ${res.status} — salto`); continue; }
        const text = await res.text();
        log(FN, `Proxy ${i+1} → ${text.length} chars ricevuti`);
        try {
          const j = JSON.parse(text);
          if (j?.contents) {
            log(FN, `Proxy ${i+1} → allorigins wrapper, estraggo .contents`);
            return asJson ? JSON.parse(j.contents) : j.contents;
          }
        } catch {}
        if (text.length > 50) {
          log(FN, `Proxy ${i+1} → body diretto OK`);
          return asJson ? JSON.parse(text) : text;
        }
        warn(FN, `Proxy ${i+1} → body troppo corto (${text.length}), salto`);
      } catch (e) { warn(FN, `Proxy ${i+1} eccezione: ${e.message}`); }
    }
    err(FN, `Tutti i proxy falliti per ${targetUrl.slice(0,80)}`);
    return null;
  }

  function decodeHtmlEntities(s) {
    return (s||'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
  }

  // ── YouTube → Invidious API ────────────────────────────────────────────────
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
    log('extractYouTubeId', `URL: ${url.slice(0,60)} → ID: ${m?.[1]||'NON TROVATO'}`);
    return m ? m[1] : null;
  }

  async function extractYouTube(url, quality='720', onProgress) {
    const FN = 'extractYouTube';
    const id = extractYouTubeId(url);
    if (!id) { err(FN,'ID non trovato'); return null; }
    log(FN, `ID=${id} quality=${quality}p, provo ${INVIDIOUS_INSTANCES.length} istanze Invidious`);
    log(FN, `LOGICA: Invidious espone /api/v1/videos/{id} con formatStreams (video+audio combinati). googlevideo.com ha CORS nativo → play diretto`);

    for (let i = 0; i < INVIDIOUS_INSTANCES.length; i++) {
      const instance = INVIDIOUS_INSTANCES[i];
      const apiUrl = `${instance}/api/v1/videos/${id}`;
      onProgress?.(`YouTube · Invidious ${i+1}/${INVIDIOUS_INSTANCES.length}…`);
      log(FN, `Tentativo ${i+1}: ${apiUrl}`);
      try {
        let data = null;
        try {
          log(FN, `Provo fetch diretto (alcune istanze hanno CORS aperto)…`);
          const res = await fetch(apiUrl, { headers:{'Accept':'application/json'}, signal: AbortSignal.timeout(7000) });
          if (res.ok) { data = await res.json(); log(FN, `Fetch diretto OK su ${instance}`); }
        } catch(e) { log(FN, `Fetch diretto fallito (${e.message}), provo via proxyFetch`); }
        if (!data) data = await proxyFetch(apiUrl, true);
        if (!data) { warn(FN, `${instance}: nessun dato`); continue; }

        log(FN, `${instance}: dati ok. formatStreams=${data.formatStreams?.length||0} adaptiveFormats=${data.adaptiveFormats?.length||0}`);
        const streams = (data.formatStreams||[]).filter(f=>f.url && f.type?.includes('video'));
        const qNum = parseInt(quality);
        const best = streams.sort((a,b)=>Math.abs((parseInt(a.quality)||0)-qNum)-Math.abs((parseInt(b.quality)||0)-qNum))[0]
          || data.adaptiveFormats?.find(f=>f.url && f.type?.includes('video'));

        if (best?.url) {
          log(FN, `✓ Stream trovato: quality=${best.quality||'?'} url=${best.url.slice(0,80)}…`);
          log(FN, `NOTA: URL googlevideo.com → CORS nativo → <video src> diretto, NO proxy video`);
          return { url: best.url, quality: best.quality };
        }
        warn(FN, `${instance}: nessun stream usabile`);
      } catch(e) { warn(FN, `${instance} eccezione: ${e.message}`); }
    }
    err(FN, `Tutte le istanze Invidious fallite`);
    return null;
  }

  // ── Vimeo → player config API ─────────────────────────────────────────────
  function extractVimeoId(url) {
    const m = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
    log('extractVimeoId', `ID: ${m?.[1]||'NON TROVATO'}`);
    return m ? m[1] : null;
  }

  async function extractVimeo(url, quality='720', onProgress) {
    const FN = 'extractVimeo';
    const id = extractVimeoId(url);
    if (!id) { err(FN,'ID non trovato'); return null; }
    const configUrl = `https://player.vimeo.com/video/${id}/config`;
    onProgress?.('Vimeo · config API…');
    log(FN, `LOGICA: /config contiene progressive[] (video+audio combinati). vod-progressive.akamaized.net ha CORS → play diretto`);
    log(FN, `Chiamo: ${configUrl}`);

    const data = await proxyFetch(configUrl, true);
    if (!data) { err(FN,'Nessuna risposta config'); return null; }

    const progressive = (data?.request?.files?.progressive||[]).filter(f=>f.url);
    log(FN, `progressive[] trovati: ${progressive.length}`);
    if (progressive.length) {
      const qNum = parseInt(quality);
      const best = progressive.sort((a,b)=>Math.abs((a.quality||0)-qNum)-Math.abs((b.quality||0)-qNum))[0];
      log(FN, `✓ Progressive: ${best.quality}p → ${best.url.slice(0,80)}…`);
      log(FN, `NOTA: URL CDN Vimeo → play diretto, NO proxy video`);
      return { url: best.url, quality: `${best.quality}p` };
    }

    const hls = data?.request?.files?.hls?.cdns;
    if (hls) {
      const cdn = Object.values(hls)[0];
      if (cdn?.url) { log(FN, `✓ HLS: ${cdn.url.slice(0,80)}`); return { url: cdn.url }; }
    }
    err(FN, 'Nessun formato trovato');
    return null;
  }

  // ── Reddit → .json API ───────────────────────────────────────────────────
  async function extractReddit(url, onProgress) {
    const FN = 'extractReddit';
    const cleanUrl = url.replace(/\/$/, '').replace(/\?.*$/, '');
    const jsonUrl = cleanUrl + '.json';
    onProgress?.('Reddit · JSON API…');
    log(FN, `LOGICA: Reddit .json API ha CORS nativo. Cerco media.reddit_video.fallback_url (video senza audio purtroppo)`);
    log(FN, `JSON URL: ${jsonUrl}`);

    let data = null;
    try {
      const res = await fetch(jsonUrl, { headers:{'Accept':'application/json'}, signal: AbortSignal.timeout(8000) });
      if (res.ok) { data = await res.json(); log(FN,'Fetch diretto Reddit OK'); }
    } catch(e) { warn(FN, `Fetch diretto fallito: ${e.message}`); }
    if (!data) data = await proxyFetch(jsonUrl, true);
    if (!data) { err(FN,'Nessun dato JSON'); return null; }

    const post = Array.isArray(data) ? data[0]?.data?.children?.[0]?.data : data?.data?.children?.[0]?.data;
    if (!post) { err(FN,'Struttura JSON inattesa'); return null; }
    log(FN, `Post: "${post.title?.slice(0,50)}"`);

    const rv = post.media?.reddit_video || post.secure_media?.reddit_video;
    if (rv?.fallback_url) {
      const videoUrl = rv.fallback_url.replace('?source=fallback','');
      log(FN, `✓ reddit_video fallback_url: ${videoUrl.slice(0,80)}`);
      log(FN, `AVVISO: solo video senza audio (limitazione v.redd.it). URL diretto → NO proxy video`);
      return { url: videoUrl, note: 'Solo video (senza audio — Reddit)' };
    }

    const direct = (post.url_overridden_by_dest||post.url||'');
    if (direct.match(/\.(mp4|webm|gifv)(\?.*)?$/i)) {
      const final = direct.replace('.gifv','.mp4');
      log(FN, `✓ URL diretto mp4/webm: ${final.slice(0,80)}`);
      return { url: final };
    }
    err(FN, 'Nessun video trovato');
    return null;
  }

  // ── Instagram → vxinstagram + proxyFetch ─────────────────────────────────
  function buildVxUrl(igUrl) {
    try {
      const u = new URL(igUrl);
      const vx = `https://www.vxinstagram.com${u.pathname}`;
      log('buildVxUrl', `${igUrl.slice(0,60)} → ${vx}`);
      return vx;
    } catch(e) { err('buildVxUrl', e.message); return null; }
  }

  function extractSourceFromHtml(html) {
    const FN = 'extractSourceFromHtml';
    log(FN, `Analisi HTML (${html.length} chars)`);

    const src = html.match(/<source[^>]+src=["']([^"']+)["']/i);
    if (src?.[1]) { const u=decodeHtmlEntities(src[1]); log(FN,`✓ <source src>: ${u.slice(0,80)}`); return u; }

    const ogS = html.match(/property=["']og:video:secure_url["'][^>]*content=["']([^"']+)["']/i)
              || html.match(/content=["']([^"']+)["'][^>]*property=["']og:video:secure_url["']/i);
    if (ogS?.[1]) { const u=decodeHtmlEntities(ogS[1]); log(FN,`✓ og:video:secure_url: ${u.slice(0,80)}`); return u; }

    const ogV = html.match(/property=["']og:video["'][^>]*content=["']([^"']+)["']/i)
              || html.match(/content=["']([^"']+)["'][^>]*property=["']og:video["']/i);
    if (ogV?.[1]) { const u=decodeHtmlEntities(ogV[1]); log(FN,`✓ og:video: ${u.slice(0,80)}`); return u; }

    err(FN, 'Nessun URL trovato. Pattern cercati: <source src>, og:video:secure_url, og:video');
    return null;
  }

  async function extractInstagram(url, onProgress) {
    const FN = 'extractInstagram';
    log(FN, `=== Estrazione Instagram ===`);
    log(FN, `LOGICA: 1) converti URL in vxinstagram, 2) leggi HTML via proxyFetch, 3) estrai <source src>, 4) <video src> diretto`);
    log(FN, `URL originale: ${url}`);

    const vxUrl = buildVxUrl(url);
    if (!vxUrl) { err(FN, 'buildVxUrl fallito'); return null; }

    onProgress?.('Instagram · vxinstagram…');
    log(FN, `proxyFetch su: ${vxUrl}`);
    const html = await proxyFetch(vxUrl);
    if (!html) { err(FN, 'proxyFetch restituito null'); return null; }

    log(FN, `HTML ricevuto (${html.length} chars), estraggo URL video…`);
    const rawUrl = extractSourceFromHtml(html);
    if (!rawUrl) { err(FN, 'Nessun URL estratto dall\'HTML'); return null; }

    log(FN, `✓ URL estratto: ${rawUrl.slice(0,100)}…`);
    log(FN, `NOTA: URL messo DIRETTAMENTE in <video src> — NO corsproxy, NO allorigins`);
    return { url: rawUrl };
  }

  // ── Cobalt API ────────────────────────────────────────────────────────────
  const COBALT_INSTANCES = [
    'https://api.cobalt.tools',
    'https://cobalt.api.timelessnesses.me',
    'https://cobalt.catto.zip',
    'https://co.wuk.sh',
  ];

  async function extractViaCobalt(url, quality='720', onProgress) {
    const FN = 'extractViaCobalt';
    log(FN, `=== Cobalt API ===`);
    log(FN, `LOGICA: POST JSON con {url, videoQuality}. Risposta: stream/redirect/tunnel=URL diretto; picker=più video`);
    log(FN, `URL: ${url}, quality: ${quality}p, istanze: ${COBALT_INSTANCES.length}`);

    for (let i = 0; i < COBALT_INSTANCES.length; i++) {
      const instance = COBALT_INSTANCES[i];
      onProgress?.(`Cobalt ${i+1}/${COBALT_INSTANCES.length}…`);
      log(FN, `Tentativo ${i+1}: ${instance}`);
      try {
        const res = await fetch(instance, {
          method: 'POST',
          headers: {'Accept':'application/json','Content-Type':'application/json'},
          body: JSON.stringify({ url, videoQuality:quality, audioFormat:'mp3', filenameStyle:'basic', downloadMode:'auto', twitterGif:false }),
          signal: AbortSignal.timeout(9000),
        });
        log(FN, `${instance} → HTTP ${res.status}`);
        if (!res.ok) { warn(FN, `HTTP ${res.status} — salto`); continue; }

        const data = await res.json();
        log(FN, `Risposta Cobalt: status="${data.status}"`, data.url ? {url: data.url.slice(0,80)} : '');

        if (data.status === 'error') { warn(FN, `Cobalt errore: ${data.error?.code}`); continue; }

        if (['stream','redirect','tunnel'].includes(data.status)) {
          log(FN, `✓ URL diretto (${data.status}): ${data.url?.slice(0,80)}…`);
          log(FN, `NOTA: URL Cobalt messo direttamente in <video src> — NO proxy video`);
          return { url: data.url };
        }

        if (data.status === 'picker' && data.picker?.length) {
          log(FN, `✓ Picker con ${data.picker.length} elementi`);
          return { picker: data.picker.map(item=>({url:item.url, thumb:item.thumb})) };
        }
        warn(FN, `Status inatteso: "${data.status}"`);
      } catch(e) { warn(FN, `${instance} eccezione: ${e.message}`); }
    }
    err(FN, `Tutte le ${COBALT_INSTANCES.length} istanze Cobalt fallite`);
    return null;
  }

  // ── Pyodide + yt-dlp (WASM) ──────────────────────────────────────────────
  let _pyodide = null, _pyodideLoading = false, _pyodideCallbacks = [], _ytdlpReady = false;
  const PYODIDE_CDN = 'https://cdn.jsdelivr.net/pyodide/v0.27.4/full/pyodide.js';

  async function loadPyodide(onProgress) {
    const FN = 'loadPyodide';
    if (_pyodide && _ytdlpReady) { log(FN,'Già pronto'); return _pyodide; }
    if (_pyodideLoading) { log(FN,'In caricamento, attendo…'); return new Promise(r=>_pyodideCallbacks.push(r)); }
    _pyodideLoading = true;
    log(FN, `=== Caricamento Pyodide + yt-dlp ===`);
    log(FN, `LOGICA: Python WASM nel browser. urllib patchato con CORS proxy chain. yt-dlp supporta 1000+ siti.`);
    onProgress?.('Caricamento Pyodide WASM…', 'Prima volta ~40MB, poi in cache');

    if (!window.loadPyodide) {
      log(FN, `Inserisco <script src="${PYODIDE_CDN}">…`);
      await new Promise((resolve,reject)=>{
        const s=document.createElement('script'); s.src=PYODIDE_CDN;
        s.onload=()=>{log(FN,'Script Pyodide caricato');resolve()};
        s.onerror=(e)=>{err(FN,'Script fallito',e);reject(e)};
        document.head.appendChild(s);
      });
    }

    log(FN, 'Inizializzo ambiente Python WASM…');
    onProgress?.('Inizializzazione Python WASM…','');
    _pyodide = await window.loadPyodide({ indexURL:'https://cdn.jsdelivr.net/pyodide/v0.27.4/full/' });
    log(FN, 'Python: '+_pyodide.runPython('import sys; sys.version'));

    log(FN, 'Installo micropip e yt-dlp…');
    onProgress?.('Installazione yt-dlp…','Download pacchetto Python puro');
    await _pyodide.loadPackage('micropip');
    await _pyodide.runPythonAsync(`import micropip\nawait micropip.install('yt-dlp')\nprint('[Pyodide] yt-dlp installato')`);

    log(FN, 'Patching urllib.urlopen con CORS proxy chain…');
    log(FN, 'LOGICA: yt-dlp usa urllib internamente. Ogni richiesta HTTP viene instradata tramite corsproxy/allorigins.');
    await _pyodide.runPythonAsync(`
import urllib.request as _ur, urllib.parse as _up, urllib.error
_PROXIES = ["https://corsproxy.io/?url=","https://api.allorigins.win/raw?url=","https://thingproxy.freeboard.io/fetch/"]
_orig = _ur.urlopen
def _patched(url_or_req, data=None, timeout=30, **kw):
    raw = url_or_req if isinstance(url_or_req,str) else url_or_req.full_url
    print(f'[urllib] intercettato: {raw[:80]}')
    last = None
    for p in _PROXIES:
        pu = p + _up.quote(raw,safe='')
        print(f'[urllib] provo: {pu[:80]}')
        try:
            if isinstance(url_or_req,str): return _orig(pu,data=data,timeout=timeout)
            nr = _ur.Request(pu,data=url_or_req.data,headers=dict(url_or_req.headers),method=url_or_req.get_method())
            return _orig(nr,timeout=timeout)
        except Exception as e:
            print(f'[urllib] proxy fallito: {e}'); last=e
    raise last or urllib.error.URLError('Tutti i proxy falliti')
_ur.urlopen = _patched
print('[urllib] patch applicata')
`);

    _ytdlpReady = true; _pyodideLoading = false;
    log(FN, '=== Pyodide + yt-dlp PRONTI ===');
    _pyodideCallbacks.forEach(cb=>cb(_pyodide)); _pyodideCallbacks=[];
    return _pyodide;
  }

  async function extractWithYtDlp(url, quality='720', onProgress) {
    const FN = 'extractWithYtDlp';
    log(FN, `=== yt-dlp WASM ===`);
    log(FN, `URL: ${url}, quality: ${quality}p`);
    log(FN, `LOGICA: Pyodide esegue Python nel browser. yt-dlp chiama urllib patchato con CORS proxy. URL CDN risultante → <video src> diretto.`);
    onProgress?.('yt-dlp WASM…', 'Prima volta ~40-60s, poi in cache');

    let pyodide;
    try { pyodide = await loadPyodide(onProgress); }
    catch(e) { err(FN,`loadPyodide fallito: ${e.message}`); return null; }

    onProgress?.('yt-dlp in esecuzione…', url.slice(0,50)+'…');
    log(FN, `Avvio script Python per: ${url}`);
    pyodide.globals.set('_target_url', url);
    pyodide.globals.set('_quality', quality);

    try {
      const resultJson = await pyodide.runPythonAsync(`
import yt_dlp, json, sys
print(f'[yt-dlp] URL: {_target_url}')
print(f'[yt-dlp] quality: {_quality}p')
_ydl_opts = {'quiet':False,'no_warnings':False,'format':f'bestvideo[height<={_quality}]+bestaudio/best[height<={_quality}]/best','noplaylist':True,'socket_timeout':20}
_result = None
try:
    with yt_dlp.YoutubeDL(_ydl_opts) as ydl:
        info = ydl.extract_info(_target_url, download=False)
        formats = info.get('formats',[info])
        print(f'[yt-dlp] formati trovati: {len(formats)}')
        best = None
        for f in reversed(formats):
            if f.get('url') and f.get('vcodec','none')!='none': best=f; break
        if not best and formats: best=formats[-1]
        if best: print(f'[yt-dlp] scelto: {best.get("height","?")}p ext={best.get("ext","?")} url={best.get("url","")[:80]}')
        _result = json.dumps({'url':best.get('url') if best else info.get('url'),'ext':best.get('ext','mp4') if best else 'mp4','quality':str(best.get('height','?'))+'p' if best and best.get('height') else '?'})
except Exception as e:
    print(f'[yt-dlp] ERRORE: {e}',file=sys.stderr)
    _result = json.dumps({'error':str(e)})
_result
`);
      const result = JSON.parse(resultJson);
      log(FN, 'Risultato Python:', result);
      if (result.error) { err(FN, `yt-dlp errore: ${result.error}`); return null; }
      if (!result.url) { err(FN, 'Nessun URL nel risultato'); return null; }
      log(FN, `✓ Estratto: ${result.quality} → ${result.url.slice(0,80)}…`);
      log(FN, `NOTA: URL CDN → <video src> diretto, NO proxy video`);
      return { url: result.url, quality: result.quality };
    } catch(e) { err(FN, `Errore Python: ${e.message}`, e); return null; }
  }

  // ── ROUTER PRINCIPALE ────────────────────────────────────────────────────
  const EMBED_ONLY = ['spotify','twitch'];
  const COBALT_PLATFORMS = ['tiktok','twitter','facebook'];

  async function extract(url, platform, quality='720', onProgress) {
    const FN = 'extract';
    log(FN, `════ NUOVA ESTRAZIONE ════`);
    log(FN, `URL: ${url}`);
    log(FN, `Piattaforma: ${platform} | Qualità: ${quality}p`);

    if (/\.(mp4|webm|mov|ogg|m3u8|ts)(\?.*)?$/i.test(url)) {
      log(FN, `PERCORSO: file diretto → play immediato`); return { url };
    }
    if (EMBED_ONLY.includes(platform)) {
      log(FN, `PERCORSO: ${platform} → embed-only`); return { embedOnly:true };
    }
    if (platform==='youtube' || /youtu\.?be/.test(url)) {
      log(FN, `PERCORSO: YouTube → Invidious → yt-dlp`);
      onProgress?.('YouTube · Invidious…');
      const r = await extractYouTube(url, quality, onProgress);
      if (r) { log(FN,'✓ YouTube via Invidious'); return r; }
      log(FN,'Invidious fallito → yt-dlp');
      return extractWithYtDlp(url, quality, onProgress);
    }
    if (platform==='vimeo' || url.includes('vimeo.com')) {
      log(FN, `PERCORSO: Vimeo → config API → yt-dlp`);
      const r = await extractVimeo(url, quality, onProgress);
      if (r) { log(FN,'✓ Vimeo via config API'); return r; }
      return extractWithYtDlp(url, quality, onProgress);
    }
    if (platform==='reddit' || url.includes('reddit.com')) {
      log(FN, `PERCORSO: Reddit → .json API → Cobalt`);
      const r = await extractReddit(url, onProgress);
      if (r) { log(FN,'✓ Reddit via JSON API'); return r; }
      return extractViaCobalt(url, quality, onProgress);
    }
    if (platform==='instagram' || /instagram\.com\/(reels?|p|tv|stories|share)\//.test(url)) {
      log(FN, `PERCORSO: Instagram → vxinstagram → Cobalt → embedOnly`);
      const r = await extractInstagram(url, onProgress);
      if (r) { log(FN,'✓ Instagram via vxinstagram'); return r; }
      const c = await extractViaCobalt(url, quality, onProgress);
      if (c) { log(FN,'✓ Instagram via Cobalt'); return c; }
      log(FN,'Tutti falliti → embedOnly iframe vxinstagram');
      return { embedOnly:true };
    }
    if (COBALT_PLATFORMS.includes(platform)) {
      log(FN, `PERCORSO: ${platform} → Cobalt → yt-dlp`);
      const r = await extractViaCobalt(url, quality, onProgress);
      if (r) { log(FN,`✓ ${platform} via Cobalt`); return r; }
      return extractWithYtDlp(url, quality, onProgress);
    }
    log(FN, `PERCORSO: piattaforma "${platform}" senza fast-path → yt-dlp universale`);
    return extractWithYtDlp(url, quality, onProgress);
  }

  function preloadPyodide() {
    if (_pyodide||_pyodideLoading) return;
    log('preloadPyodide','Pre-caricamento in background (idle)…');
    setTimeout(()=>loadPyodide(()=>{}), 5000);
  }

  function getVxInstagramUrl(url) { return buildVxUrl(url); }

  return { extract, preloadPyodide, getVxInstagramUrl, extractViaCobalt };
})();
