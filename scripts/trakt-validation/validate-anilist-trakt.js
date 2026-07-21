#!/usr/bin/env node
/**
 * One-off validation: cross-checks every anime entry on an AniList profile
 * against the corresponding Trakt data, using the same MAL -> Simkl -> TMDB
 * -> Trakt resolution chain the MALSync extension itself uses (Trakt has no
 * concept of MAL ids, so this chain is unavoidable) - but read-only, so it
 * can be re-run freely without touching anyone's Trakt account.
 *
 * Flags three kinds of problems:
 *   - MISSING     AniList has progress, nothing found on Trakt for it
 *   - MISMATCH    both have data, but episodes/status/rating disagree
 *   - WRONG_SHOW  the resolved Trakt title doesn't look like the AniList
 *                 title at all - the exact failure mode that sent Toradora's
 *                 data to "Fruits Basket" once before (see MALSync
 *                 src/_provider/Trakt/helper.ts, malToTrakt's v2 cache bump)
 *
 * Usage:
 *   node validate-anilist-trakt.js <anilistUsername> <traktUsername> [--out report.json]
 *
 * Requires Node 18+ (built-in fetch).
 */

const fs = require('fs');
const path = require('path');

const TRAKT_CLIENT_ID = 'kAB0U5mp1WJzbwmab_7vPzB3m6FlaEwISC7P4jyUIWk';
const SIMKL_CLIENT_ID = '90d0be129d5988174e02a05391b5a1315be10f392c64756cbae472ee015a82e4';

// Trakt/Simkl's edge (Cloudflare) 403s Node's default fetch User-Agent as a
// bot - confirmed live: identical request works via curl, fails via bare
// node fetch, works again once a browser-shaped UA is added.
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const TRAKT_HEADERS = {
  'Content-Type': 'application/json',
  'trakt-api-version': '2',
  'trakt-api-key': TRAKT_CLIENT_ID,
  'User-Agent': BROWSER_USER_AGENT,
};
const SIMKL_HEADERS = {
  'Content-Type': 'application/json',
  'simkl-api-key': SIMKL_CLIENT_ID,
  'User-Agent': BROWSER_USER_AGENT,
};

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url, headers, attempt = 0) {
  const res = await fetch(url, { headers });
  if (res.status === 404) return null;
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await wait(1200 * (attempt + 1));
    return fetchJson(url, headers, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} for ${url}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ── AniList ──────────────────────────────────────────────────────────────

const ANILIST_QUERY = `
query ($userName: String) {
  MediaListCollection(userName: $userName, type: ANIME) {
    lists {
      name
      entries {
        status
        score(format: POINT_10)
        progress
        media {
          idMal
          title { romaji english }
          episodes
          format
        }
      }
    }
  }
}`;

async function fetchAniListLibrary(userName) {
  const res = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: ANILIST_QUERY, variables: { userName } }),
  });
  if (!res.ok) {
    throw new Error(`AniList request failed: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(`AniList error: ${JSON.stringify(json.errors)}`);
  }
  const entries = [];
  const lists = json.data.MediaListCollection.lists || [];
  for (const list of lists) {
    for (const entry of list.entries) {
      if (!entry.media.idMal) continue; // nothing to resolve against Trakt without a MAL id
      entries.push({
        malId: entry.media.idMal,
        title: entry.media.title.english || entry.media.title.romaji,
        status: entry.status,
        score: entry.score || 0,
        watchedEp: entry.progress || 0,
        totalEp: entry.media.episodes || null,
        isMovie: entry.media.format === 'MOVIE',
      });
    }
  }
  return entries;
}

// ── Trakt (public profile) ──────────────────────────────────────────────

async function fetchTraktLibrary(userName) {
  const [watchedShows, watchlistShows, ratingsShows, watchedMovies, watchlistMovies, ratingsMovies] =
    await Promise.all([
      fetchJson(`https://api.trakt.tv/users/${userName}/watched/shows?extended=full`, TRAKT_HEADERS),
      fetchJson(`https://api.trakt.tv/users/${userName}/watchlist/shows`, TRAKT_HEADERS),
      fetchJson(`https://api.trakt.tv/users/${userName}/ratings/shows`, TRAKT_HEADERS),
      fetchJson(`https://api.trakt.tv/users/${userName}/watched/movies`, TRAKT_HEADERS),
      fetchJson(`https://api.trakt.tv/users/${userName}/watchlist/movies`, TRAKT_HEADERS),
      fetchJson(`https://api.trakt.tv/users/${userName}/ratings/movies`, TRAKT_HEADERS),
    ]);

  const showsById = new Map();
  const moviesById = new Map();

  (watchedShows || []).forEach(e => {
    if (!e.show || !e.show.ids || !e.show.ids.trakt) return;
    showsById.set(e.show.ids.trakt, {
      title: e.show.title,
      watchedEpisodes: e.plays || 0,
      totalAired: e.show.aired_episodes || 0,
      inWatchlist: false,
      rating: null,
    });
  });
  (watchlistShows || []).forEach(e => {
    if (!e.show || !e.show.ids || !e.show.ids.trakt) return;
    const id = e.show.ids.trakt;
    if (!showsById.has(id)) {
      showsById.set(id, {
        title: e.show.title,
        watchedEpisodes: 0,
        totalAired: e.show.aired_episodes || 0,
        inWatchlist: true,
        rating: null,
      });
    } else {
      showsById.get(id).inWatchlist = true;
    }
  });
  (ratingsShows || []).forEach(e => {
    if (!e.show || !e.show.ids || !e.show.ids.trakt) return;
    const id = e.show.ids.trakt;
    if (!showsById.has(id)) {
      // A show can carry a rating with no watch history and no watchlist
      // entry (confirmed live - a rating-only write that never got its
      // matching episode history written).
      showsById.set(id, {
        title: e.show.title,
        watchedEpisodes: 0,
        totalAired: e.show.aired_episodes || 0,
        inWatchlist: false,
        rating: null,
      });
    }
    showsById.get(id).rating = e.rating;
  });

  (watchedMovies || []).forEach(e => {
    if (!e.movie || !e.movie.ids || !e.movie.ids.trakt) return;
    moviesById.set(e.movie.ids.trakt, {
      title: e.movie.title,
      watched: (e.plays || 0) > 0,
      inWatchlist: false,
      rating: null,
    });
  });
  (watchlistMovies || []).forEach(e => {
    if (!e.movie || !e.movie.ids || !e.movie.ids.trakt) return;
    const id = e.movie.ids.trakt;
    if (!moviesById.has(id)) {
      moviesById.set(id, { title: e.movie.title, watched: false, inWatchlist: true, rating: null });
    } else {
      moviesById.get(id).inWatchlist = true;
    }
  });
  (ratingsMovies || []).forEach(e => {
    if (!e.movie || !e.movie.ids || !e.movie.ids.trakt) return;
    const id = e.movie.ids.trakt;
    if (!moviesById.has(id)) {
      moviesById.set(id, { title: e.movie.title, watched: false, inWatchlist: false, rating: null });
    }
    moviesById.get(id).rating = e.rating;
  });

  return { showsById, moviesById };
}

