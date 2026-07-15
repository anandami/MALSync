import { status as statusDef } from '../definitions';
import { NotAutenticatedError, parseJson, ServerOfflineError } from '../Errors';
import { Cache } from '../../utils/Cache';

export const clientId = __MAL_SYNC_KEYS__.trakt.id;
const clientSecret = __MAL_SYNC_KEYS__.trakt.secret;

const apiBase = 'https://api.trakt.tv';

// Trakt's "out-of-band" redirect: instead of redirecting to a callback page
// we control, Trakt displays the authorization code directly on its own
// success page for the user to copy. This app has no MALSync-hosted page to
// redirect to (unlike MAL/AniList/Shikimori/MangaBaka, which redirect to a
// page on malsync.moe - a separate site this extension doesn't control), so
// the user pastes the code manually. This exact redirect URI must also be
// set on the app's page at https://trakt.tv/oauth/applications.
export const redirectUri = 'urn:ietf:wg:oauth:2.0:oob';

export function getAuthUrl(): string {
  return `https://trakt.tv/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}`;
}

// ─── Status translation ───────────────────────────────────────────────────────

export type TraktWatchStatus = 'watching' | 'completed' | 'plantowatch' | 'hold' | 'dropped';

const statusMap: Record<TraktWatchStatus, statusDef> = {
  watching: statusDef.Watching,
  completed: statusDef.Completed,
  plantowatch: statusDef.PlanToWatch,
  hold: statusDef.Onhold,
  dropped: statusDef.Dropped,
};

export function translateStatus(
  traktStatus: TraktWatchStatus | null,
  malStatus: number | null = null,
): any {
  if (malStatus !== null) {
    return (
      (Object.keys(statusMap) as TraktWatchStatus[]).find(key => statusMap[key] === malStatus) ??
      'watching'
    );
  }
  if (!traktStatus) return statusDef.PlanToWatch;
  return statusMap[traktStatus] ?? statusDef.NoState;
}

/**
 * Single source of truth for turning Trakt's raw signals (episodes watched,
 * episodes aired, watchlist membership) into a watch status. Used by both the
 * single-item sync and the bulk list sync so an entry never shows a
 * different status depending on which one read it.
 */
export function deriveWatchStatus(params: {
  completedEpisodes: number;
  totalAired: number;
  inWatchlist: boolean;
}): TraktWatchStatus {
  const { completedEpisodes, totalAired, inWatchlist } = params;
  if (completedEpisodes > 0 && totalAired > 0 && completedEpisodes >= totalAired) {
    return 'completed';
  }
  if (completedEpisodes > 0) return 'watching';
  if (inWatchlist) return 'plantowatch';
  return 'plantowatch';
}

// ─── Cache key ────────────────────────────────────────────────────────────────

export function getCacheKey(malId: number | null, traktId: number): number | string {
  if (!malId || Number.isNaN(malId)) {
    return `trakt:${traktId}`;
  }
  return malId;
}

// ─── ID Mapping: MAL ↔ Trakt (via TMDB, cross-referenced through Simkl) ───────
//
// Trakt has no concept of MAL IDs and models anime as western TV shows: one
// show per franchise, split into numbered seasons (sourced from TVDB/TMDB).
// MAL instead gives each season of a franchise its own, separate entry ID.
// `GET /search/id?mal=X` on Simkl only returns Simkl's own ID - to learn which
// Trakt/TVDB season number a given MAL entry actually corresponds to, we need
// the extended anime lookup below, which exposes `mapped_tvdb_seasons`.
// Getting this wrong doesn't just mis-report progress: writing episode
// history to the wrong season would corrupt the user's real Trakt data for a
// *different* season of the same franchise.

const SIMKL_HEADERS = {
  'simkl-api-key': __MAL_SYNC_KEYS__.simkl.id,
  'Content-Type': 'application/json',
};

interface SimklAnimeXref {
  malId: number | null;
  tmdbId: number | null;
  /** Trakt/TVDB season numbers this Simkl anime entry maps to (defaults to [1] when Simkl has no mapping). */
  seasons: number[];
}

async function simklIdByMal(malId: number): Promise<number | null> {
  const response = await api.request.xhr('GET', {
    url: `https://api.simkl.com/search/id?mal=${malId}`,
    headers: SIMKL_HEADERS,
  });
  if (response.status !== 200) return null;
  const data = parseJson(response.responseText);
  const simklId = Array.isArray(data) && data[0] && data[0].ids ? data[0].ids.simkl : null;
  return simklId ? Number(simklId) : null;
}

