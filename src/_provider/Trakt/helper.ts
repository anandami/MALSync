import { status as statusDef } from '../definitions';
import { NotAutenticatedError, parseJson, ServerOfflineError } from '../Errors';
import { Cache } from '../../utils/Cache';

export const clientId = __MAL_SYNC_KEYS__.trakt.id;
const clientSecret = __MAL_SYNC_KEYS__.trakt.secret;

const apiBase = 'https://api.trakt.tv';

export const redirectUri = 'https://malsync.moe/trakt/oauth';

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
      (Object.keys(statusMap) as TraktWatchStatus[]).find(
        key => statusMap[key] === malStatus,
      ) ?? 'watching'
    );
  }
  if (!traktStatus) return statusDef.PlanToWatch;
  return statusMap[traktStatus] ?? statusDef.NoState;
}

// ─── Cache key ────────────────────────────────────────────────────────────────

export function getCacheKey(malId: number | null, traktId: number): number | string {
  if (!malId || Number.isNaN(malId)) {
    return `trakt:${traktId}`;
  }
  return malId;
}

// ─── ID Mapping: MAL ↔ Trakt (via TMDB intermediary) ────────────────────────

async function malToTmdb(malId: number, type: 'anime' | 'manga'): Promise<number | null> {
  if (type === 'manga') return null;

  const cacheObj = new Cache(`trakt/malToTmdb/${malId}`, 30 * 24 * 60 * 60 * 1000);
  if (await cacheObj.hasValue()) return cacheObj.getValue();

  const response = await api.request.xhr('GET', {
    url: `https://api.simkl.com/search/id?mal=${malId}`,
    headers: {
      'simkl-api-key': __MAL_SYNC_KEYS__.simkl.id,
      'Content-Type': 'application/json',
    },
  });

  if (response.status !== 200) return null;
  const data = parseJson(response.responseText);
  if (!Array.isArray(data) || !data.length) return null;

  const tmdbId = data[0] && data[0].ids && data[0].ids.tmdb ? Number(data[0].ids.tmdb) : null;
  if (tmdbId) await cacheObj.setValue(tmdbId);
  return tmdbId;
}

async function tmdbToTrakt(
  tmdbId: number,
): Promise<{ traktId: number; slug: string } | null> {
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

export async function malToTrakt(
  malId: number,
  type: 'anime' | 'manga',
): Promise<{ traktId: number; slug: string } | null> {
  const tmdbId = await malToTmdb(malId, type);
  if (!tmdbId) return null;
  return tmdbToTrakt(tmdbId);
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

  const simklResponse = await api.request.xhr('GET', {
    url: `https://api.simkl.com/search/id?tmdb=${tmdbId}&type=tv`,
    headers: {
      'simkl-api-key': __MAL_SYNC_KEYS__.simkl.id,
      'Content-Type': 'application/json',
    },
  });

  if (simklResponse.status !== 200) return null;
  const simklData = parseJson(simklResponse.responseText);
  if (!Array.isArray(simklData) || !simklData.length) return null;

  const malId =
    simklData[0] && simklData[0].ids && simklData[0].ids.mal
      ? Number(simklData[0].ids.mal)
      : null;
  if (malId) await cacheObj.setValue(malId);
  return malId;
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
): Promise<any> {
  const logger = con.m('Trakt', '#ed1c24').m('call');

  const token = api.settings.get('traktToken');

  if (login && (!token || !token.access_token)) {
    throw new NotAutenticatedError('No Trakt token found');
  }

  const fullUrl = url.startsWith('http') ? url : `${apiBase}${url}`;
  const finalUrl = asParameter && sData
    ? `${fullUrl}?${new URLSearchParams(Object.entries(sData))}`
    : fullUrl;

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

  if (response.status === 401 && login && token && token.refresh_token) {
    await refreshToken(token.refresh_token);
    return this.call(url, sData, asParameter, method, login);
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
  watchedEpisodes: number; // approximated from `plays`
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
  const lastActivities = await this.call('/sync/last_activities').catch(() => null);
  const lastCheck = await api.storage.get('traktLastCheck');

  const newTimestamp =
    lastActivities && lastActivities.episodes
      ? lastActivities.episodes.watched_at
      : null;

  if (lastCheck && newTimestamp && lastCheck === newTimestamp && cacheList) {
    logger.log('Trakt list up to date');
    return cacheList;
  }

  logger.log('Fetching Trakt list');

  // Fetch watched shows, watchlist and ratings in parallel
  const [watched, watchlist, ratings] = await Promise.all([
    this.call('/users/me/watched/shows').catch(() => []),
    this.call('/users/me/watchlist/shows').catch(() => []),
    this.call('/users/me/ratings/shows').catch(() => []),
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