// ── MAL -> Simkl -> TMDB -> Trakt resolution (mirrors Trakt/helper.ts) ────

let simklGate = Promise.resolve();
function throttledSimkl(fn) {
  const result = simklGate.then(fn);
  simklGate = result.then(() => wait(350), () => wait(350));
  return result;
}

async function resolveMalToTrakt(malId) {
  const searchResult = await throttledSimkl(() =>
    fetchJson(`https://api.simkl.com/search/id?mal=${malId}`, SIMKL_HEADERS),
  );
  const simklId =
    Array.isArray(searchResult) && searchResult[0] && searchResult[0].ids
      ? searchResult[0].ids.simkl
      : null;
  if (!simklId) return { error: 'no_simkl_mapping' };

  const xref = await throttledSimkl(() =>
    fetchJson(`https://api.simkl.com/anime/${simklId}?extended=full`, SIMKL_HEADERS),
  );
  if (!xref || !xref.ids) return { error: 'no_simkl_xref' };

  const isMovie = xref.anime_type === 'movie';
  const seasons =
    Array.isArray(xref.mapped_tvdb_seasons) && xref.mapped_tvdb_seasons.length
      ? xref.mapped_tvdb_seasons
      : [1];

  if (isMovie) {
    if (xref.ids.traktmslug) {
      const movie = await fetchJson(
        `https://api.trakt.tv/movies/${xref.ids.traktmslug}`,
        TRAKT_HEADERS,
      );
      if (movie && movie.ids && movie.ids.trakt) {
        return { traktId: movie.ids.trakt, isMovie: true, seasons: [], resolvedTitle: movie.title };
      }
    }
    return { error: 'movie_unresolved' };
  }

  if (!xref.ids.tmdb) return { error: 'no_tmdb_id' };

  const searchResults = await fetchJson(
    `https://api.trakt.tv/search/tmdb/${xref.ids.tmdb}?type=show`,
    TRAKT_HEADERS,
  );
  const show =
    Array.isArray(searchResults) && searchResults[0] && searchResults[0].show
      ? searchResults[0].show
      : null;
  if (!show || !show.ids || !show.ids.trakt) return { error: 'tmdb_not_on_trakt' };

  return { traktId: show.ids.trakt, isMovie: false, seasons, resolvedTitle: show.title };
}

// ── Title sanity check ───────────────────────────────────────────────────

