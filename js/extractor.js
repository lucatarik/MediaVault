/**
 * extractor.js — Universal video/audio URL extractor
 * File: js/extractor.js
 *
 * PROXY POLICY (ASSOLUTA — nessuna eccezione):
 *   ✓ CF Worker: https://mediavault.lucatarik.workers.dev/?url=...&key=supersegreta123
 *   ✓ allorigins: SOLO se Settings → "Usa allorigins come fallback" = attivo
 *   ✗ corsproxy.io: MAI USATO in nessun caso
 *
 * PIPELINE per piattaforma:
 *   YouTube   → [1] Invidious API (googlevideo = CORS nativo, no proxy) → [2] yt-dlp WASM
 *   Vimeo     → [1] player config API + CF Worker → [2] yt-dlp WASM
 *   Reddit    → [1] .json API (CORS nativo) + CF Worker → [2] Cobalt
 *   Instagram → [1] vxinstagram + CF Worker → [2] Cobalt → [3] embedOnly
 *   TikTok/Twitter/Facebook → [1] Cobalt + CF Worker → [2] yt-dlp WASM
 *   Tutto il resto → yt-dlp WASM (Pyodide, lazy load ~40MB, cached)
 */

const Extractor = (() => {
  const FILE = 'extractor.js';
  const L  = (fn, msg, d) => MV.log(FILE, fn, msg, d);
  const W  = (fn, msg, d) => MV.warn(FILE, fn, msg, d);
  const E  = (fn, msg, d) => MV.error(FILE, fn, msg, d);
  const G  = (fn, t)      => MV.group(FILE, fn, t);
  const GE = ()           => MV.groupEnd();

  // ─── CF Worker ─────────────────────────────────────────────────────────────
  const CF_BASE = 'https://mediavault.lucatarik.workers.dev';
  const CF_KEY  = 'supersegreta123';
  const cfUrl   = u => `${CF_BASE}/?url=${encodeURIComponent(u)}&key=${CF_KEY}`;

  L('init', `CF Worker: ${CF_BASE}`);
  L('init', 'POLICY PROXY: CF Worker primario. allorigins = solo se settings.useAlloriginsFallback=true. corsproxy.io = MAI.');

  // ─── Proxy lists (costruite runtime in base alle impostazioni) ─────────────
  // Ogni volta che vengono usate leggiamo le impostazioni aggiornate.
  function buildFetchProxies() {
    const proxies = [{ name: 'CF-Worker', build: u => cfUrl(u) }];
    if (MV.getProxySettings().useAlloriginsFallback) {
      L('buildFetchProxies', 'useAlloriginsFallback=true → aggiungo allorigins e codetabs');
      proxies.push({ name: 'allorigins', build: u => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}` });
      proxies.push({ name: 'codetabs',   build: u => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}` });
    } else {
      L('buildFetchProxies', 'useAlloriginsFallback=false → solo CF Worker');
    }
    return proxies;
  }

  function buildVideoProxies() {
    const proxies = [{ name: 'CF-Worker', build: u => cfUrl(u) }];
    if (MV.getProxySettings().useAlloriginsFallback) {
      L('buildVideoProxies', 'useAlloriginsFallback=true → aggiungo allorigins-raw');
      proxies.push({ name: 'allorigins-raw', build: u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` });
    }
    return proxies;
  }

  // ─── proxyFetch ────────────────────────────────────────────────────────────
  // Legge HTML o JSON di una pagina bypassando CORS.
  // Gestisce il wrapper allorigins {contents:...} e risposte dirette.
  async function proxyFetch(targetUrl, asJson = false) {
    const FN = 'proxyFetch';
    const proxies = buildFetchProxies();
    G(FN, `Fetch "${targetUrl.slice(0,70)}…" [asJson=${asJson}]`);
    L(FN, `LOGICA: provo ogni proxy (${proxies.map(p=>p.name).join(' → ')}) al primo successo restituisco`);

    for (let i = 0; i < proxies.length; i++) {
      const { name, build } = proxies[i];
      const pUrl = build(targetUrl);
      L(FN, `[${i+1}/${proxies.length}] "${name}" → ${pUrl.slice(0,90)}…`);
      try {
        const res = await fetch(pUrl, { signal: AbortSignal.timeout(10000) });
        L(FN, `[${i+1}] "${name}" → HTTP ${res.status} ${res.statusText}`);
        if (!res.ok) { W(FN, `[${i+1}] "${name}" HTTP ${res.status} — prossimo proxy`); continue; }

        const text = await res.text();
        L(FN, `[${i+1}] "${name}" → ${text.length} chars`);
        if (text.length < 50) { W(FN, `[${i+1}] troppo corto (${text.length} chars) — prossimo`); continue; }

        // Allorigins wrappa in { contents: "...", status: { http_code: 200 } }
        try {
          const j = JSON.parse(text);
          if (j?.contents) {
            L(FN, `[${i+1}] "${name}" → wrapper allorigins, .contents = ${j.contents.length} chars`);
            GE(); return asJson ? safeJson(j.contents, FN) : j.contents;
          }
          if (asJson) { L(FN, `[${i+1}] "${name}" → JSON diretto OK`); GE(); return j; }
        } catch {}

        if (asJson) {
          const p = safeJson(text, FN);
          if (p) { L(FN, `[${i+1}] "${name}" → JSON parsato OK`); GE(); return p; }
          W(FN, `[${i+1}] non è JSON — prossimo`); continue;
        }
        L(FN, `[${i+1}] "${name}" → HTML/testo OK ✓`);
        GE(); return text;
      } catch (e) {
        W(FN, `[${i+1}] "${name}" → eccezione: ${e.message}`);
      }
    }
    E(FN, `TUTTI i ${proxies.length} proxy falliti per "${targetUrl.slice(0,80)}"`);
    GE(); return null;
  }

  function safeJson(text, fn) {
    try { return JSON.parse(text); }
    catch (e) { W(fn||'safeJson', `JSON.parse fallito: ${e.message}`); return null; }
  }

  // ─── proxyVideoUrl ─────────────────────────────────────────────────────────
  // Wrappa un URL video con CF Worker per fare da relay CORS al <video src>.
  // HEAD probe per verificare il proxy prima di usarlo.
  // Se HEAD fallisce su CF Worker (non sempre supportato) → usa comunque CF Worker.
  async function proxyVideoUrl(rawUrl) {
    const FN = 'proxyVideoUrl';
    if (!rawUrl) { E(FN,'rawUrl è null/undefined'); return null; }
    const proxies = buildVideoProxies();
    G(FN, `Proxy video "${rawUrl.slice(0,70)}…"`);
    L(FN, `LOGICA: wrappa URL con CORS proxy per <video src>. CF Worker è il proxy primario.`);
    L(FN, `Proxy disponibili: [${proxies.map(p=>p.name).join(', ')}]`);

    for (let i = 0; i < proxies.length; i++) {
      const { name, build } = proxies[i];
      const proxied = build(rawUrl);
      L(FN, `[${i+1}/${proxies.length}] "${name}" HEAD probe…`);
      L(FN, `[${i+1}] Proxied URL: ${proxied.slice(0,90)}…`);
      try {
        const probe = await fetch(proxied, { method:'HEAD', signal: AbortSignal.timeout(6000) });
        L(FN, `[${i+1}] "${name}" HEAD → HTTP ${probe.status}`);
        if (probe.ok || [206,301,302].includes(probe.status)) {
          L(FN, `[${i+1}] "${name}" ✓ probe OK → uso questo proxy`);
          GE(); return proxied;
        }
        W(FN, `[${i+1}] "${name}" HTTP ${probe.status} — prossimo`);
      } catch (e) {
        W(FN, `[${i+1}] "${name}" HEAD eccezione: ${e.message}`);
        if (name === 'CF-Worker') {
          L(FN, `CF-Worker: HEAD fallito (non obbligatorio) → uso l'URL comunque`);
          GE(); return proxied;
        }
      }
    }
    W(FN, `Tutti HEAD falliti → default CF Worker`);
    GE(); return cfUrl(rawUrl);
  }

  // ─── YOUTUBE via Invidious API ─────────────────────────────────────────────
  // Invidious: GET /api/v1/videos/{id} → formatStreams[] (video+audio combinati).
  // URL CDN: googlevideo.com → ha CORS nativo → nessun proxy video necessario.
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
    L('extractYouTubeId', `"${url.slice(0,60)}" → ID=${m?.[1]||'NON TROVATO'}`);
    return m ? m[1] : null;
  }

  async function extractYouTube(url, quality = '720', onProgress) {
    const FN = 'extractYouTube';
    G(FN, `YouTube: ${url} [${quality}p]`);
    L(FN, `LOGICA: Invidious /api/v1/videos/{id} → formatStreams[] → URL googlevideo.com (CORS nativo → no proxy video)`);
    const id = extractYouTubeId(url);
    if (!id) { E(FN,'ID non trovato'); GE(); return null; }
    L(FN, `Video ID: "${id}"`);

    for (let i = 0; i < INVIDIOUS_INSTANCES.length; i++) {
      const inst = INVIDIOUS_INSTANCES[i];
      const apiUrl = `${inst}/api/v1/videos/${id}`;
      onProgress?.(`YouTube · Invidious ${i+1}/${INVIDIOUS_INSTANCES.length}…`);
      L(FN, `[${i+1}/${INVIDIOUS_INSTANCES.length}] Istanza: ${inst}`);
      L(FN, `[${i+1}] API: ${apiUrl}`);
      try {
        let data = null;
        L(FN, `[${i+1}] Provo fetch diretto (alcune istanze hanno CORS aperto)…`);
        try {
          const r = await fetch(apiUrl, { headers:{'Accept':'application/json'}, signal: AbortSignal.timeout(6000) });
          L(FN, `[${i+1}] Fetch diretto → HTTP ${r.status}`);
          if (r.ok) { data = await r.json(); L(FN, `[${i+1}] ✓ Fetch diretto riuscito`); }
          else W(FN, `[${i+1}] HTTP ${r.status} → provo proxyFetch via CF Worker`);
        } catch(e) { W(FN, `[${i+1}] Fetch diretto fallito: ${e.message} → proxyFetch`); }

        if (!data) {
          L(FN, `[${i+1}] Fetch via CF Worker (proxyFetch)…`);
          data = await proxyFetch(apiUrl, true);
        }
        if (!data) { W(FN, `[${i+1}] Nessun dato da ${inst} → prossima istanza`); continue; }

        L(FN, `[${i+1}] Dati ricevuti: title="${data.title?.slice(0,40)}" formatStreams=${data.formatStreams?.length||0} adaptiveFormats=${data.adaptiveFormats?.length||0}`);
        const streams = (data.formatStreams||[]).filter(f=>f.url && f.type?.includes('video'));
        L(FN, `[${i+1}] formatStreams video+audio: ${streams.length}`);
        streams.forEach((s,idx) => L(FN, `  [${idx}] quality=${s.quality} container=${s.container}`));

        const qNum = parseInt(quality);
        const best = streams.sort((a,b)=>Math.abs((parseInt(a.quality)||0)-qNum)-Math.abs((parseInt(b.quality)||0)-qNum))[0]
          || data.adaptiveFormats?.find(f=>f.url && f.type?.includes('video'));

        if (best?.url) {
          L(FN, `✓ SCELTO: quality=${best.quality||'?'} container=${best.container||'?'}`);
          L(FN, `URL googlevideo.com (CORS nativo → <video src> diretto, NO CF Worker): ${best.url.slice(0,100)}…`);
          GE(); return { url: best.url, quality: best.quality, needsProxy: false };
        }
        W(FN, `[${i+1}] Nessuno stream usabile su ${inst}`);
      } catch(e) { E(FN, `[${i+1}] Eccezione: ${e.message}`); }
    }
    E(FN, `TUTTE le ${INVIDIOUS_INSTANCES.length} istanze Invidious fallite`);
    GE(); return null;
  }

  // ─── VIMEO via player config API ──────────────────────────────────────────
  // GET player.vimeo.com/video/{id}/config → progressive[] (video+audio CDN).
  // CDN akamaized.net blocca CORS → CF Worker relay.
  function extractVimeoId(url) {
    const m = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
    L('extractVimeoId', `ID=${m?.[1]||'NON TROVATO'}`);
    return m ? m[1] : null;
  }

  async function extractVimeo(url, quality = '720', onProgress) {
    const FN = 'extractVimeo';
    G(FN, `Vimeo: ${url} [${quality}p]`);
    L(FN, `LOGICA: GET player.vimeo.com/video/{id}/config via CF Worker → progressive[] → CF Worker relay`);
    const id = extractVimeoId(url);
    if (!id) { E(FN,'ID non trovato'); GE(); return null; }

    const configUrl = `https://player.vimeo.com/video/${id}/config`;
    onProgress?.('Vimeo · config API…');
    L(FN, `Config URL: ${configUrl}`);
    L(FN, `Fetch config via proxyFetch (CF Worker)…`);
    const data = await proxyFetch(configUrl, true);
    if (!data) { E(FN,'Nessuna risposta dalla config API'); GE(); return null; }

    L(FN, `Config ricevuta. request.files keys: ${JSON.stringify(Object.keys(data?.request?.files||{}))}`);
    const progressive = (data?.request?.files?.progressive||[]).filter(f=>f.url);
    L(FN, `progressive[] usabili: ${progressive.length}`);
    progressive.forEach((p,i)=>L(FN, `  [${i}] ${p.quality}p → ${p.url?.slice(0,60)}…`));

    if (progressive.length) {
      const qNum = parseInt(quality);
      const best = progressive.sort((a,b)=>Math.abs((a.quality||0)-qNum)-Math.abs((b.quality||0)-qNum))[0];
      L(FN, `✓ SCELTO: ${best.quality}p`);
      L(FN, `CDN Vimeo blocca CORS → CF Worker relay…`);
      const proxied = await proxyVideoUrl(best.url);
      L(FN, `URL finale proxato: ${proxied?.slice(0,80)}…`);
      GE(); return { url: proxied, quality: `${best.quality}p`, needsProxy: true };
    }

    const hls = data?.request?.files?.hls?.cdns;
    if (hls) {
      const cdn = Object.values(hls)[0];
      if (cdn?.url) {
        L(FN, `Nessun progressive → HLS fallback: ${cdn.url.slice(0,60)}`);
        const proxied = await proxyVideoUrl(cdn.url);
        GE(); return { url: proxied, needsProxy: true };
      }
    }
    E(FN,'Nessun formato (né progressive né HLS)'); GE(); return null;
  }

  // ─── REDDIT via .json API ─────────────────────────────────────────────────
  // reddit.com ha CORS nativo per GET anonimi.
  // media.reddit_video.fallback_url → v.redd.it → CF Worker relay.
  async function extractReddit(url, onProgress) {
    const FN = 'extractReddit';
    G(FN, `Reddit: ${url}`);
    L(FN, `LOGICA: aggiungo .json all'URL → media.reddit_video.fallback_url → CF Worker relay`);
    const jsonUrl = url.replace(/\/$/, '').replace(/\?.*$/,'') + '.json';
    L(FN, `JSON endpoint: ${jsonUrl}`);
    onProgress?.('Reddit · JSON API…');

    let data = null;
    L(FN, `Tentativo fetch diretto (reddit ha CORS nativo per GET anonimi)…`);
    try {
      const r = await fetch(jsonUrl, { headers:{'Accept':'application/json'}, signal: AbortSignal.timeout(8000) });
      L(FN, `Fetch diretto → HTTP ${r.status}`);
      if (r.ok) { data = await r.json(); L(FN, `✓ Fetch diretto riuscito`); }
      else W(FN, `HTTP ${r.status} → provo CF Worker`);
    } catch(e) { W(FN, `Fetch diretto fallito: ${e.message} → CF Worker`); }

    if (!data) {
      L(FN, `Fetch via proxyFetch (CF Worker)…`);
      data = await proxyFetch(jsonUrl, true);
    }
    if (!data) { E(FN,'Nessun dato JSON'); GE(); return null; }

    const post = Array.isArray(data) ? data[0]?.data?.children?.[0]?.data : data?.data?.children?.[0]?.data;
    if (!post) { E(FN,'Post non trovato nella struttura JSON'); GE(); return null; }
    L(FN, `Post trovato: title="${post.title?.slice(0,50)}" subreddit=${post.subreddit}`);
    L(FN, `media keys: ${JSON.stringify(Object.keys(post.media||{}))}`);

    const rv = post.media?.reddit_video || post.secure_media?.reddit_video;
    if (rv?.fallback_url) {
      const rawUrl = rv.fallback_url.replace('?source=fallback','');
      L(FN, `✓ reddit_video.fallback_url: ${rawUrl.slice(0,80)}`);
      L(FN, `v.redd.it blocca CORS → CF Worker relay…`);
      const proxied = await proxyVideoUrl(rawUrl);
      GE(); return { url: proxied, needsProxy: true };
    }

    const directUrl = post.url_overridden_by_dest || post.url;
    L(FN, `Nessun reddit_video. url diretto: ${directUrl?.slice(0,80)}`);
    if (directUrl?.match(/\.(mp4|webm|gifv)(\?.*)?$/i)) {
      const final = directUrl.replace('.gifv','.mp4');
      const proxied = await proxyVideoUrl(final);
      GE(); return { url: proxied, needsProxy: true };
    }
    E(FN,'Nessun video trovato nel post Reddit'); GE(); return null;
  }

  // ─── INSTAGRAM via vxinstagram ────────────────────────────────────────────
  // Step 1: buildVxUrl() → sostituisce instagram.com con vxinstagram.com (path invariato)
  // Step 2: proxyFetch() via CF Worker → scarica HTML con <source src="VerifySnapsaveLink?...">
  // Step 3: extractSourceFromHtml() → estrae rawUrl
  // Step 4: proxyVideoUrl() CF Worker → relay CORS per streaming
  function buildVxUrl(igUrl) {
    const FN = 'buildVxUrl';
    try {
      const u = new URL(igUrl);
      if (!u.hostname.includes('instagram.com')) { E(FN,'Non è instagram.com'); return null; }
      const vx = `https://www.vxinstagram.com${u.pathname}`;
      L(FN, `"${igUrl.slice(0,60)}" → "${vx}"`);
      return vx;
    } catch(e) { E(FN, `URL parse fallito: ${e.message}`); return null; }
  }

  function extractSourceFromHtml(html) {
    const FN = 'extractSourceFromHtml';
    L(FN, `Cerco URL video in HTML (${html.length} chars)…`);
    L(FN, `Strategia: [1] <source src> → [2] og:video:secure_url → [3] og:video`);
    const dec = s=>(s||'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");

    const src = html.match(/<source[^>]+src=["']([^"']+)["']/i);
    if (src?.[1]) { L(FN, `✓ [1] <source src>: ${dec(src[1]).slice(0,80)}…`); return dec(src[1]); }

    const ogS = html.match(/property=["']og:video:secure_url["'][^>]*content=["']([^"']+)["']/i)
              || html.match(/content=["']([^"']+)["'][^>]*property=["']og:video:secure_url["']/i);
    if (ogS?.[1]) { L(FN, `✓ [2] og:video:secure_url: ${dec(ogS[1]).slice(0,80)}…`); return dec(ogS[1]); }

    const ogV = html.match(/property=["']og:video["'][^>]*content=["']([^"']+)["']/i)
              || html.match(/content=["']([^"']+)["'][^>]*property=["']og:video["']/i);
    if (ogV?.[1]) { L(FN, `✓ [3] og:video: ${dec(ogV[1]).slice(0,80)}…`); return dec(ogV[1]); }

    E(FN,'Nessun URL trovato (<source src>, og:video:secure_url, og:video tutti falliti)');
    return null;
  }

  async function extractInstagram(url, onProgress) {
    const FN = 'extractInstagram';
    G(FN, `Instagram: ${url}`);
    L(FN, `LOGICA: vxinstagram → CF Worker HTML fetch → extractSourceFromHtml → CF Worker video relay`);

    L(FN, `Step 1: buildVxUrl…`);
    const vxUrl = buildVxUrl(url);
    if (!vxUrl) { E(FN,'buildVxUrl fallito'); GE(); return null; }
    L(FN, `Step 1 OK → vxUrl="${vxUrl}"`);

    onProgress?.('Instagram · vxinstagram via CF Worker…');
    L(FN, `Step 2: proxyFetch(vxUrl) tramite CF Worker…`);
    const html = await proxyFetch(vxUrl, false);
    if (!html) { E(FN,'Nessun HTML da proxyFetch'); GE(); return null; }
    L(FN, `Step 2 OK → HTML: ${html.length} chars`);

    L(FN, `Step 3: extractSourceFromHtml…`);
    const rawUrl = extractSourceFromHtml(html);
    if (!rawUrl) { E(FN,'Nessun URL video nell\'HTML vxinstagram'); GE(); return null; }
    L(FN, `Step 3 OK → rawUrl="${rawUrl.slice(0,100)}…"`);

    onProgress?.('Instagram · CF Worker video relay…');
    L(FN, `Step 4: proxyVideoUrl (CF Worker relay per VerifySnapsaveLink)…`);
    const proxied = await proxyVideoUrl(rawUrl);
    L(FN, `Step 4 OK → URL finale="${proxied?.slice(0,100)}…"`);
    GE(); return { url: proxied, needsProxy: true };
  }

  // ─── COBALT API ────────────────────────────────────────────────────────────
  // POST /  → status: stream/redirect/tunnel → URL diretto → CF Worker relay
  //        → status: picker → array stream disponibili
  const COBALT_INSTANCES = [
    'https://api.cobalt.tools',
    'https://cobalt.api.timelessnesses.me',
    'https://cobalt.catto.zip',
    'https://co.wuk.sh',
  ];

  async function extractViaCobalt(url, quality = '720', onProgress) {
    const FN = 'extractViaCobalt';
    G(FN, `Cobalt: ${url} [${quality}p]`);
    L(FN, `LOGICA: POST a istanza Cobalt → ricevo stream URL → CF Worker relay per CORS`);
    L(FN, `Istanze disponibili: ${COBALT_INSTANCES.length} — provo in cascata`);

    for (let i = 0; i < COBALT_INSTANCES.length; i++) {
      const inst = COBALT_INSTANCES[i];
      onProgress?.(`Cobalt ${i+1}/${COBALT_INSTANCES.length}…`);
      L(FN, `[${i+1}/${COBALT_INSTANCES.length}] POST → ${inst}`);
      const payload = { url, videoQuality: quality, audioFormat:'mp3', filenameStyle:'basic', downloadMode:'auto', twitterGif:false };
      L(FN, `[${i+1}] Payload:`, payload);
      try {
        const res = await fetch(inst, {
          method:'POST',
          headers:{'Accept':'application/json','Content-Type':'application/json'},
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10000),
        });
        L(FN, `[${i+1}] HTTP ${res.status} ${res.statusText}`);
        if (!res.ok) { W(FN, `[${i+1}] HTTP ${res.status} → prossima istanza`); continue; }
        const data = await res.json();
        L(FN, `[${i+1}] Risposta:`, { status: data.status, hasUrl: !!data.url, pickerLen: data.picker?.length });

        if (data.status === 'error') {
          W(FN, `[${i+1}] Cobalt error: ${JSON.stringify(data.error)} → prossima istanza`);
          continue;
        }
        if (['stream','redirect','tunnel'].includes(data.status)) {
          L(FN, `[${i+1}] ✓ status="${data.status}" → url: ${data.url?.slice(0,80)}…`);
          L(FN, `[${i+1}] CF Worker relay per CORS…`);
          const proxied = await proxyVideoUrl(data.url);
          L(FN, `[${i+1}] URL finale: ${proxied?.slice(0,80)}…`);
          GE(); return { url: proxied||data.url, needsProxy: true };
        }
        if (data.status === 'picker' && data.picker?.length) {
          L(FN, `[${i+1}] ✓ status="picker" → ${data.picker.length} stream`);
          data.picker.forEach((item,idx) => L(FN, `  picker[${idx}]: ${item.url?.slice(0,60)}…`));
          GE(); return { picker: data.picker };
        }
        W(FN, `[${i+1}] Status inatteso: "${data.status}" → prossima istanza`);
      } catch(e) { E(FN, `[${i+1}] Eccezione su ${inst}: ${e.message}`); }
    }
    E(FN, `TUTTE le ${COBALT_INSTANCES.length} istanze Cobalt fallite`);
    GE(); return null;
  }

  // ─── PYODIDE + yt-dlp (fallback universale WASM) ──────────────────────────
  // loadPyodide():
  //   1. Carica script Pyodide da CDN (~40MB la prima volta, poi in cache SW)
  //   2. Inizializza CPython 3.12 in WASM
  //   3. Installa micropip + yt-dlp via micropip
  //   4. Patcha urllib.urlopen → ogni richiesta HTTP di yt-dlp passa per CF Worker
  //      (allorigins aggiunto solo se useAlloriginsFallback = true)
  //
  // extractWithYtDlp():
  //   - Imposta _target_url e _quality come variabili Python globali
  //   - Esegue yt_dlp.extract_info(download=False)
  //   - Wrappa URL risultante con CF Worker
  let _pyodide = null, _ytdlpReady = false, _loading = false, _cbs = [];
  const PYODIDE_CDN = 'https://cdn.jsdelivr.net/pyodide/v0.27.4/full/pyodide.js';

  async function initPyodide(onProgress) {
    const FN = 'initPyodide';
    if (_pyodide && _ytdlpReady) { L(FN,'Pyodide già pronto → reuse immediato'); return _pyodide; }
    if (_loading) { L(FN,'Pyodide in caricamento → attendo callback'); return new Promise(r=>_cbs.push(r)); }
    _loading = true;

    G(FN, '=== CARICAMENTO PYODIDE + yt-dlp ===');
    L(FN, `LOGICA: CPython 3.12 in WASM. yt-dlp installato via micropip. urllib.urlopen patchato → CF Worker.`);

    // Step 1: script CDN
    if (!window.loadPyodide) {
      L(FN, `Step 1: inserisco <script src="${PYODIDE_CDN}">…`);
      onProgress?.('Caricamento Pyodide WASM…','Prima volta ~40MB (poi in cache)');
      await new Promise((res,rej)=>{
        const s=document.createElement('script'); s.src=PYODIDE_CDN;
        s.onload=()=>{L(FN,'✓ Script Pyodide caricato'); res();};
        s.onerror=e=>{E(FN,'Script fallito',e); rej(e);};
        document.head.appendChild(s);
      });
    } else { L(FN,'Step 1: window.loadPyodide già disponibile'); }

    // Step 2: ambiente Python
    L(FN,'Step 2: inizializzo ambiente Python WASM…');
    onProgress?.('Inizializzazione Python WASM…','');
    _pyodide = await window.loadPyodide({ indexURL:'https://cdn.jsdelivr.net/pyodide/v0.27.4/full/' });
    L(FN, `Step 2 ✓ Python: ${_pyodide.runPython('import sys; sys.version')}`);

    // Step 3: micropip
    L(FN,'Step 3: carico micropip…');
    onProgress?.('Installazione yt-dlp…','Download package Python puro');
    await _pyodide.loadPackage('micropip');
    L(FN,'Step 3 ✓ micropip caricato');

    // Step 4: yt-dlp
    L(FN,'Step 4: installo yt-dlp via micropip…');
    await _pyodide.runPythonAsync(`
import micropip
print('[Pyodide-Step4] Installazione yt-dlp...')
await micropip.install('yt-dlp')
import yt_dlp
print(f'[Pyodide-Step4] yt-dlp {yt_dlp.version.__version__} installato OK')
`);
    L(FN,'Step 4 ✓ yt-dlp installato');

    // Step 5: patch urllib con CF Worker (+ allorigins opzionale)
    L(FN,'Step 5: patch urllib.urlopen con CF Worker…');
    L(FN,'LOGICA: ogni richiesta HTTP interna di yt-dlp viene redirezionata via CF Worker');
    const useAllorigins = MV.getProxySettings().useAlloriginsFallback;
    L(FN, `useAllorigins in Python patch: ${useAllorigins}`);
    _pyodide.globals.set('_CF_BASE_PY',    CF_BASE + '/?url=');
    _pyodide.globals.set('_CF_KEY_PY',     '&key=' + CF_KEY);
    _pyodide.globals.set('_USE_ALLORIGINS_PY', useAllorigins);

    await _pyodide.runPythonAsync(`
import urllib.request as _ur, urllib.parse as _up, urllib.error

_PROXY_BASES = [_CF_BASE_PY]
if _USE_ALLORIGINS_PY:
    _PROXY_BASES.append("https://api.allorigins.win/raw?url=")
    print(f'[urllib-patch] allorigins aggiunto come fallback')

print(f'[urllib-patch] Proxy configurati: {_PROXY_BASES}')
_orig = _ur.urlopen

def _patched(url_or_req, data=None, timeout=30, **kw):
    raw = url_or_req if isinstance(url_or_req, str) else getattr(url_or_req, 'full_url', str(url_or_req))
    print(f'[urllib-patch] Intercettato: {raw[:80]}')
    last = None
    for i, base in enumerate(_PROXY_BASES):
        enc = _up.quote(raw, safe='')
        suffix = _CF_KEY_PY if 'lucatarik' in base else ''
        pu = base + enc + suffix
        print(f'[urllib-patch] Proxy {i+1}/{len(_PROXY_BASES)}: {pu[:80]}')
        try:
            if isinstance(url_or_req, str):
                return _orig(pu, data=data, timeout=timeout)
            nr = _ur.Request(
                pu,
                data=getattr(url_or_req, 'data', None),
                headers=dict(getattr(url_or_req, 'headers', {})),
                method=url_or_req.get_method() if hasattr(url_or_req, 'get_method') else 'GET'
            )
            return _orig(nr, timeout=timeout)
        except Exception as e:
            print(f'[urllib-patch] Proxy {i+1} fallito: {e}')
            last = e
    raise last or urllib.error.URLError('Tutti i proxy falliti')

_ur.urlopen = _patched
print('[urllib-patch] urllib.urlopen patchato con CF Worker')
`);

    _ytdlpReady = true;   // <-- JS, non Python!
    _loading = false;
    L(FN,'=== PYODIDE + yt-dlp COMPLETAMENTE PRONTI ===');
    GE();
    _cbs.forEach(cb=>cb(_pyodide)); _cbs=[];
    return _pyodide;
  }

  async function extractWithYtDlp(url, quality = '720', onProgress) {
    const FN = 'extractWithYtDlp';
    G(FN, `yt-dlp WASM: ${url} [${quality}p]`);
    L(FN, `LOGICA: Python WASM nel browser. yt-dlp.extract_info(download=False) → URL CDN → CF Worker relay`);
    L(FN, `Prima apertura: ~40-60s (Pyodide+yt-dlp ~40MB). Successive: istantanee (SW cache)`);
    onProgress?.('yt-dlp WASM…','Prima volta 40-60s, poi in cache');

    let pyodide;
    try { pyodide = await initPyodide(onProgress); }
    catch(e) { E(FN, `initPyodide fallito: ${e.message}`, e); GE(); return null; }

    L(FN, `Imposto variabili Python: _target_url="${url}" _quality="${quality}"`);
    pyodide.globals.set('_target_url', url);
    pyodide.globals.set('_quality', quality);
    onProgress?.('yt-dlp in esecuzione…', url.slice(0,50)+'…');
    L(FN, `Eseguo script Python yt-dlp.extract_info(download=False)…`);

    try {
      const resultJson = await pyodide.runPythonAsync(`
import yt_dlp, json, sys
print(f'[yt-dlp] === ESTRAZIONE === url={_target_url} quality={_quality}p')
_opts = {
    'quiet': False, 'no_warnings': False,
    'format': f'bestvideo[height<={_quality}]+bestaudio/best[height<={_quality}]/best',
    'noplaylist': True, 'socket_timeout': 20, 'extractor_retries': 2
}
print(f'[yt-dlp] opts={_opts}')
_res = None
try:
    with yt_dlp.YoutubeDL(_opts) as ydl:
        print('[yt-dlp] Chiamo extract_info(download=False)...')
        info = ydl.extract_info(_target_url, download=False)
        formats = info.get('formats', [info])
        print(f'[yt-dlp] formati totali ricevuti: {len(formats)}')
        best = None
        for f in reversed(formats):
            print(f'[yt-dlp] formato: id={f.get("format_id","?")} h={f.get("height","?")} vcodec={str(f.get("vcodec","none"))[:15]} url={bool(f.get("url"))}')
            if f.get('url') and f.get('vcodec', 'none') != 'none':
                best = f
                break
        if not best and formats:
            best = formats[-1]
            print('[yt-dlp] Nessun formato con video → uso ultimo disponibile')
        if best:
            print(f'[yt-dlp] SCELTO: {best.get("height","?")}p ext={best.get("ext","?")} url={best.get("url","")[:80]}...')
        _res = json.dumps({
            'url': best.get('url') if best else info.get('url'),
            'ext': (best or info).get('ext', 'mp4'),
            'quality': str(best.get('height','?'))+'p' if best and best.get('height') else '?',
            'title': info.get('title', '')
        })
except Exception as e:
    import traceback
    tb = traceback.format_exc()
    print(f'[yt-dlp] ERRORE: {e}', file=sys.stderr)
    print(f'[yt-dlp] TRACEBACK:\\n{tb}', file=sys.stderr)
    _res = json.dumps({'error': str(e), 'tb': tb[:500]})
print(f'[yt-dlp] Risultato JSON: {_res[:200]}')
_res
`);
      const result = JSON.parse(resultJson);
      L(FN, `Risultato Python:`, result);
      if (result.error) { E(FN, `yt-dlp error: ${result.error}`); if(result.tb) E(FN, result.tb); GE(); return null; }
      if (!result.url)  { E(FN, 'Nessun URL nel risultato Python'); GE(); return null; }
      L(FN, `✓ URL estratto (${result.quality}): ${result.url.slice(0,100)}…`);
      L(FN, `CF Worker relay per CORS…`);
      const proxied = await proxyVideoUrl(result.url);
      L(FN, `URL finale: ${proxied?.slice(0,100)}…`);
      GE(); return { url: proxied||result.url, quality: result.quality, needsProxy: true };
    } catch(e) { E(FN, `Eccezione JS: ${e.message}`, e); GE(); return null; }
  }

  // ─── ROUTER PRINCIPALE ────────────────────────────────────────────────────
  const EMBED_ONLY  = ['spotify','twitch'];
  const COBALT_PLATS = ['tiktok','twitter','facebook'];

  async function extract(url, platform, quality = '720', onProgress) {
    const FN = 'extract';
    MV.section(`[extractor.js] ESTRAZIONE: ${platform} → ${url.slice(0,50)}`);
    L(FN, `URL completo: ${url}`);
    L(FN, `Platform: "${platform}"  |  Quality: ${quality}p`);
    L(FN, `Settings: useAllorigins=${MV.getProxySettings().useAlloriginsFallback}`);
    L(FN, `Timestamp: ${new Date().toISOString()}`);

    let result = null;

    if (/\.(mp4|webm|mov|ogg|m3u8|ts)(\?.*)?$/i.test(url)) {
      L(FN, `PERCORSO → file diretto → play immediato (no proxy)`);
      result = { url, needsProxy: false, direct: true };
    }
    else if (EMBED_ONLY.includes(platform)) {
      L(FN, `PERCORSO → "${platform}" → embed-only (nessun stream audio/video diretto disponibile)`);
      result = { embedOnly: true };
    }
    else if (platform === 'youtube' || /youtu\.?be/.test(url)) {
      L(FN, `PERCORSO → YouTube: [1] Invidious → [2] yt-dlp WASM`);
      onProgress?.('YouTube · Invidious…');
      result = await extractYouTube(url, quality, onProgress);
      if (!result) { L(FN,'Invidious fallito → yt-dlp'); result = await extractWithYtDlp(url, quality, onProgress); }
    }
    else if (platform === 'vimeo' || url.includes('vimeo.com')) {
      L(FN, `PERCORSO → Vimeo: [1] config API → [2] yt-dlp WASM`);
      result = await extractVimeo(url, quality, onProgress);
      if (!result) { L(FN,'config API fallita → yt-dlp'); result = await extractWithYtDlp(url, quality, onProgress); }
    }
    else if (platform === 'reddit' || url.includes('reddit.com')) {
      L(FN, `PERCORSO → Reddit: [1] .json API → [2] Cobalt`);
      result = await extractReddit(url, onProgress);
      if (!result) { L(FN,'.json fallito → Cobalt'); result = await extractViaCobalt(url, quality, onProgress); }
    }
    else if (platform === 'instagram' || /instagram\.com\/(reels?|p|tv|stories|share)\//.test(url)) {
      L(FN, `PERCORSO → Instagram: [1] vxinstagram+CF Worker → [2] Cobalt → [3] embedOnly`);
      result = await extractInstagram(url, onProgress);
      if (!result) { L(FN,'vxinstagram fallito → Cobalt'); result = await extractViaCobalt(url, quality, onProgress); }
      if (!result) { L(FN,'Cobalt fallito → embedOnly iframe'); result = { embedOnly: true }; }
    }
    else if (COBALT_PLATS.includes(platform)) {
      L(FN, `PERCORSO → ${platform}: [1] Cobalt → [2] yt-dlp WASM`);
      result = await extractViaCobalt(url, quality, onProgress);
      if (!result) { L(FN,'Cobalt fallito → yt-dlp'); result = await extractWithYtDlp(url, quality, onProgress); }
    }
    else {
      L(FN, `PERCORSO → "${platform}" senza fast-path → yt-dlp WASM universale (1000+ siti)`);
      result = await extractWithYtDlp(url, quality, onProgress);
    }

    if (result) L(FN, `✓ ESTRAZIONE COMPLETATA:`, result);
    else        E(FN, `✗ TUTTI I METODI FALLITI per: ${url}`);

    MV.groupEnd();
    return result;
  }

  function preloadPyodide() {
    if (_pyodide||_loading) { L('preloadPyodide','Già caricato/in caricamento → skip'); return; }
    L('preloadPyodide','Pre-caricamento Pyodide in background (5s delay)…');
    setTimeout(()=>initPyodide(()=>{}), 5000);
  }

  function getVxInstagramUrl(url) { return buildVxUrl(url); }

  L('init', '✓ Extractor pronto (CF Worker only — no corsproxy.io)');
  return { extract, preloadPyodide, getVxInstagramUrl, extractViaCobalt };

})();
