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
 *   YouTube   → [1] yt-dlp WASM
 *   Vimeo     → [1] player config API + CF Worker → [2] yt-dlp WASM
 *   Reddit    → [1] .json API (CORS nativo) + CF Worker → [2] yt-dlp WASM
 *   Instagram → [1] vxinstagram + CF Worker → [2] embedOnly
 *   TikTok/Twitter/Facebook → [1] yt-dlp WASM
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

  // ─── YOUTUBE → yt-dlp WASM ───────────────────────────────────────────────

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

  // ─── PYODIDE + yt-dlp (universale WASM) ──────────────────────────────────
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

    // Step 3: micropip (ssl viene mockato in Python nel prossimo step)
    L(FN,'Step 3: carico micropip…');
    onProgress?.('Caricamento micropip…', '');
    await _pyodide.loadPackage('micropip');
    L(FN,'Step 3 ✓ micropip caricato');

    // Step 4: mock ssl + installa yt-dlp
    // ssl è "unvendored" in Pyodide 0.27 e NON disponibile via loadPackage su tutti i build.
    // Soluzione: iniettare un modulo ssl fittizio in sys.modules PRIMA che yt-dlp lo importi.
    // yt-dlp usa ssl solo per verificare certificati HTTPS — nel browser tutto il networking
    // passa per fetch() (già secure) quindi ssl non serve davvero a runtime.
    L(FN,'Step 4: mock ssl → installa yt-dlp via micropip…');
    L(FN,'LOGICA: ssl è unvendored in Pyodide — mocchiamo il modulo prima che yt-dlp lo importi');
    onProgress?.('Installazione yt-dlp…', 'mock ssl + download package');
    await _pyodide.runPythonAsync(`
import sys, types, micropip

# ── Mock ssl ──────────────────────────────────────────────────────────────────
# Crea un modulo ssl fittizio con gli attributi minimi che yt-dlp si aspetta.
# In ambiente WASM/browser il networking reale passa per fetch() — ssl non è usato.
print('[Pyodide-Step4] Injecting mock ssl module into sys.modules...')
_ssl_mock = types.ModuleType('ssl')

# SSLContext: vera classe per supportare ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT) e tutti gli attributi
class _FakeSSLContext:
    def __init__(self, protocol=None): pass
    def load_verify_locations(self, *a, **kw): pass
    def load_default_certs(self, *a, **kw): pass
    def set_default_verify_paths(self, *a, **kw): pass
    def set_ciphers(self, *a, **kw): pass
    def wrap_socket(self, sock, *a, **kw): return sock
    def load_cert_chain(self, *a, **kw): pass
    def set_alpn_protocols(self, *a, **kw): pass
    def set_servername_callback(self, *a, **kw): pass
    def set_npn_protocols(self, *a, **kw): pass
    def get_ciphers(self, *a, **kw): return []
    def session_stats(self, *a, **kw): return {}
    def cert_store_stats(self, *a, **kw): return {}
    check_hostname  = False
    verify_mode     = 0
    options         = 0
    minimum_version = None
    maximum_version = None

# TLSVersion enum
class _TLSVersion:
    MINIMUM_SUPPORTED = -2
    SSLv3             = 768
    TLSv1             = 769
    TLSv1_1           = 770
    TLSv1_2           = 771
    TLSv1_3           = 772
    MAXIMUM_SUPPORTED = -1

# Purpose enum
class _Purpose:
    class SERVER_AUTH:
        _name_ = 'SERVER_AUTH'; oid = '1.3.6.1.5.5.7.3.1'
    class CLIENT_AUTH:
        _name_ = 'CLIENT_AUTH'; oid = '1.3.6.1.5.5.7.3.2'

# ── Classi e tipi ─────────────────────────────────────────────────────────────
_ssl_mock.SSLContext               = _FakeSSLContext
_ssl_mock.SSLObject                = _FakeSSLContext
_ssl_mock.SSLSocket                = _FakeSSLContext
_ssl_mock.TLSVersion               = _TLSVersion
_ssl_mock.Purpose                  = _Purpose

# ── Eccezioni ─────────────────────────────────────────────────────────────────
_ssl_mock.SSLError                 = OSError
_ssl_mock.SSLEOFError              = OSError
_ssl_mock.SSLSyscallError          = OSError
_ssl_mock.SSLWantReadError         = OSError
_ssl_mock.SSLWantWriteError        = OSError
_ssl_mock.SSLZeroReturnError       = OSError
_ssl_mock.SSLCertVerificationError = ValueError
_ssl_mock.CertificateError         = ValueError

# ── CERT_* ────────────────────────────────────────────────────────────────────
_ssl_mock.CERT_NONE                = 0
_ssl_mock.CERT_OPTIONAL            = 1
_ssl_mock.CERT_REQUIRED            = 2

# ── PROTOCOL_* ────────────────────────────────────────────────────────────────
_ssl_mock.PROTOCOL_TLS             = 2
_ssl_mock.PROTOCOL_TLS_CLIENT      = 16
_ssl_mock.PROTOCOL_TLS_SERVER      = 17
_ssl_mock.PROTOCOL_SSLv23          = 2
_ssl_mock.PROTOCOL_TLSv1           = 3
_ssl_mock.PROTOCOL_TLSv1_1         = 4
_ssl_mock.PROTOCOL_TLSv1_2         = 5

# ── OP_* ──────────────────────────────────────────────────────────────────────
_ssl_mock.OP_ALL                       = 0x80000054
_ssl_mock.OP_NO_SSLv2                  = 0x01000000
_ssl_mock.OP_NO_SSLv3                  = 0x02000000
_ssl_mock.OP_NO_TLSv1                  = 0x04000000
_ssl_mock.OP_NO_TLSv1_1                = 0x10000000
_ssl_mock.OP_NO_TLSv1_2                = 0x08000000
_ssl_mock.OP_NO_TLSv1_3                = 0x20000000
_ssl_mock.OP_NO_COMPRESSION            = 0x00020000
_ssl_mock.OP_NO_TICKET                 = 0x00004000
_ssl_mock.OP_NO_RENEGOTIATION          = 0x40000000
_ssl_mock.OP_CIPHER_SERVER_PREFERENCE  = 0x00400000
_ssl_mock.OP_SINGLE_DH_USE             = 0x00100000
_ssl_mock.OP_SINGLE_ECDH_USE           = 0x00080000
_ssl_mock.OP_LEGACY_SERVER_CONNECT     = 0x00000004
_ssl_mock.OP_ENABLE_KTLS               = 0x00000008
_ssl_mock.OP_IGNORE_UNEXPECTED_EOF     = 0x00000080
_ssl_mock.OP_ENABLE_MIDDLEBOX_COMPAT   = 0x00100000

# ── HAS_* ─────────────────────────────────────────────────────────────────────
_ssl_mock.HAS_SNI                  = True
_ssl_mock.HAS_ALPN                 = True
_ssl_mock.HAS_NPN                  = False
_ssl_mock.HAS_ECDH                 = True
_ssl_mock.HAS_SSLv2                = False
_ssl_mock.HAS_SSLv3                = False
_ssl_mock.HAS_TLSv1                = True
_ssl_mock.HAS_TLSv1_1              = True
_ssl_mock.HAS_TLSv1_2              = True
_ssl_mock.HAS_TLSv1_3              = True
_ssl_mock.HAS_NEVER_CHECK_COMMON_NAME = True

# ── SSL_ERROR_* ───────────────────────────────────────────────────────────────
_ssl_mock.SSL_ERROR_ZERO_RETURN        = 6
_ssl_mock.SSL_ERROR_WANT_READ          = 2
_ssl_mock.SSL_ERROR_WANT_WRITE         = 3
_ssl_mock.SSL_ERROR_WANT_CONNECT       = 7
_ssl_mock.SSL_ERROR_WANT_X509_LOOKUP   = 4
_ssl_mock.SSL_ERROR_SYSCALL            = 5
_ssl_mock.SSL_ERROR_SSL                = 1
_ssl_mock.SSL_ERROR_EOF                = 8
_ssl_mock.SSL_ERROR_INVALID_ERROR_CODE = 10

# ── ALERT_DESCRIPTION_* ───────────────────────────────────────────────────────
_ssl_mock.ALERT_DESCRIPTION_CLOSE_NOTIFY              = 0
_ssl_mock.ALERT_DESCRIPTION_UNEXPECTED_MESSAGE        = 10
_ssl_mock.ALERT_DESCRIPTION_BAD_RECORD_MAC            = 20
_ssl_mock.ALERT_DESCRIPTION_RECORD_OVERFLOW           = 22
_ssl_mock.ALERT_DESCRIPTION_DECOMPRESSION_FAILURE     = 30
_ssl_mock.ALERT_DESCRIPTION_HANDSHAKE_FAILURE         = 40
_ssl_mock.ALERT_DESCRIPTION_BAD_CERTIFICATE           = 42
_ssl_mock.ALERT_DESCRIPTION_UNSUPPORTED_CERTIFICATE   = 43
_ssl_mock.ALERT_DESCRIPTION_CERTIFICATE_REVOKED       = 44
_ssl_mock.ALERT_DESCRIPTION_CERTIFICATE_EXPIRED       = 45
_ssl_mock.ALERT_DESCRIPTION_CERTIFICATE_UNKNOWN       = 46
_ssl_mock.ALERT_DESCRIPTION_ILLEGAL_PARAMETER         = 47
_ssl_mock.ALERT_DESCRIPTION_UNKNOWN_CA                = 48
_ssl_mock.ALERT_DESCRIPTION_ACCESS_DENIED             = 49
_ssl_mock.ALERT_DESCRIPTION_DECODE_ERROR              = 50
_ssl_mock.ALERT_DESCRIPTION_DECRYPT_ERROR             = 51
_ssl_mock.ALERT_DESCRIPTION_PROTOCOL_VERSION          = 70
_ssl_mock.ALERT_DESCRIPTION_INSUFFICIENT_SECURITY     = 71
_ssl_mock.ALERT_DESCRIPTION_INTERNAL_ERROR            = 80
_ssl_mock.ALERT_DESCRIPTION_USER_CANCELLED            = 90
_ssl_mock.ALERT_DESCRIPTION_NO_RENEGOTIATION          = 100
_ssl_mock.ALERT_DESCRIPTION_UNSUPPORTED_EXTENSION     = 110
_ssl_mock.ALERT_DESCRIPTION_CERTIFICATE_UNOBTAINABLE  = 111
_ssl_mock.ALERT_DESCRIPTION_UNRECOGNIZED_NAME         = 112
_ssl_mock.ALERT_DESCRIPTION_BAD_CERTIFICATE_STATUS_RESPONSE = 113
_ssl_mock.ALERT_DESCRIPTION_BAD_CERTIFICATE_HASH_VALUE= 114
_ssl_mock.ALERT_DESCRIPTION_UNKNOWN_PSK_IDENTITY      = 115

# ── VERIFY_* ──────────────────────────────────────────────────────────────────
_ssl_mock.VERIFY_DEFAULT            = 0
_ssl_mock.VERIFY_CRL_CHECK_LEAF     = 4
_ssl_mock.VERIFY_CRL_CHECK_CHAIN    = 12
_ssl_mock.VERIFY_X509_STRICT        = 32
_ssl_mock.VERIFY_ALLOW_PROXY_CERTS  = 64
_ssl_mock.VERIFY_X509_TRUSTED_FIRST = 32768
_ssl_mock.VERIFY_X509_PARTIAL_CHAIN = 524288

# ── OpenSSL versione ──────────────────────────────────────────────────────────
_ssl_mock.OPENSSL_VERSION        = 'OpenSSL 1.1.1 (fake)'
_ssl_mock.OPENSSL_VERSION_INFO   = (1, 1, 1, 0, 15)
_ssl_mock.OPENSSL_VERSION_NUMBER = 0x1010100f
_ssl_mock._OPENSSL_API_VERSION   = (1, 1, 1)

# ── PEM/DER helpers ───────────────────────────────────────────────────────────
_ssl_mock.PEM_HEADER            = '-----BEGIN CERTIFICATE-----'
_ssl_mock.PEM_FOOTER            = '-----END CERTIFICATE-----'
_ssl_mock.DER_cert_to_PEM_cert  = lambda der: ''
_ssl_mock.PEM_cert_to_DER_cert  = lambda pem: b''
_ssl_mock.CHANNEL_BINDING_TYPES = []

# ── Funzioni di utilità ───────────────────────────────────────────────────────
_ssl_mock.create_default_context   = lambda *a, **kw: _FakeSSLContext()
_ssl_mock.wrap_socket              = lambda sock, *a, **kw: sock
_ssl_mock.match_hostname           = lambda cert, hostname: None
_ssl_mock.get_server_certificate   = lambda *a, **kw: ''
_ssl_mock.get_protocol_name        = lambda protocol_code: ''
_ssl_mock.cert_time_to_seconds     = lambda timestring: 0
_ssl_mock.RAND_status              = lambda: 1
_ssl_mock.RAND_bytes               = lambda n: b'\x00' * n
_ssl_mock.RAND_add                 = lambda s, entropy: None
_ssl_mock.get_default_verify_paths = lambda: type('Paths', (), {
    'cafile': None, 'capath': None,
    'openssl_cafile_env': '', 'openssl_capath_env': '',
    'openssl_cafile': '', 'openssl_capath': '',
})()

sys.modules['ssl']  = _ssl_mock
sys.modules['_ssl'] = _ssl_mock
print('[Pyodide-Step4] ssl mock OK')

# ── Installa yt-dlp ───────────────────────────────────────────────────────────
print('[Pyodide-Step4] Installazione yt-dlp...')
await micropip.install('yt-dlp')
import yt_dlp
print(f'[Pyodide-Step4] yt-dlp {yt_dlp.version.__version__} installato OK')
`);
    L(FN,'Step 4 ✓ ssl mockato + yt-dlp installato');

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
      L(FN, `PERCORSO → YouTube: yt-dlp WASM`);
      onProgress?.('YouTube · yt-dlp…');
      result = await extractWithYtDlp(url, quality, onProgress);
    }
    else if (platform === 'vimeo' || url.includes('vimeo.com')) {
      L(FN, `PERCORSO → Vimeo: [1] config API → [2] yt-dlp WASM`);
      result = await extractVimeo(url, quality, onProgress);
      if (!result) { L(FN,'config API fallita → yt-dlp'); result = await extractWithYtDlp(url, quality, onProgress); }
    }
    else if (platform === 'reddit' || url.includes('reddit.com')) {
      L(FN, `PERCORSO → Reddit: [1] .json API → [2] yt-dlp WASM`);
      result = await extractReddit(url, onProgress);
      if (!result) { L(FN,'.json fallito → yt-dlp'); result = await extractWithYtDlp(url, quality, onProgress); }
    }
    else if (platform === 'instagram' || /instagram\.com\/(reels?|p|tv|stories|share)\//.test(url)) {
      L(FN, `PERCORSO → Instagram: [1] vxinstagram+CF Worker → [2] embedOnly`);
      result = await extractInstagram(url, onProgress);
      if (!result) { L(FN,'vxinstagram fallito → embedOnly iframe'); result = { embedOnly: true }; }
    }
    else {
      L(FN, `PERCORSO → "${platform}" → yt-dlp WASM universale (1000+ siti)`);
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
  return { extract, preloadPyodide, getVxInstagramUrl };

})();