function normalizeTitle(title) {
  return (title || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function titlesLookRelated(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return true; // can't judge, don't false-flag
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  // Space-collapsed compare first - catches "MARRIAGETOXIN" vs "Marriage
  // Toxin" (same title, one side just has no word breaks) before it ever
  // reaches the word-overlap check below, which would wrongly see them as
  // unrelated single-word non-matches.
  const compactA = na.replace(/ /g, '');
  const compactB = nb.replace(/ /g, '');
  if (compactA === compactB || compactA.includes(compactB) || compactB.includes(compactA)) return true;
  const wordsA = new Set(na.split(' ').filter(w => w.length > 2));
  const wordsB = new Set(nb.split(' ').filter(w => w.length > 2));
  let shared = 0;
  wordsA.forEach(w => {
    if (wordsB.has(w)) shared += 1;
  });
  return shared > 0;
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const [anilistUser, traktUser, ...rest] = process.argv.slice(2);
  if (!anilistUser || !traktUser) {
    console.error('Usage: node validate-anilist-trakt.js <anilistUsername> <traktUsername> [--out report.json]');
    process.exit(1);
  }
  const outIdx = rest.indexOf('--out');
  const outPath = outIdx !== -1 ? rest[outIdx + 1] : path.join(__dirname, 'report.json');

  console.log(`Fetching AniList library for "${anilistUser}"...`);
  const anilist = await fetchAniListLibrary(anilistUser);
  console.log(`  ${anilist.length} anime entries with a MAL id.`);

  console.log(`Fetching Trakt library for "${traktUser}"...`);
  const trakt = await fetchTraktLibrary(traktUser);
  console.log(`  ${trakt.showsById.size} shows, ${trakt.moviesById.size} movies on Trakt.`);

  const report = [];
  for (let i = 0; i < anilist.length; i++) {
    const entry = anilist[i];
    process.stdout.write(`\r[${i + 1}/${anilist.length}] ${entry.title.slice(0, 40).padEnd(40)}`);

    let resolution;
    try {
      // eslint-disable-next-line no-await-in-loop
      resolution = await resolveMalToTrakt(entry.malId);
    } catch (e) {
      resolution = { error: `exception: ${e.message}` };
    }

    const row = {
      malId: entry.malId,
      title: entry.title,
      anilist: {
        status: entry.status,
        watchedEp: entry.watchedEp,
        totalEp: entry.totalEp,
        score: entry.score,
      },
      resolution,
      trakt: null,
      verdict: null,
      notes: [],
    };

    if (resolution.error) {
      row.verdict = 'UNRESOLVED';
      row.notes.push(resolution.error);
    } else {
      const traktEntry = resolution.isMovie
        ? trakt.moviesById.get(resolution.traktId)
        : trakt.showsById.get(resolution.traktId);

      if (!titlesLookRelated(entry.title, resolution.resolvedTitle)) {
        row.verdict = 'WRONG_SHOW';
        row.notes.push(
          `AniList title "${entry.title}" vs resolved Trakt title "${resolution.resolvedTitle}" - no word overlap`,
        );
      } else if (!traktEntry) {
        row.verdict = entry.watchedEp > 0 || entry.status === 'COMPLETED' ? 'MISSING' : 'NOT_STARTED_EITHER';
      } else {
        row.trakt = resolution.isMovie
          ? { watched: traktEntry.watched, rating: traktEntry.rating }
          : {
              watchedEp: traktEntry.watchedEpisodes,
              totalAired: traktEntry.totalAired,
              rating: traktEntry.rating,
            };

        const epMismatch = resolution.isMovie
          ? (entry.watchedEp > 0) !== traktEntry.watched
          : entry.watchedEp !== traktEntry.watchedEpisodes &&
            !(entry.status === 'COMPLETED' && traktEntry.watchedEpisodes >= traktEntry.totalAired);
        const scoreMismatch = entry.score > 0 && traktEntry.rating !== entry.score;

        if (epMismatch || scoreMismatch) {
          row.verdict = 'MISMATCH';
          if (epMismatch) row.notes.push('episode count differs');
          if (scoreMismatch) row.notes.push(`rating differs (AniList ${entry.score} vs Trakt ${traktEntry.rating})`);
        } else {
          row.verdict = 'OK';
        }
      }
    }

    report.push(row);
  }
  console.log('\nDone.');

  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  const counts = {};
  report.forEach(r => {
    counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  });
  console.log('\nSummary:');
  Object.entries(counts).forEach(([verdict, n]) => console.log(`  ${verdict}: ${n}`));
  console.log(`\nFull report written to ${outPath}`);
}

if (require.main === module) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { fetchAniListLibrary, fetchTraktLibrary, resolveMalToTrakt, titlesLookRelated };
