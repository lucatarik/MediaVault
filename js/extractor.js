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
_ssl_mock.RAND_bytes               = lambda n: bytes(n)
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

    // Step 5: patch http.client.HTTPConnection/HTTPSConnection con XHR sincrono
    // PROBLEMA: yt-dlp usa il proprio opener che chiama http.client.HTTPConnection
    // direttamente, bypassando urllib.urlopen. HTTPConnection usa socket.create_connection()
    // che in Pyodide WASM tenta WebSocket → bloccato come Mixed Content.
    // SOLUZIONE: rimpiazzare HTTPConnection e HTTPSConnection con classi che usano
    // js.XMLHttpRequest sincrono (legale nei Web Worker) via CF Worker.
    L(FN,'Step 5: patch http.client.HTTPConnection con XHR sincrono via CF Worker…');
    L(FN,'LOGICA: http.client livello basso → XHR sincrono → CF Worker → YouTube');
    _pyodide.globals.set('_CF_BASE_PY', CF_BASE + '/?url=');
    _pyodide.globals.set('_CF_KEY_PY',  '&key=' + CF_KEY);

    await _pyodide.runPythonAsync(`
import js, io, email.message, http.client as _hc, sys, gzip as _gzip, zlib as _zlib
import urllib.parse as _up
import base64 as _base64, json as _json

# ══════════════════════════════════════════════════════════════════════════════
# FIX STDOUT/STDERR  — Pyodide usa latin-1 di default; yt-dlp scrive Unicode
# ══════════════════════════════════════════════════════════════════════════════
class _SafeWriter:
    """Wrapper che intercetta ogni write() e converte in UTF-8 con replace."""
    def __init__(self, inner):
        self._inner   = inner
        self.encoding = 'utf-8'
        self.errors   = 'replace'
        self.softspace = 0
    def write(self, s):
        if not isinstance(s, str):
            try: s = s.decode('utf-8', errors='replace')
            except: s = repr(s)
        # Forza a bytes UTF-8 e ritorna come stringa pulita
        safe = s.encode('utf-8', errors='replace').decode('utf-8', errors='replace')
        try:
            return self._inner.write(safe)
        except (UnicodeEncodeError, UnicodeDecodeError, UnicodeTranslateError):
            ascii_s = safe.encode('ascii', errors='replace').decode('ascii')
            try: return self._inner.write(ascii_s)
            except: return len(s)
    def flush(self):
        try: self._inner.flush()
        except: pass
    def fileno(self):
        try: return self._inner.fileno()
        except: return -1
    def __getattr__(self, name):
        return getattr(self._inner, name)

try:
    if not isinstance(sys.stdout, _SafeWriter):
        sys.stdout = _SafeWriter(sys.stdout)
    if not isinstance(sys.stderr, _SafeWriter):
        sys.stderr = _SafeWriter(sys.stderr)
except Exception as _e:
    pass  # mai bloccare qui

# ══════════════════════════════════════════════════════════════════════════════
# HEADER VIETATI  — XHR rifiuta silenziosamente questi header
# ══════════════════════════════════════════════════════════════════════════════
_FORBIDDEN_HEADERS = frozenset({
    'accept-charset', 'accept-encoding', 'access-control-request-headers',
    'access-control-request-method', 'connection', 'content-length', 'cookie',
    'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive', 'origin',
    'referer', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'user-agent',
    'via', 'warning',
})

def _safe_headers(headers):
    """Rimuove header vietati dal browser prima di passarli a XHR."""
    out = {}
    for k, v in (headers or {}).items():
        kl = k.lower()
        if kl in _FORBIDDEN_HEADERS: continue
        if kl.startswith(('proxy-', 'sec-')): continue
        out[k] = v
    return out

# ══════════════════════════════════════════════════════════════════════════════
# DECODIFICA BODY  — x-user-defined mappa 0x80-0xFF → U+F780-U+F7FF
#                    ord(c) & 0xFF recupera il byte originale in tutti i casi
# ══════════════════════════════════════════════════════════════════════════════
def _responsetext_to_bytes(text):
    if not text:
        return b''
    try:
        # Caso normale: x-user-defined → & 0xFF sempre da 0-255, nessun errore
        return bytes(ord(c) & 0xFF for c in text)
    except TypeError:
        # text è ancora un JsProxy non convertito: forza str()
        return bytes(ord(c) & 0xFF for c in str(text))

# ══════════════════════════════════════════════════════════════════════════════
# DECOMPRESSIONE  — il CF Worker può passare gzip/deflate tal quale
# ══════════════════════════════════════════════════════════════════════════════
def _decompress_body(data, content_encoding):
    enc = (content_encoding or '').lower().strip()
    if not enc or not data:
        return data, False
    try:
        if enc in ('gzip', 'x-gzip'):
            return _gzip.decompress(data), True
        if enc == 'deflate':
            try:
                return _zlib.decompress(data), True
            except _zlib.error:
                return _zlib.decompress(data, -15), True  # deflate raw
        if enc == 'br':
            pass  # brotli non disponibile in WASM base; lascia passare
    except Exception as _ex:
        print(f'[http-patch] decompressione {enc!r} fallita: {_ex}')
    return data, False

# ══════════════════════════════════════════════════════════════════════════════
# _ProxyResponse  — contenitore dati già deserializzati dal proxy JSON+base64
# ══════════════════════════════════════════════════════════════════════════════
class _ProxyResponse:
    __slots__ = ('status', 'reason', 'headers_dict', 'body_bytes', 'url')
    def __init__(self, status, reason, headers_dict, body_bytes, url):
        self.status      = int(status or 200)
        self.reason      = str(reason or 'OK')
        self.headers_dict = dict(headers_dict or {})
        self.body_bytes  = bytes(body_bytes or b'')
        self.url         = url

# ══════════════════════════════════════════════════════════════════════════════
# XHR FETCH  — unico punto dove si effettua la richiesta HTTP via JS
#
# STRATEGIA (resistente a tutti i problemi di encoding):
#   • Richiede al CF Worker fmt=b64 → il worker restituisce JSON puro ASCII:
#       { "status": 200, "statusText": "OK",
#         "headers": { ... },
#         "body": "<base64 del body grezzo decompresso>" }
#   • Python fa json.loads() + base64.b64decode() → bytes puri, nessun problema
#     di codec, nessuna questione con x-user-defined o latin-1.
#   • Fallback a x-user-defined + ord(c)&0xFF se il JSON fallisce.
# ══════════════════════════════════════════════════════════════════════════════
def _xhr_fetch(scheme, host, port, method, path, headers, body):
    port_def  = 443 if scheme == 'https' else 80
    show_port = f':{port}' if port and port != port_def else ''
    full_url  = f'{scheme}://{host}{show_port}{path}'
    # &fmt=b64 → worker restituisce JSON+base64, puramente ASCII, zero encode issues
    proxy_url = _CF_BASE_PY + _up.quote(full_url, safe='') + _CF_KEY_PY + '&fmt=b64'
    print(f'[http-patch] XHR {method} {full_url[:100]}')

    xhr = js.XMLHttpRequest.new()
    xhr.open(method, proxy_url, False)  # False = sincrono
    # NESSUN overrideMimeType: la risposta è già JSON ASCII puro

    # Invia solo gli header sicuri (i vietati dal browser vengono saltati)
    for k, v in _safe_headers(headers).items():
        try:
            xhr.setRequestHeader(str(k), str(v))
        except Exception:
            pass  # header rifiutato dal browser → continua senza eccezione

    # Body
    if body is not None:
        if isinstance(body, (bytes, bytearray)):
            try:
                xhr.send(js.Uint8Array.new(body))
            except Exception:
                xhr.send(bytes(body).decode('latin-1', errors='replace'))
        else:
            xhr.send(str(body))
    else:
        xhr.send()

    if xhr.status == 0:
        raise OSError(f'XHR network error (status=0) per {full_url[:80]}'
                      ' — verifica CORS / CF Worker')

    raw_text = str(xhr.responseText or '')

    # ── Percorso principale: JSON + base64 ──────────────────────────────────
    try:
        payload = _json.loads(raw_text)
        b64_body = payload.get('body', '')
        body_bytes = _base64.b64decode(b64_body) if b64_body else b''
        return _ProxyResponse(
            status      = payload.get('status', xhr.status),
            reason      = payload.get('statusText', ''),
            headers_dict= payload.get('headers', {}),
            body_bytes  = body_bytes,
            url         = path,
        )
    except Exception as _e:
        print(f'[http-patch] JSON/base64 fallito ({_e}), fallback x-user-defined')

    # ── Fallback: x-user-defined + ord(c)&0xFF ──────────────────────────────
    # Dobbiamo riaprire la richiesta senza fmt=b64
    proxy_url_plain = _CF_BASE_PY + _up.quote(full_url, safe='') + _CF_KEY_PY
    xhr2 = js.XMLHttpRequest.new()
    xhr2.open(method, proxy_url_plain, False)
    xhr2.overrideMimeType('text/plain; charset=x-user-defined')
    for k, v in _safe_headers(headers).items():
        try: xhr2.setRequestHeader(str(k), str(v))
        except Exception: pass
    if body is not None:
        if isinstance(body, (bytes, bytearray)):
            try: xhr2.send(js.Uint8Array.new(body))
            except Exception: xhr2.send(bytes(body).decode('latin-1', errors='replace'))
        else:
            xhr2.send(str(body))
    else:
        xhr2.send()

    fb_text = str(xhr2.responseText or '')
    fb_bytes = bytes(ord(c) & 0xFF for c in fb_text)

    # Costruisci headers dal fallback XHR
    hdr_dict = {}
    for line in str(xhr2.getAllResponseHeaders() or '').strip().splitlines():
        if ':' in line:
            k2, _, v2 = line.partition(':')
            k2s, v2s = k2.strip().lower(), v2.strip()
            if k2s: hdr_dict[k2s] = v2s

    return _ProxyResponse(
        status      = int(xhr2.status or 200),
        reason      = str(xhr2.statusText or 'OK'),
        headers_dict= hdr_dict,
        body_bytes  = fb_bytes,
        url         = path,
    )

# ══════════════════════════════════════════════════════════════════════════════
# _XHRResponse  — simula http.client.HTTPResponse
#
# EREDITA da io.RawIOBase per compatibilità con:
#   - io.BufferedReader(r)  usato da alcune versioni di urllib
#   - socket.SocketIO(r)    usato come fallback da urllib
#   - addinfourl(r, ...)    wrapped direttamente
# ══════════════════════════════════════════════════════════════════════════════
class _XHRResponse(io.RawIOBase):
    def __init__(self, proxy_resp, url):
        super().__init__()
        self._url        = url
        self.debuglevel  = 0
        self.version     = 11
        self.will_close  = True
        self.chunked     = False

        # Status
        self.status  = proxy_resp.status
        self.reason  = proxy_resp.reason

        # ── Parsing headers con http.client.parse_headers ────────────────
        try:
            CRLF = bytes([13, 10])
            buf = io.BytesIO()
            for k, v in (proxy_resp.headers_dict or {}).items():
                ks = str(k).strip()
                vs = str(v).strip()
                if ks:
                    line = (ks + ': ' + vs).encode('iso-8859-1', errors='replace')
                    buf.write(line)
                    buf.write(CRLF)
            buf.write(CRLF)  # riga vuota finale richiesta da parse_headers
            buf.seek(0)
            self.headers = _hc.parse_headers(buf)
        except Exception:
            # Fallback: costruisci a mano un HTTPMessage
            self.headers = _hc.HTTPMessage()
            for k, v in (proxy_resp.headers_dict or {}).items():
                ks, vs = str(k).strip(), str(v).strip()
                if ks:
                    try: self.headers[ks] = vs
                    except Exception: pass

        # .msg è l'alias che urllib sovrascrive con la reason string.
        # Lo inizializziamo vuoto (string) per non rompere codice che lo legge.
        self.msg = proxy_resp.reason  # urllib farà: resp.msg = r.reason

        # ── Body: già bytes puri, nessun problema di encoding ────────────
        raw = proxy_resp.body_bytes

        # ── Decompressione se Content-Encoding presente ──────────────────
        content_enc = self.headers.get('content-encoding', '')
        if content_enc:
            raw, did_decompress = _decompress_body(raw, content_enc)
            if did_decompress:
                del self.headers['content-encoding']
                if 'content-length' in self.headers:
                    del self.headers['content-length']

        self._data  = io.BytesIO(raw)
        self.length = len(raw)

        # ── Attributi di istanza scrivibili (urllib li sovrascrive dopo init) ──
        self.code = self.status   # urllib.response.addinfourl accede a .code
        self.url  = self._url     # urllib sovrascrive con l'URL finale dopo redirect
        self.fp   = self._data    # urllib accede a .fp come file-pointer

    # ── io.RawIOBase  (OBBLIGATORIO per io.BufferedReader) ───────────────
    def readinto(self, buf):
        chunk = self._data.read(len(buf))
        n = len(chunk)
        if n:
            buf[:n] = chunk
        return n

    def readable(self):  return True
    def writable(self):  return False
    def seekable(self):  return False

    # ── Metodi read standard ─────────────────────────────────────────────
    def read(self, amt=None):
        if amt is None or amt < 0:
            return self._data.read()
        return self._data.read(amt)

    def read1(self, amt=-1):
        return self.read(None if amt < 0 else amt)

    def readline(self, size=-1):
        return self._data.readline(-1 if size is None else size)

    def readlines(self, hint=-1):
        return self._data.readlines(hint)

    def peek(self, n=0):
        pos = self._data.tell()
        data = self._data.read(max(n, 256))
        self._data.seek(pos)
        return data

    # ── Metodi socket-like  (per socket.SocketIO compatibility) ──────────
    def recv(self, n):          return self.read(n)
    def recv_into(self, buf):   return self.readinto(buf)
    def gettimeout(self):       return None
    def settimeout(self, t):    pass
    def makefile(self, *a, **kw): return self

    # Pyodide/socket.SocketIO accede a _io_refs
    _io_refs = 0

    # ── Metodi http.client.HTTPResponse ──────────────────────────────────
    def begin(self):            pass
    def isclosed(self):         return self.closed
    def fileno(self):           return -1
    def flush(self):            pass
    def close(self):
        self._data.close()
        super().close()
    def getheader(self, name, default=None):
        return self.headers.get(name, default)
    def getheaders(self):
        return list(self.headers.items())
    def info(self):             return self.headers
    def geturl(self):           return self._url
    def __iter__(self):
        while True:
            line = self.readline()
            if not line:
                break
            yield line
    def __enter__(self):        return self
    def __exit__(self, *a):     self.close()

    # ── Attributi/metodi attesi da urllib.response.addinfourl ────────────
    # IMPORTANTE: urllib imposta .url, .code ecc. come attributi di istanza
    # DOPO la costruzione (es: resp.url = final_url). NON usare @property
    # senza setter — esplode con "property has no setter".
    # Li impostiamo nel __init__ come normali attributi di istanza.
    def getcode(self):           return self.status          # metodo legacy urllib
    def get_header(self, h, d=None): return self.headers.get(h, d)  # yt-dlp usa questo

# ══════════════════════════════════════════════════════════════════════════════
# _XHRConnection / _XHRSConnection  — simulano http.client.HTTPConnection
# ══════════════════════════════════════════════════════════════════════════════
class _XHRConnection:
    _scheme = 'http'
    def __init__(self, host, port=None, timeout=30, **kw):
        self.host     = host
        self.port     = port
        self.timeout  = timeout
        self._method  = 'GET'
        self._path    = '/'
        self._headers = {}
        self._body    = None
    def request(self, method, url, body=None, headers={}, *, encode_chunked=False):
        self._method  = method
        self._path    = url
        self._headers = dict(headers)
        self._body    = body
    def getresponse(self):
        proxy_resp = _xhr_fetch(self._scheme, self.host, self.port,
                                self._method, self._path, self._headers, self._body)
        return _XHRResponse(proxy_resp, self._path)
    def set_debuglevel(self, *a):         pass
    def connect(self):                    pass
    def close(self):                      pass
    def set_tunnel(self, *a, **kw):       pass
    def putrequest(self, method, url, **kw):
        self._method = method; self._path = url
    def putheader(self, key, val):        self._headers[key] = val
    def endheaders(self, body=None, *, encode_chunked=False):
        if body is not None:
            self._body = body
    def send(self, data):                 self._body = data
    @property
    def sock(self):                       return None

class _XHRSConnection(_XHRConnection):
    _scheme = 'https'
    def __init__(self, host, port=None, context=None, **kw):
        super().__init__(host, port, **kw)

_hc.HTTPConnection  = _XHRConnection
_hc.HTTPSConnection = _XHRSConnection
print('[http-patch] OK — XHRConnection installata, stdout/stderr UTF-8 safe')
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
