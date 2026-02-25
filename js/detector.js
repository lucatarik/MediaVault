/**
 * MediaDetector - detects platform from URL and fetches metadata
 */
const MediaDetector = (() => {

  // ─── Platform Detection ───────────────────────────────────────────────────
  const PLATFORM_PATTERNS = [
    { platform: 'youtube',   color: '#FF0000', icon: 'fab fa-youtube',    patterns: [/youtube\.com\/watch/, /youtube\.com\/shorts/, /youtu\.be\//] },
    { platform: 'instagram', color: '#E1306C', icon: 'fab fa-instagram',  patterns: [/instagram\.com\/p\//, /instagram\.com\/reel\//, /instagram\.com\/tv\//] },
    { platform: 'instagram-profile', color: '#833AB4', icon: 'fab fa-instagram', patterns: [/instagram\.com\/[^/]+\/?$/] },
    { platform: 'facebook',  color: '#1877F2', icon: 'fab fa-facebook',   patterns: [/facebook\.com\//, /fb\.watch\//] },
    { platform: 'twitter',   color: '#1DA1F2', icon: 'fab fa-twitter',    patterns: [/twitter\.com\//, /x\.com\//] },
    { platform: 'tiktok',    color: '#000000', icon: 'fab fa-tiktok',     patterns: [/tiktok\.com\//] },
    { platform: 'vimeo',     color: '#1AB7EA', icon: 'fab fa-vimeo',      patterns: [/vimeo\.com\//] },
    { platform: 'reddit',    color: '#FF4500', icon: 'fab fa-reddit',     patterns: [/reddit\.com\//] },
    { platform: 'twitch',    color: '#9146FF', icon: 'fab fa-twitch',     patterns: [/twitch\.tv\//] },
    { platform: 'pinterest', color: '#E60023', icon: 'fab fa-pinterest',  patterns: [/pinterest\.(com|it)\//] },
    { platform: 'linkedin',  color: '#0077B5', icon: 'fab fa-linkedin',   patterns: [/linkedin\.com\//] },
    { platform: 'spotify',   color: '#1DB954', icon: 'fab fa-spotify',    patterns: [/spotify\.com\//] },
  ];

  const IMAGE_EXTENSIONS = /\.(jpg|jpeg|png|gif|webp|bmp|svg|avif)(\?.*)?$/i;
  const VIDEO_EXTENSIONS = /\.(mp4|webm|mov|avi|mkv|ogg)(\?.*)?$/i;

  function detectPlatform(url) {
    for (const p of PLATFORM_PATTERNS) {
      if (p.patterns.some(pattern => pattern.test(url))) {
        return { platform: p.platform, color: p.color, icon: p.icon };
      }
    }
    if (IMAGE_EXTENSIONS.test(url)) return { platform: 'image', color: '#6C63FF', icon: 'fas fa-image' };
    if (VIDEO_EXTENSIONS.test(url)) return { platform: 'video', color: '#FF6B6B', icon: 'fas fa-video' };
    return { platform: 'web', color: '#64FFDA', icon: 'fas fa-globe' };
  }

  // ─── ID Extractors ────────────────────────────────────────────────────────
  function extractYouTubeId(url) {
    const patterns = [
      /youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,
      /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
      /youtu\.be\/([a-zA-Z0-9_-]{11})/,
      /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    ];
    for (const p of patterns) {
      const m = url.match(p);
      if (m) return m[1];
    }
    return null;
  }

  function extractVimeoId(url) {
    const m = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
    return m ? m[1] : null;
  }

  function extractInstagramId(url) {
    const m = url.match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
  }

  function extractTikTokId(url) {
    const m = url.match(/tiktok\.com\/@[^/]+\/video\/(\d+)/);
    return m ? m[1] : null;
  }

  // ─── Embed URL Builders ───────────────────────────────────────────────────
  function buildEmbedUrl(url, platform) {
    switch (platform) {
      case 'youtube': {
        const id = extractYouTubeId(url);
        return id ? `https://www.youtube.com/embed/${id}?rel=0&modestbranding=1` : null;
      }
      case 'vimeo': {
        const id = extractVimeoId(url);
        return id ? `https://player.vimeo.com/video/${id}?dnt=1` : null;
      }
      case 'instagram': {
        const id = extractInstagramId(url);
        return id ? `https://www.instagram.com/p/${id}/embed/` : null;
      }
      case 'facebook': {
        return `https://www.facebook.com/plugins/post.php?href=${encodeURIComponent(url)}&show_text=true&width=500`;
      }
      case 'twitter': {
        return null; // handled via oEmbed script injection
      }
      case 'tiktok': {
        const id = extractTikTokId(url);
        return id ? `https://www.tiktok.com/embed/v2/${id}` : null;
      }
      case 'spotify': {
        const m = url.match(/spotify\.com\/(track|album|playlist|episode)\/([a-zA-Z0-9]+)/);
        return m ? `https://open.spotify.com/embed/${m[1]}/${m[2]}` : null;
      }
      default:
        return null;
    }
  }

  function buildThumbnailUrl(url, platform) {
    switch (platform) {
      case 'youtube': {
        const id = extractYouTubeId(url);
        return id ? `https://img.youtube.com/vi/${id}/hqdefault.jpg` : null;
      }
      case 'image':
        return url;
      default:
        return null;
    }
  }

  // ─── Metadata Fetching ────────────────────────────────────────────────────
  async function fetchMetadata(url) {
    // Try microlink.io for OG metadata
    try {
      const apiUrl = `https://api.microlink.io/?url=${encodeURIComponent(url)}&meta=true&screenshot=false&video=false`;
      const res = await fetch(apiUrl);
      if (!res.ok) throw new Error('Microlink error');
      const data = await res.json();
      if (data.status === 'success') {
        return {
          title: data.data.title || '',
          description: data.data.description || '',
          thumbnail: data.data.image?.url || data.data.logo?.url || null,
          author: data.data.author || '',
          publisher: data.data.publisher || '',
        };
      }
    } catch (e) {
      console.warn('Microlink failed, trying fallback:', e);
    }

    // Fallback: try allorigins proxy for OG tags
    try {
      const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
      const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(5000) });
      const data = await res.json();
      if (data.contents) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(data.contents, 'text/html');
        return {
          title: doc.querySelector('meta[property="og:title"]')?.content ||
                 doc.querySelector('title')?.textContent || '',
          description: doc.querySelector('meta[property="og:description"]')?.content ||
                       doc.querySelector('meta[name="description"]')?.content || '',
          thumbnail: doc.querySelector('meta[property="og:image"]')?.content || null,
          author: '',
          publisher: '',
        };
      }
    } catch (e) {
      console.warn('AllOrigins fallback failed:', e);
    }

    return { title: '', description: '', thumbnail: null, author: '', publisher: '' };
  }

  // ─── Hashtag & Keyword Extraction ─────────────────────────────────────────
  function extractHashtags(text) {
    if (!text) return [];
    const matches = text.match(/#[\w\u00C0-\u024F]+/g) || [];
    return matches.map(h => h.toLowerCase().replace('#', ''));
  }

  function extractFromUrl(url) {
    try {
      const u = new URL(url);
      const pathParts = u.pathname.split('/').filter(Boolean);
      const hashtags = extractHashtags(u.hash + ' ' + u.search);
      return { pathParts, hashtags };
    } catch {
      return { pathParts: [], hashtags: [] };
    }
  }

  // ─── Main Analyze Function ────────────────────────────────────────────────
  async function analyze(url, onProgress) {
    onProgress && onProgress('Rilevamento piattaforma...');
    const platformInfo = detectPlatform(url);
    const { platform } = platformInfo;

    onProgress && onProgress('Recupero metadati...');
    const meta = await fetchMetadata(url);

    // Build thumbnail
    let thumbnail = meta.thumbnail || buildThumbnailUrl(url, platform);

    // Build embed
    const embedUrl = buildEmbedUrl(url, platform);

    // Determine media type
    let mediaType = 'link';
    if (platform === 'youtube' || platform === 'vimeo' || platform === 'tiktok') mediaType = 'video';
    else if (platform === 'image') mediaType = 'image';
    else if (platform === 'video') mediaType = 'video';
    else if (platform === 'instagram' || platform === 'twitter' || platform === 'facebook') mediaType = 'post';
    else if (platform === 'spotify') mediaType = 'audio';

    // Extract hashtags from description + url
    const hashtags = [
      ...extractHashtags(meta.description),
      ...extractHashtags(meta.title),
      ...extractFromUrl(url).hashtags
    ].filter((v, i, a) => a.indexOf(v) === i).slice(0, 20);

    return {
      url,
      ...platformInfo,
      mediaType,
      title: meta.title,
      description: meta.description,
      thumbnail,
      embedUrl,
      author: meta.author,
      publisher: meta.publisher,
      hashtags,
      youtubeId: platform === 'youtube' ? extractYouTubeId(url) : null,
    };
  }

  return { analyze, detectPlatform, extractHashtags, buildEmbedUrl, buildThumbnailUrl, extractYouTubeId };
})();
