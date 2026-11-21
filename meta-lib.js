// Pure functions for detecting which narratives ("metas") are running. No database, no network.
const DAY = 86400;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const r2 = (x) => Math.round(x * 100) / 100;

// Words that carry no narrative signal
const STOP = new Set(('the and for coin token sol solana inu of on in to an my is it his her pump fun official new real just you your with from this that ' +
  'cto fart-coin meme memecoin coins tokens finance protocol network labs dao swap').split(' '));

export function words(name = '', symbol = '') {
  const split = (s) => String(s).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const n = split(name), s = split(symbol);
  return { n, all: [...new Set([...n, ...s])], text: [...n, ...s].join(' '), joined: [...n, ...s].join('') };
}

export function compileLexicon(raw) {
  return raw.map((t) => ({ theme: t.theme, set: new Set((t.words || []).map((w) => w.toLowerCase())), res: (t.patterns || []).map((p) => new RegExp(p, 'i')) }));
}

export function themesOf(lex, w) {
  const out = [];
  for (const t of lex) {
    const hit = w.all.some((x) => t.set.has(x) || (x.length > 3 && x.endsWith('s') && t.set.has(x.slice(0, -1))))
      || t.res.some((re) => re.test(w.text) || re.test(w.joined));
    if (hit) out.push(t.theme);
  }
  return out;
}

/** Unigrams and bigrams a token's name contains, for finding narratives the lexicon does not know yet. */
export function termsOf(w) {
  const t = new Set();
  const ok = (x) => x.length >= 3 && !STOP.has(x) && !/^\d+$/.test(x);
  for (const x of w.all) if (ok(x)) t.add(x);
  for (let i = 0; i + 1 < w.n.length; i++) if (ok(w.n[i]) && ok(w.n[i + 1])) t.add(`${w.n[i]} ${w.n[i + 1]}`);
  return t;
}

/**
 * tokens: [{ mint, name, symbol, created (unix s), dayVol: Map<dayIndex, usdVolume>, winner: bool, keys: ... }]
 * groupsOf(token) -> array of group keys the token belongs to.
 * Launch counts use creation time; volume uses the days a token traded.
 */
export function scoreGroups(tokens, groupsOf, { now, minTokens = 4, minVol = 20000, reliable = true } = {}) {
  const dayNow = Math.floor(now / DAY);
  const volIn = (t, a, b) => { let s = 0; for (const [d, v] of t.dayVol) if (d > dayNow - a && d <= dayNow - b) s += v; return s; };
  const peak = (t) => { let m = 0; for (const v of t.dayVol.values()) if (v > m) m = v; return m; };
  const inWin = (t, a, b) => t.created >= now - a * DAY && t.created < now - b * DAY && peak(t) >= minVol;

  let total = 0;
  const groups = new Map();
  for (const t of tokens) {
    total += volIn(t, 7, 0);
    for (const k of new Set(groupsOf(t))) (groups.get(k) || groups.set(k, []).get(k)).push(t);
  }

  const rows = [];
  for (const [key, ts] of groups) {
    const cur = ts.filter((t) => inWin(t, 7, 0)).length;
    const prev = ts.filter((t) => inWin(t, 14, 7)).length;
    const base = ts.filter((t) => inWin(t, 35, 14)).length / 3;
    if (cur < minTokens && prev < minTokens) continue;
    const vol = ts.reduce((s, t) => s + volIn(t, 7, 0), 0);
    const share = total ? vol / total : 0;
    const trend = clamp(Math.log2((cur + 1) / (prev + 1)), -3, 3);
    const vsBase = (cur + 1) / (base + 1);
    let status = 'unrated';
    if (reliable) {
      if (prev >= minTokens && trend <= -1) status = 'cooling';
      else if (cur >= minTokens && vsBase >= 2.5 && trend >= 1) status = share >= 0.15 ? 'hot' : 'emerging';
      else if (cur >= minTokens && share >= 0.1 && trend >= -0.5) status = 'hot';
      else status = cur >= minTokens ? 'steady' : 'faded';
    }
    const top = [...ts].sort((a, b) => volIn(b, 7, 0) - volIn(a, 7, 0));
    rows.push({
      key, tokens_cur: cur, tokens_prev: prev, tokens_base_weekly: r2(base),
      vol_cur: Math.round(vol), vol_share: r2(share), trend: r2(trend), status,
      winners: ts.filter((t) => t.winner && volIn(t, 7, 0) > 0).length,
      examples: top.slice(0, 5).map((t) => t.symbol || t.name),
      rank: share * (1 + clamp(trend, 0, 3)) + 0.01 * ts.filter((t) => t.winner).length,
      mints: new Set(ts.map((t) => t.mint)),
    });
  }
  return rows.sort((a, b) => b.rank - a.rank);
}

/** Fold together terms that appear in mostly the same tokens ("gta" + "gta 6" + "rockstar"). */
export function mergeCooccurring(rows, threshold = 0.6) {
  const kept = [];
  for (const r of rows) {
    const twin = kept.find((k) => {
      let inter = 0;
      for (const m of r.mints) if (k.mints.has(m)) inter++;
      return inter / (r.mints.size + k.mints.size - inter) >= threshold;
    });
    if (twin) (twin.aliases ||= []).push(r.key); else kept.push({ ...r });
  }
  return kept;
}