async function simklIdByTmdb(tmdbId: number): Promise<number | null> {
  const response = await api.request.xhr('GET', {
    url: `https://api.simkl.com/search/id?tmdb=${tmdbId}&type=tv`,
    headers: SIMKL_HEADERS,
  });
  if (response.status !== 200) return null;
  const data = parseJson(response.responseText);
  const simklId = Array.isArray(data) && data[0] && data[0].ids ? data[0].ids.simkl : null;
  return simklId ? Number(simklId) : null;
}

async function simklAnimeXref(simklId: number): Promise<SimklAnimeXref | null> {
  const response = await api.request.xhr('GET', {
    url: `https://api.simkl.com/anime/${simklId}?extended=full`,
    headers: SIMKL_HEADERS,
  });
  if (response.status !== 200) return null;
  const data = parseJson(response.responseText);
  if (!data || !data.ids) return null;

  const seasons =
    Array.isArray(data.mapped_tvdb_seasons) && data.mapped_tvdb_seasons.length
      ? data.mapped_tvdb_seasons.map(Number)
      : [1];

  return {
    malId: data.ids.mal ? Number(data.ids.mal) : null,
    tmdbId: data.ids.tmdb ? Number(data.ids.tmdb) : null,
    seasons,
  };
}

async function tmdbToTrakt(tmdbId: number): Promise<{ traktId: number; slug: string } | null> {
  const cacheObj = new Cache(`trakt/tmdbToTrakt/${tmdbId}`, 30 * 24 * 60 * 60 * 1000);
  if (await cacheObj.hasValue()) return cacheObj.getValue();

  const response = await api.request.xhr('GET', {
    url: `${apiBase}/search/tmdb/${tmdbId}?type=show`,
    headers: {
      'Content-Type': 'application/json',
      'trakt-api-version': '2',
      'trakt-api-key': clientId,
    },
  });

  if (response.status !== 200) return null;
  const data = parseJson(response.responseText);
  if (!Array.isArray(data) || !data.length) return null;

  const show = data[0] && data[0].show ? data[0].show : null;
  if (!show || !show.ids || !show.ids.trakt) return null;

  const result = { traktId: Number(show.ids.trakt), slug: String(show.ids.slug) };
  await cacheObj.setValue(result);
  return result;
}

export interface TraktIdMapping {
  traktId: number;
  slug: string;
  /** Which Trakt season number(s) this specific MAL entry corresponds to. */
  seasons: number[];
}

export async function malToTrakt(
  malId: number,
  type: 'anime' | 'manga',
): Promise<TraktIdMapping | null> {
  if (type === 'manga') return null;

  const cacheObj = new Cache(`trakt/malToTrakt/${malId}`, 30 * 24 * 60 * 60 * 1000);
  if (await cacheObj.hasValue()) return cacheObj.getValue();

  const simklId = await simklIdByMal(malId);
  if (!simklId) return null;

  const xref = await simklAnimeXref(simklId);
  if (!xref || !xref.tmdbId) return null;

  const traktInfo = await tmdbToTrakt(xref.tmdbId);
  if (!traktInfo) return null;

  const result: TraktIdMapping = { ...traktInfo, seasons: xref.seasons };
  await cacheObj.setValue(result);
  return result;
}

export async function tmdbToMal(tmdbId: number): Promise<number | null> {
  const simklId = await simklIdByTmdb(tmdbId);
  if (!simklId) return null;

  const xref = await simklAnimeXref(simklId);
  return xref ? xref.malId : null;
}

export async function traktSlugToMal(slug: string): Promise<number | null> {
  const cacheObj = new Cache(`trakt/slugToMal/${slug}`, 30 * 24 * 60 * 60 * 1000);
  if (await cacheObj.hasValue()) return cacheObj.getValue();

  const showResponse = await api.request.xhr('GET', {
    url: `${apiBase}/shows/${slug}?extended=full`,
    headers: {
      'Content-Type': 'application/json',
      'trakt-api-version': '2',
      'trakt-api-key': clientId,
    },
  });

  if (showResponse.status !== 200) return null;
  const show = parseJson(showResponse.responseText);
  const tmdbId = show && show.ids && show.ids.tmdb ? Number(show.ids.tmdb) : null;
  if (!tmdbId) return null;

  const malId = await tmdbToMal(tmdbId);
  if (malId) await cacheObj.setValue(malId);
  return malId;
}

// ─── Flat episode number ↔ (season, episode) ─────────────────────────────────
//
// MALSync tracks progress as one flat episode counter per entry. Trakt needs
// a season number for every episode it marks watched. These helpers translate
// between the two using each mapped season's known episode count, so entries
// that map to more than one Trakt season (rare, but possible when MAL groups
// seasons together differently than Trakt/TVDB does) still mark history
// against the right season instead of always season 1.

export interface SeasonEpisodeCount {
  number: number;
  /** Known episode count for this season; Infinity when unknown (single-season fallback). */
  episodeCount: number;
}

