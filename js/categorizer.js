/**
 * categorizer.js — Auto-categorizzazione post per keyword/hashtag
 * File: js/categorizer.js
 *
 * LOGICA:
 *   categorize(post) assembla un testo da title + description + hashtags + url,
 *   poi scansiona le keyword di ogni categoria e assegna un punteggio proporzionale
 *   alla lunghezza della keyword (keyword lunghe = più specifiche = score più alto).
 *   Restituisce le top-3 categorie per score.
 */

const Categorizer = (() => {
  const FILE = 'categorizer.js';
  const L  = (fn, msg, d) => MV.log(FILE, fn, msg, d);
  const W  = (fn, msg, d) => MV.warn(FILE, fn, msg, d);

  const CATEGORIES = {
    sport: {
      label: 'Sport', icon: '⚽', color: '#22C55E',
      keywords: ['sport','calcio','football','soccer','basket','basketball','tennis','nuoto','swimming','running','corsa','ciclismo','cycling','fitness','gym','palestra','allenamento','training','workout','champion','campione','gara','race','match','partita','atletica','athletics','nba','serie a','premier','formula 1','f1','moto','golf','rugby','boxe','boxing','martial arts','yoga','pilates','crossfit'],
    },
    travel: {
      label: 'Viaggi', icon: '✈️', color: '#3B82F6',
      keywords: ['travel','viaggio','trip','vacation','vacanza','holiday','turismo','tourism','explore','adventure','avventura','paese','country','città','city','spiaggia','beach','montagna','mountain','lago','lake','mare','sea','hotel','resort','backpacking','roadtrip','wanderlust','passport','volo','flight','destination'],
    },
    food: {
      label: 'Cibo', icon: '🍕', color: '#F59E0B',
      keywords: ['food','cibo','cucina','cooking','recipe','ricetta','restaurant','ristorante','pizza','pasta','sushi','burger','vegan','vegano','foodporn','instafood','chef','colazione','breakfast','pranzo','lunch','cena','dinner','dolce','dessert','cake','torta','cocktail','wine','vino','birra','beer','coffee','caffè'],
    },
    music: {
      label: 'Musica', icon: '🎵', color: '#A855F7',
      keywords: ['music','musica','song','canzone','album','artist','artista','concert','concerto','festival','dance','danza','rock','pop','hip hop','rap','jazz','electronic','elettronica','dj','playlist','spotify','vinyl','live','gig','tour','band','guitar','piano','drums','singing','vocal','remix','beat'],
    },
    tech: {
      label: 'Tech', icon: '💻', color: '#06B6D4',
      keywords: ['tech','technology','tecnologia','coding','programming','software','hardware','app','startup','ai','artificial intelligence','machine learning','blockchain','crypto','nft','metaverse','vr','ar','robot','innovation','innovazione','digital','web','developer','python','javascript','apple','google','microsoft','iphone','android'],
    },
    fashion: {
      label: 'Moda', icon: '👗', color: '#EC4899',
      keywords: ['fashion','moda','style','stile','outfit','clothes','vestiti','dress','shoes','scarpe','luxury','brand','designer','streetwear','vintage','beauty','makeup','skincare','cosmetic','cosmetica','hair','capelli','accessories','accessori','ootd','lookbook','model','modella','runway','couture'],
    },
    art: {
      label: 'Arte', icon: '🎨', color: '#F97316',
      keywords: ['art','arte','design','illustration','illustrazione','painting','pittura','drawing','disegno','photography','fotografia','photo','foto','graphic','grafica','digital art','sculpture','scultura','gallery','museum','museo','exhibition','mostra','creative','creativo','artist','artista','portfolio','architecture','architettura'],
    },
    nature: {
      label: 'Natura', icon: '🌿', color: '#10B981',
      keywords: ['nature','natura','environment','ambiente','ecology','ecologia','wildlife','animali','animals','forest','foresta','ocean','oceano','climate','clima','green','verde','sustainable','sostenibile','plant','piante','flowers','fiori','sky','cielo','sunrise','tramonto','landscape','paesaggio','garden','giardino'],
    },
    news: {
      label: 'News', icon: '📰', color: '#EF4444',
      keywords: ['news','notizie','politics','politica','economy','economia','world','mondo','breaking','urgente','update','aggiornamento','report','analysis','analisi','interview','intervista','press','stampa','government','governo','election','elezioni','war','guerra','crisis','crisi'],
    },
    gaming: {
      label: 'Gaming', icon: '🎮', color: '#7C3AED',
      keywords: ['gaming','game','gioco','videogame','esports','playstation','xbox','nintendo','pc gaming','twitch','stream','gamer','gameplay','fps','rpg','minecraft','fortnite','valorant','league of legends','lol','review','walkthrough','speedrun'],
    },
    motivation: {
      label: 'Motivazione', icon: '💪', color: '#F59E0B',
      keywords: ['motivation','motivazione','inspiration','ispirazione','mindset','success','successo','goal','obiettivo','positive','positivo','life','vita','quote','citazione','growth','crescita','self improvement','productivity','produttività','entrepreneur','imprenditore','business','hustle'],
    },
    entertainment: {
      label: 'Intrattenimento', icon: '🎬', color: '#EF4444',
      keywords: ['movie','film','cinema','series','serie','netflix','comedy','commedia','humor','umorismo','meme','funny','divertente','actor','attore','celebrity','vip','show','tv','streaming','animation','animazione','anime','manga','review','trailer','podcast'],
    },
  };

  function getCategoryList() {
    return Object.entries(CATEGORIES).map(([id, cat]) => ({ id, ...cat }));
  }

  // ─── categorize ────────────────────────────────────────────────────────────
  // Assembla il testo del post, calcola lo score per ogni categoria,
  // restituisce i top-3 catId per score.
  function categorize(post) {
    const FN = 'categorize';
    L(FN, `Categorizzo post: id="${post.id || '?'}" title="${(post.title||'').slice(0,40)}" platform="${post.platform}"`);

    const text = [
      post.title       || '',
      post.description || '',
      (post.hashtags   || []).join(' '),
      post.url         || '',
    ].join(' ').toLowerCase();

    L(FN, `Testo analizzato (${text.length} chars): "${text.slice(0,80)}…"`);
    L(FN, `LOGICA: score = somma lunghezze keyword trovate (keyword lunghe = più specifiche = valore maggiore)`);

    const scores = {};
    let totalMatches = 0;

    for (const [catId, cat] of Object.entries(CATEGORIES)) {
      scores[catId] = 0;
      for (const kw of cat.keywords) {
        if (text.includes(kw)) {
          const kwScore = kw.split(' ').length;
          scores[catId] += kwScore;
          totalMatches++;
          L(FN, `  match: cat="${catId}" kw="${kw}" +${kwScore} → subtotal=${scores[catId]}`);
        }
      }
    }

    const sorted = Object.entries(scores)
      .filter(([, s]) => s > 0)
      .sort(([, a], [, b]) => b - a);

    const top3 = sorted.slice(0, 3).map(([catId]) => catId);
    L(FN, `Totale match trovati: ${totalMatches}`);
    L(FN, `Classifica score:`, Object.fromEntries(sorted.slice(0, 5)));
    L(FN, `✓ Top-3 categorie: [${top3.join(', ')}]`);

    if (top3.length === 0) {
      W(FN, `Nessuna categoria trovata → post resterà non categorizzato`);
    }

    return top3;
  }

  function getCategoryInfo(catId) {
    const FN = 'getCategoryInfo';
    const result = CATEGORIES[catId] || { label: catId, icon: '🏷️', color: '#64748B' };
    L(FN, `catId="${catId}" → label="${result.label}" icon="${result.icon}"`);
    return result;
  }

  L('init', `✓ Categorizer pronto — ${Object.keys(CATEGORIES).length} categorie, ${Object.values(CATEGORIES).reduce((n,c)=>n+c.keywords.length,0)} keyword totali`);
  return { categorize, getCategoryList, getCategoryInfo };
})();