export function mapFlatEpisodeToSeason(
  flatEpisode: number,
  seasonsMeta: SeasonEpisodeCount[],
): { season: number; episode: number } | null {
  let offset = 0;
  for (let i = 0; i < seasonsMeta.length; i++) {
    const s = seasonsMeta[i];
    if (flatEpisode <= offset + s.episodeCount) {
      return { season: s.number, episode: flatEpisode - offset };
    }
    offset += s.episodeCount;
  }
  return null;
}

/** Groups every flat episode number in [from, to] by the Trakt season it belongs to. */
export function groupFlatEpisodesBySeason(
  from: number,
  to: number,
  seasonsMeta: SeasonEpisodeCount[],
): Map<number, number[]> {
  const grouped = new Map<number, number[]>();
  for (let i = from; i <= to; i++) {
    const mapped = mapFlatEpisodeToSeason(i, seasonsMeta);
    if (!mapped) continue;
    if (!grouped.has(mapped.season)) grouped.set(mapped.season, []);
    (grouped.get(mapped.season) as number[]).push(mapped.episode);
  }
  return grouped;
}

// ─── OAuth ────────────────────────────────────────────────────────────────────

export async function authRequest(
  data: { code: string } | { refresh_token: string },
): Promise<any> {
  const body: Record<string, string> = {
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  };

  if ('code' in data) {
    body.code = data.code;
    body.grant_type = 'authorization_code';
  } else {
    body.refresh_token = data.refresh_token;
    body.grant_type = 'refresh_token';
  }

  const response = await api.request.xhr('POST', {
    url: `${apiBase}/oauth/token`,
    headers: { 'Content-Type': 'application/json' },
    data: JSON.stringify(body),
  });

  if (response.status !== 200) {
    const errBody = response.responseText ? parseJson(response.responseText) : {};
    throw new NotAutenticatedError(errBody.error_description ?? `OAuth failed: ${response.status}`);
  }

  return parseJson(response.responseText);
}

async function refreshToken(refreshTkn: string): Promise<void> {
  try {
    const res = await authRequest({ refresh_token: refreshTkn });
    await api.settings.set('traktToken', {
      access_token: res.access_token,
      refresh_token: res.refresh_token,
    });
  } catch (e) {
    await api.settings.set('traktToken', '');
    throw new NotAutenticatedError('Trakt token refresh failed');
  }
}

// ─── Core API call ────────────────────────────────────────────────────────────

export async function call(
  url: string,
  sData: any = undefined,
  asParameter = false,
  method: 'GET' | 'POST' | 'DELETE' | 'PUT' = 'GET',
  login = true,
  retried = false,
): Promise<any> {
  const logger = con.m('Trakt', '#ed1c24').m('call');

  const token = api.settings.get('traktToken');

  if (login && (!token || !token.access_token)) {
    throw new NotAutenticatedError('No Trakt token found');
  }

  const fullUrl = url.startsWith('http') ? url : `${apiBase}${url}`;
  const finalUrl =
    asParameter && sData ? `${fullUrl}?${new URLSearchParams(Object.entries(sData))}` : fullUrl;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'trakt-api-version': '2',
    'trakt-api-key': clientId,
  };

  if (login && token && token.access_token) {
    headers.Authorization = `Bearer ${token.access_token}`;
  }

  logger.log(method, finalUrl);

  const response = await api.request.xhr(method, {
    url: finalUrl,
    headers,
    data: method !== 'GET' && !asParameter ? JSON.stringify(sData) : undefined,
  });

  if (response.status === 401 && login && token && token.refresh_token && !retried) {
    await refreshToken(token.refresh_token);
    return this.call(url, sData, asParameter, method, login, true);
  }

  this.errorHandling(null, response.status);

  if (response.responseText && response.responseText.trim()) {
    const res = parseJson(response.responseText);
    this.errorHandling(res, response.status);
    return res;
  }

  return null;
}

export function errorHandling(res: any, code: number): void {
  if ((code > 499 && code < 600) || code === 0) {
    throw new ServerOfflineError(`Server Offline status: ${code}`);
  }
  if (code === 401) {
    throw new NotAutenticatedError('Trakt: authentication required');
  }
  if (res && res.error) {
    throw new Error(res.error);
  }
}

// ─── List cache (shared between Single and UserList) ─────────────────────────

export interface TraktCachedShow {
  traktId: number;
  slug: string;
  title: string;
  year: number;
  tmdbId: number | null;
  watchedEpisodes: number; // approximated from `plays`, summed across all seasons
  totalAired: number; // 0 when unknown - never treat as a real "0 episodes"
  inWatchlist: boolean;
  userRating: number | null;
  lastWatchedAt: string | null;
}

let cacheList: Record<number, TraktCachedShow> | undefined;

export async function syncList(lazy = false): Promise<Record<number, TraktCachedShow>> {
  const logger = con.m('Trakt', '#ed1c24').m('list');

  if (typeof cacheList === 'undefined') {
    const stored = await api.storage.get('traktList');
    cacheList = stored || {};
  } else if (lazy) {
    return cacheList;
  }

  // Check if Trakt data has changed via last_activities endpoint
  const lastActivities = await this.call('/sync/last_activities');
  const lastCheck = await api.storage.get('traktLastCheck');

  const newTimestamp =
    lastActivities && lastActivities.episodes ? lastActivities.episodes.watched_at : null;

  if (lastCheck && newTimestamp && lastCheck === newTimestamp && cacheList) {
    logger.log('Trakt list up to date');
    return cacheList;
  }

  logger.log('Fetching Trakt list');

  // Fetch watched shows, watchlist and ratings in parallel. `extended=full` on
  // watched shows is required to get `aired_episodes`, otherwise we can never
  // tell "completed" apart from "still watching" in the bulk list view.
  const [watched, watchlist, ratings] = await Promise.all([
    this.call('/users/me/watched/shows', { extended: 'full' }, true),
    this.call('/users/me/watchlist/shows'),
    this.call('/users/me/ratings/shows'),
  ]);

  // Build ratings index by Trakt ID
  const ratingMap: Record<number, number> = {};
  if (Array.isArray(ratings)) {
    for (let i = 0; i < ratings.length; i++) {
      const entry = ratings[i];
      if (entry && entry.show && entry.show.ids && entry.show.ids.trakt) {
        ratingMap[Number(entry.show.ids.trakt)] = Number(entry.rating);
      }
    }
  }

  // Build watchlist index by Trakt ID
  const watchlistSet = new Set<number>();
  if (Array.isArray(watchlist)) {
    for (let i = 0; i < watchlist.length; i++) {
      const entry = watchlist[i];
      if (entry && entry.show && entry.show.ids && entry.show.ids.trakt) {
        watchlistSet.add(Number(entry.show.ids.trakt));
      }
    }
  }

  const newCache: Record<number, TraktCachedShow> = {};

  // Process watched shows
  if (Array.isArray(watched)) {
    for (let i = 0; i < watched.length; i++) {
      const entry = watched[i];
      if (!entry || !entry.show || !entry.show.ids || !entry.show.ids.trakt) continue;

      const traktId = Number(entry.show.ids.trakt);
      newCache[traktId] = {
        traktId,
        slug: String(entry.show.ids.slug),
        title: String(entry.show.title),
        year: Number(entry.show.year),
        tmdbId: entry.show.ids.tmdb ? Number(entry.show.ids.tmdb) : null,
        watchedEpisodes: Number(entry.plays) || 0,
        totalAired: Number(entry.show.aired_episodes) || 0,
        inWatchlist: watchlistSet.has(traktId),
        userRating: ratingMap[traktId] ?? null,
        lastWatchedAt: entry.last_watched_at ?? null,
      };
    }
  }

  // Add watchlist-only entries (Plan to Watch, never watched)
  if (Array.isArray(watchlist)) {
    for (let i = 0; i < watchlist.length; i++) {
      const entry = watchlist[i];
      if (!entry || !entry.show || !entry.show.ids || !entry.show.ids.trakt) continue;

      const traktId = Number(entry.show.ids.trakt);
      if (!newCache[traktId]) {
        newCache[traktId] = {
          traktId,
          slug: String(entry.show.ids.slug),
          title: String(entry.show.title),
          year: Number(entry.show.year),
          tmdbId: entry.show.ids.tmdb ? Number(entry.show.ids.tmdb) : null,
          watchedEpisodes: 0,
          totalAired: Number(entry.show.aired_episodes) || 0,
          inWatchlist: true,
          userRating: ratingMap[traktId] ?? null,
          lastWatchedAt: null,
        };
      }
    }
  }

  cacheList = newCache;
  logger.log('Trakt list total', Object.keys(cacheList).length);

  await api.storage.set('traktList', cacheList);
  if (newTimestamp) await api.storage.set('traktLastCheck', newTimestamp);

  return cacheList;
}

export async function getSingle(
  ids: { trakt?: number; mal?: number },
  lazy = false,
): Promise<TraktCachedShow | null> {
  const list = await this.syncList(lazy);

  if (ids.trakt && list[ids.trakt] !== undefined) {
    return list[ids.trakt];
  }

  if (ids.mal) {
    const traktInfo = await malToTrakt(ids.mal, 'anime');
    if (traktInfo && list[traktInfo.traktId] !== undefined) {
      return list[traktInfo.traktId];
    }
  }

  return null;
}
