import { status as statusDef } from '../definitions';
import { NotAutenticatedError, parseJson, ServerOfflineError } from '../Errors';
import { Cache } from '../../utils/Cache';

export const clientId = __MAL_SYNC_KEYS__.trakt.id;
const clientSecret = __MAL_SYNC_KEYS__.trakt.secret;

// NOTE: api.trakt.tv responds 500 to any write (POST) carrying a cross-site
// Origin header - a server-side regression from their 2026-07 auth migration
// (verified live: same request without Origin works; with any foreign Origin
// it dies before reaching authentication). Browsers always attach Origin to
// extension POSTs and fetch can't unset it, so declarative_net.json rule 2
// strips it from every api.trakt.tv request.
const apiBase = 'https://api.trakt.tv';

// Trakt authentication uses the DEVICE flow, not the authorization-code flow:
// this extension has no MALSync-hosted callback page to redirect back to
// (unlike MAL/AniList/Shikimori/MangaBaka, which redirect to a page on
// malsync.moe - a separate site this extension doesn't control). Confirmed
// live that the "out-of-band" authorization-code variant is a dead end on
// Trakt: after approval it literally redirects the browser to
// "urn:ietf:wg:oauth:2.0:oob?code=..." - a scheme no browser can open - so
// the code is issued but never shown to the user. With the device flow the
// extension requests a short user code, the user enters it at
// https://trakt.tv/activate, and the extension polls until approval.
//
// The app registered at https://trakt.tv/oauth/applications must have its
// Redirect URI set to exactly this value (Trakt's own form documents it as
// the device-auth redirect); it is also sent along with token refreshes.
export const redirectUri = 'urn:ietf:wg:oauth:2.0:oob';

export const activateUrl = 'https://trakt.tv/activate';

export interface TraktDeviceCode {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

export async function requestDeviceCode(): Promise<TraktDeviceCode> {
  const response = await api.request.xhr('POST', {
    url: `${apiBase}/oauth/device/code`,
    headers: { 'Content-Type': 'application/json' },
    data: JSON.stringify({ client_id: clientId }),
  });
  if (response.status !== 200) {
    throw new Error(`Trakt device code request failed: ${response.status}`);
  }
  return parseJson(response.responseText);
}

/**
 * One polling attempt of the device-flow token endpoint, translated into an
 * explicit state. Trakt signals "user hasn't approved yet" with 400 and
 * "poll less often" with 429; both are expected mid-flow states, not errors.
 * 404/410 both mean the code is dead (unknown or expired; Trakt sometimes
 * kills codes early) and the flow must be restarted with a fresh code. 418
 * means the user clicked deny on trakt.tv. Connection drops and 5xx are
 * reported as 'network' so the caller keeps polling instead of aborting the
 * whole flow over a hiccup. All responses here are body-less except 200, so
 * the status code is the only signal there is.
 */
export type TraktDevicePollResult =
  | 'pending'
  | 'slow_down'
  | 'code_dead'
  | 'denied'
  | 'network'
  | { access_token: string; refresh_token: string };

export async function pollDeviceToken(deviceCode: string): Promise<TraktDevicePollResult> {
  let response;
  try {
    response = await api.request.xhr('POST', {
      url: `${apiBase}/oauth/device/token`,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ code: deviceCode, client_id: clientId, client_secret: clientSecret }),
    });
  } catch (e) {
    return 'network';
  }

  if (response.status === 200) {
    const res = parseJson(response.responseText);
    return { access_token: res.access_token, refresh_token: res.refresh_token };
  }
  if (response.status === 400) return 'pending';
  if (response.status === 429) return 'slow_down';
  if (response.status === 404 || response.status === 410) return 'code_dead';
  if (response.status === 418) return 'denied';
  if (response.status === 0 || response.status >= 500) return 'network';
  throw new Error(`Trakt device token request failed: ${response.status}`);
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

export function getCacheKey(
  malId: number | null,
  traktId: number,
  isMovie = false,
): number | string {
  if (!malId || Number.isNaN(malId)) {
    // Movie and show ids are separate Trakt sequences that can collide, so
    // movies get their own key namespace.
    return `trakt:${isMovie ? 'm' : ''}${traktId}`;
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

// A fresh cache rebuild maps the whole Trakt list in one go - hundreds of
// sequential Simkl lookups. Simkl rate-limits bursts like that, which stalls
// the extension's global request queue for minutes, so space the lookups out.
let simklGate: Promise<unknown> = Promise.resolve();

function throttledSimkl<T>(request: () => Promise<T>): Promise<T> {
  const result = simklGate.then(request);
  simklGate = result.then(
    () => utils.wait(300),
    () => utils.wait(300),
  );
  return result;
}

interface SimklAnimeXref {
  malId: number | null;
  tmdbId: number | null;
  /** Anime movies live in Trakt's movie namespace, not the show one. */
  isMovie: boolean;
  imdbId: string | null;
  /** Trakt movie slug maintained by Simkl - the most direct movie mapping when present. */
  traktMovieSlug: string | null;
  year: number | null;
  /** Trakt/TVDB season numbers this Simkl anime entry maps to (defaults to [1] when Simkl has no mapping). */
  seasons: number[];
}

// A failed request (rate limit, outage) is NOT the same as "no result":
// callers cache negative answers, and caching a transient failure as "not an
// anime" poisons the mapping for days. Retrying here (rather than letting a
// single 429 kill the whole item for the entire sync run) matters a lot
// during a full cache rebuild, when hundreds of lookups fire in one run and
// Simkl's rate limit is easy to graze even with the throttled spacing.
const SIMKL_MAX_RETRIES = 4;

async function simklFetch(url: string): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    const response = await throttledSimkl(() =>
      api.request.xhr('GET', { url, headers: SIMKL_HEADERS }),
    );
    if (response.status === 200) return parseJson(response.responseText);
    if (response.status === 404) return null;
    if (
      (response.status === 429 || response.status === 0 || response.status >= 500) &&
      attempt < SIMKL_MAX_RETRIES
    ) {
      // eslint-disable-next-line no-await-in-loop
      await utils.wait(1500 * (attempt + 1));
      continue;
    }
    throw new ServerOfflineError(`Simkl request failed: ${response.status} (${url})`);
  }
}

async function simklIdByMal(malId: number): Promise<number | null> {
  const data = await simklFetch(`https://api.simkl.com/search/id?mal=${malId}`);
  const simklId = Array.isArray(data) && data[0] && data[0].ids ? data[0].ids.simkl : null;
  return simklId ? Number(simklId) : null;
}

async function simklIdByTmdb(tmdbId: number, kind: 'tv' | 'movie' = 'tv'): Promise<number | null> {
  const data = await simklFetch(`https://api.simkl.com/search/id?tmdb=${tmdbId}&type=${kind}`);
  const simklId = Array.isArray(data) && data[0] && data[0].ids ? data[0].ids.simkl : null;
  return simklId ? Number(simklId) : null;
}

async function simklAnimeXref(simklId: number): Promise<SimklAnimeXref | null> {
  const data = await simklFetch(`https://api.simkl.com/anime/${simklId}?extended=full`);
  if (!data || !data.ids) return null;

  const seasons =
    Array.isArray(data.mapped_tvdb_seasons) && data.mapped_tvdb_seasons.length
      ? data.mapped_tvdb_seasons.map(Number)
      : [1];

  return {
    malId: data.ids.mal ? Number(data.ids.mal) : null,
    tmdbId: data.ids.tmdb ? Number(data.ids.tmdb) : null,
    isMovie: data.anime_type === 'movie',
    imdbId: data.ids.imdb ? String(data.ids.imdb) : null,
    traktMovieSlug: data.ids.traktmslug ? String(data.ids.traktmslug) : null,
    year: data.year ? Number(data.year) : null,
    seasons,
  };
}

// Public (unauthenticated) GET against api.trakt.tv, with the same
// retry-with-backoff treatment as the Simkl lookups: these calls sit at the
// tail end of the mapping chain (last hop before a Trakt show/movie id is
// known), and without retries a single transient hiccup here silently sank
// an otherwise-correct mapping for well-known titles - the item then shows
// up as "missing" with nothing pointing at why.
const TRAKT_GET_MAX_RETRIES = 3;

export async function traktPublicGet(url: string): Promise<{ status: number; body: any }> {
  const headers = {
    'Content-Type': 'application/json',
    'trakt-api-version': '2',
    'trakt-api-key': clientId,
  };
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      // eslint-disable-next-line no-await-in-loop
      response = await api.request.xhr('GET', { url, headers });
    } catch (e) {
      if (attempt < TRAKT_GET_MAX_RETRIES) {
        // eslint-disable-next-line no-await-in-loop
        await utils.wait(1500 * (attempt + 1));
        continue;
      }
      throw new ServerOfflineError(`Trakt request failed: network error (${url})`);
    }
    if (response.status === 200) {
      return { status: 200, body: parseJson(response.responseText) };
    }
    if (response.status === 404) return { status: 404, body: null };
    if (
      (response.status === 429 || response.status === 0 || response.status >= 500) &&
      attempt < TRAKT_GET_MAX_RETRIES
    ) {
      // eslint-disable-next-line no-await-in-loop
      await utils.wait(1500 * (attempt + 1));
      continue;
    }
    return { status: response.status, body: null };
  }
}

async function tmdbToTrakt(tmdbId: number): Promise<{ traktId: number; slug: string } | null> {
  // v2: a batch of these ended up caching the wrong show for 30 days (traced
  // live to a real case - a MAL entry resolving to a completely unrelated
  // Trakt show). tmdbToMal already got this same namespace bump for the same
  // reason (bug #2); this cache and the two below it never did. Bumping
  // forces every entry to re-resolve from scratch instead of trusting
  // whatever is already sitting in storage.
  const cacheObj = new Cache(`trakt/tmdbToTrakt/v2/${tmdbId}`, 30 * 24 * 60 * 60 * 1000);
  if (await cacheObj.hasValue()) return cacheObj.getValue();

  const { status, body: data } = await traktPublicGet(`${apiBase}/search/tmdb/${tmdbId}?type=show`);

  if (status !== 200 || !Array.isArray(data) || !data.length) return null;

  const show = data[0] && data[0].show ? data[0].show : null;
  if (!show || !show.ids || !show.ids.trakt) return null;

  const result = { traktId: Number(show.ids.trakt), slug: String(show.ids.slug) };
  await cacheObj.setValue(result);
  return result;
}

// Anime movies: Trakt files them under /movies, a fully separate namespace
// from shows. Simkl's numeric ids for a movie belong to TMDB's *movie* id
// space, and Simkl's data is occasionally stale or plain wrong (ids pointing
// at an unrelated TV show that happens to share the number) - resolving with
// the wrong namespace would write the user's history into a random title.
// Resolution order: Trakt movie slug maintained by Simkl (direct GET), then
// IMDB search, then TMDB movie search - every search hit is sanity-checked
// against the movie's release year before being trusted.
async function traktMovieFromXref(
  xref: SimklAnimeXref,
): Promise<{ traktId: number; slug: string } | null> {
  if (xref.traktMovieSlug) {
    const { status, body: data } = await traktPublicGet(`${apiBase}/movies/${xref.traktMovieSlug}`);
    if (status === 200 && data && data.ids && data.ids.trakt) {
      return { traktId: Number(data.ids.trakt), slug: String(data.ids.slug) };
    }
  }

  const searchUrls: string[] = [];
  if (xref.imdbId) searchUrls.push(`${apiBase}/search/imdb/${xref.imdbId}?type=movie`);
  if (xref.tmdbId) searchUrls.push(`${apiBase}/search/tmdb/${xref.tmdbId}?type=movie`);

  for (let u = 0; u < searchUrls.length; u++) {
    // eslint-disable-next-line no-await-in-loop
    const { status, body: data } = await traktPublicGet(searchUrls[u]);
    if (status !== 200 || !Array.isArray(data)) continue;

    for (let i = 0; i < data.length; i++) {
      const entry = data[i];
      if (!entry || !entry.movie || !entry.movie.ids || !entry.movie.ids.trakt) continue;
      if (xref.year && entry.movie.year && Math.abs(Number(entry.movie.year) - xref.year) > 1) {
        continue;
      }
      return { traktId: Number(entry.movie.ids.trakt), slug: String(entry.movie.ids.slug) };
    }
  }

  return null;
}

export interface TraktIdMapping {
  traktId: number;
  slug: string;
  isMovie: boolean;
  /** Which Trakt season number(s) this specific MAL entry corresponds to (shows only). */
  seasons: number[];
}

export async function malToTrakt(
  malId: number,
  type: 'anime' | 'manga',
): Promise<TraktIdMapping | null> {
  if (type === 'manga') return null;

  // v2: see the matching note on tmdbToTrakt above - same poisoning risk,
  // same fix.
  const cacheObj = new Cache(`trakt/malToTrakt/v2/${malId}`, 30 * 24 * 60 * 60 * 1000);
  if (await cacheObj.hasValue()) return cacheObj.getValue();

  const simklId = await simklIdByMal(malId);
  if (!simklId) return null;

  const xref = await simklAnimeXref(simklId);
  if (!xref) return null;

  if (xref.isMovie) {
    const movieInfo = await traktMovieFromXref(xref);
    if (!movieInfo) return null;

    const movieResult: TraktIdMapping = { ...movieInfo, isMovie: true, seasons: [] };
    await cacheObj.setValue(movieResult);
    return movieResult;
  }

  if (!xref.tmdbId) return null;

  const traktInfo = await tmdbToTrakt(xref.tmdbId);
  if (!traktInfo) return null;

  const result: TraktIdMapping = { ...traktInfo, isMovie: false, seasons: xref.seasons };
  await cacheObj.setValue(result);
  return result;
}

export async function tmdbToMal(
  tmdbId: number,
  kind: 'tv' | 'movie' = 'tv',
): Promise<number | null> {
  // Cache misses too ("this Trakt entry is not an anime"): most of a Trakt
  // library is regular TV/movies, and without negative caching every list
  // refresh re-asks Simkl about all of them again. Only DEFINITIVE answers
  // reach this cache - the lookups throw on transient failures (v2 bump
  // discards entries poisoned by rate limits before that distinction).
  const cacheObj = new Cache<number | null>(
    `trakt/tmdbToMal/v2/${kind}/${tmdbId}`,
    7 * 24 * 60 * 60 * 1000,
  );
  if (await cacheObj.hasValue()) return cacheObj.getValue();

  const simklId = await simklIdByTmdb(tmdbId, kind);
  if (!simklId) {
    await cacheObj.setValue(null);
    return null;
  }

  const xref = await simklAnimeXref(simklId);
  const malId = xref ? xref.malId : null;
  await cacheObj.setValue(malId);
  return malId;
}

export async function traktSlugToMal(
  slug: string,
  kind: 'show' | 'movie' = 'show',
): Promise<number | null> {
  // v2: see the matching note on tmdbToTrakt above - same poisoning risk,
  // same fix.
  const cacheObj = new Cache(`trakt/slugToMal/v2/${kind}/${slug}`, 30 * 24 * 60 * 60 * 1000);
  if (await cacheObj.hasValue()) return cacheObj.getValue();

  const { status, body: show } = await traktPublicGet(
    `${apiBase}/${kind === 'movie' ? 'movies' : 'shows'}/${slug}?extended=full`,
  );

  if (status !== 200) return null;
  const tmdbId = show && show.ids && show.ids.tmdb ? Number(show.ids.tmdb) : null;
  if (!tmdbId) return null;

  const malId = await tmdbToMal(tmdbId, kind === 'movie' ? 'movie' : 'tv');
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

// ─── Token refresh ───────────────────────────────────────────────────────────

async function refreshToken(refreshTkn: string): Promise<void> {
  let response;
  try {
    response = await api.request.xhr('POST', {
      url: `${apiBase}/oauth/token`,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        refresh_token: refreshTkn,
        grant_type: 'refresh_token',
      }),
    });
  } catch (e) {
    // Connection dropped mid-request. The stored token may still be
    // perfectly valid, so keep it - wiping it here would force the user
    // through the whole device authentication again over a network blip.
    throw new ServerOfflineError('Trakt token refresh failed: network error');
  }

  if (response.status === 200) {
    const res = parseJson(response.responseText);
    await api.settings.set('traktToken', {
      access_token: res.access_token,
      refresh_token: res.refresh_token,
    });
    return;
  }

  if (response.status === 0 || response.status === 429 || response.status >= 500) {
    // Trakt unreachable or throttling - same reasoning as above.
    throw new ServerOfflineError(`Trakt token refresh failed: ${response.status}`);
  }

  // Definitive rejection (expired/revoked refresh token): only now is the
  // stored token really dead, so drop it and ask for re-authentication.
  await api.settings.set('traktToken', '');
  let message = `OAuth failed: ${response.status}`;
  try {
    const errBody = response.responseText ? parseJson(response.responseText) : {};
    if (errBody.error_description) message = errBody.error_description;
  } catch (e) {
    // Body wasn't JSON - keep the status-based message.
  }
  throw new NotAutenticatedError(message);
}

// ─── Core API call ────────────────────────────────────────────────────────────

// Trakt allows roughly one write (POST/PUT/DELETE) per second. A bulk list
// sync fires several writes per item, so all writes go through this shared
// gate that spaces them out instead of letting them race into 429/5xx
// responses that silently dropped data before.
let writeGate: Promise<unknown> = Promise.resolve();

function throttledWrite<T>(request: () => Promise<T>): Promise<T> {
  const result = writeGate.then(request);
  writeGate = result.then(
    () => utils.wait(1100),
    () => utils.wait(1100),
  );
  return result;
}

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

  const doRequest = () =>
    api.request.xhr(method, {
      url: finalUrl,
      headers,
      data: method !== 'GET' && !asParameter ? JSON.stringify(sData) : undefined,
    });

  // Transient failures (connection drops, 429 rate limits, 5xx) get a few
  // spaced retries before giving up - a bulk sync would otherwise abort item
  // after item over a hiccup that resolves itself seconds later.
  let response;
  for (let attempt = 0; ; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      response = method === 'GET' ? await doRequest() : await throttledWrite(doRequest);
    } catch (e) {
      if (attempt < 2) {
        // eslint-disable-next-line no-await-in-loop
        await utils.wait(1500 * (attempt + 1));
        continue;
      }
      throw new ServerOfflineError('Trakt: network error');
    }
    if (
      (response.status === 429 || response.status === 0 || response.status >= 500) &&
      attempt < 2
    ) {
      // eslint-disable-next-line no-await-in-loop
      await utils.wait(2500 * (attempt + 1));
      continue;
    }
    break;
  }

  // Out of retries: a 429 must surface as an error - the previous behavior
  // of falling through and returning null made rate-limited writes look
  // successful and rate-limited list fetches look like an empty library.
  if (response.status === 429) {
    throw new ServerOfflineError('Trakt: rate limited, try again in a moment');
  }

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
  /** Movies live in Trakt's own id namespace (can collide with show ids). */
  isMovie: boolean;
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

/**
 * Cache record key. Show ids stay as-is (backwards compatible with caches
 * stored before movie support); movies are keyed negative so a movie and a
 * show sharing the same numeric Trakt id never overwrite each other.
 */
export function listKey(traktId: number, isMovie: boolean): number {
  return isMovie ? -traktId : traktId;
}

let cacheList: Record<number, TraktCachedShow> | undefined;

// `last_activities` only bumps its timestamps on additions (watched_at,
// rated_at, ...) - Trakt has no field that reflects a user clearing/removing
// history from their own site, so that comparison alone can never notice a
// manual wipe done outside the extension. Confirmed live: after fully
// clearing a Trakt account's history, the extension kept reporting "Trakt
// list up to date" and replayed a 120-item stale snapshot. `forceFresh`
// skips the shortcut entirely; the bulk list-sync page's own initial fetch
// uses it so the one snapshot every downstream lazy per-item call in that
// session builds on is never more than one real fetch old.
export async function syncList(
  lazy = false,
  forceFresh = false,
): Promise<Record<number, TraktCachedShow>> {
  const logger = con.m('Trakt', '#ed1c24').m('list');

  if (typeof cacheList === 'undefined') {
    const stored = await api.storage.get('traktList');
    cacheList = stored || {};
  } else if (lazy && !forceFresh) {
    return cacheList;
  }

  // Check if Trakt data has changed via last_activities endpoint. The stamp
  // combines episode AND movie history so watching either kind invalidates
  // the cache.
  const lastActivities = await this.call('/sync/last_activities');
  const lastCheck = await api.storage.get('traktLastCheck');

  const episodeStamp =
    lastActivities && lastActivities.episodes && lastActivities.episodes.watched_at
      ? lastActivities.episodes.watched_at
      : '';
  const movieStamp =
    lastActivities && lastActivities.movies && lastActivities.movies.watched_at
      ? lastActivities.movies.watched_at
      : '';
  const newTimestamp = episodeStamp || movieStamp ? `${episodeStamp}|${movieStamp}` : null;

  if (!forceFresh && lastCheck && newTimestamp && lastCheck === newTimestamp && cacheList) {
    logger.log('Trakt list up to date');
    return cacheList;
  }

  logger.log('Fetching Trakt list');

  // Fetch watched shows/movies, watchlists and ratings in parallel.
  // `extended=full` on watched shows is required to get `aired_episodes`,
  // otherwise we can never tell "completed" apart from "still watching" in
  // the bulk list view.
  const [watched, watchlist, ratings, watchedMovies, watchlistMovies, movieRatings] =
    await Promise.all([
      this.call('/users/me/watched/shows', { extended: 'full' }, true),
      this.call('/users/me/watchlist/shows'),
      this.call('/users/me/ratings/shows'),
      this.call('/users/me/watched/movies'),
      this.call('/users/me/watchlist/movies'),
      this.call('/users/me/ratings/movies'),
    ]);

  // A failed fetch must never be mistaken for an empty library: building the
  // cache from a bad response would wipe it, making every entry look missing
  // (and get written to Trakt again) on the next sync.
  const lists = [watched, watchlist, ratings, watchedMovies, watchlistMovies, movieRatings];
  if (lists.some(entry => !Array.isArray(entry))) {
    throw new ServerOfflineError('Trakt: could not fetch lists, keeping previous data');
  }

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
        isMovie: false,
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
          isMovie: false,
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

  // ── Movies (anime movies live in Trakt's movie namespace) ────────────────

  const movieRatingMap: Record<number, number> = {};
  for (let i = 0; i < movieRatings.length; i++) {
    const entry = movieRatings[i];
    if (entry && entry.movie && entry.movie.ids && entry.movie.ids.trakt) {
      movieRatingMap[Number(entry.movie.ids.trakt)] = Number(entry.rating);
    }
  }

  const movieWatchlistSet = new Set<number>();
  for (let i = 0; i < watchlistMovies.length; i++) {
    const entry = watchlistMovies[i];
    if (entry && entry.movie && entry.movie.ids && entry.movie.ids.trakt) {
      movieWatchlistSet.add(Number(entry.movie.ids.trakt));
    }
  }

  for (let i = 0; i < watchedMovies.length; i++) {
    const entry = watchedMovies[i];
    if (!entry || !entry.movie || !entry.movie.ids || !entry.movie.ids.trakt) continue;

    const traktId = Number(entry.movie.ids.trakt);
    newCache[listKey(traktId, true)] = {
      traktId,
      isMovie: true,
      slug: String(entry.movie.ids.slug),
      title: String(entry.movie.title),
      year: Number(entry.movie.year),
      tmdbId: entry.movie.ids.tmdb ? Number(entry.movie.ids.tmdb) : null,
      watchedEpisodes: Number(entry.plays) > 0 ? 1 : 0,
      totalAired: 1,
      inWatchlist: movieWatchlistSet.has(traktId),
      userRating: movieRatingMap[traktId] ?? null,
      lastWatchedAt: entry.last_watched_at ?? null,
    };
  }

  for (let i = 0; i < watchlistMovies.length; i++) {
    const entry = watchlistMovies[i];
    if (!entry || !entry.movie || !entry.movie.ids || !entry.movie.ids.trakt) continue;

    const traktId = Number(entry.movie.ids.trakt);
    if (!newCache[listKey(traktId, true)]) {
      newCache[listKey(traktId, true)] = {
        traktId,
        isMovie: true,
        slug: String(entry.movie.ids.slug),
        title: String(entry.movie.title),
        year: Number(entry.movie.year),
        tmdbId: entry.movie.ids.tmdb ? Number(entry.movie.ids.tmdb) : null,
        watchedEpisodes: 0,
        totalAired: 1,
        inWatchlist: true,
        userRating: movieRatingMap[traktId] ?? null,
        lastWatchedAt: null,
      };
    }
  }

  cacheList = newCache;
  logger.log('Trakt list total', Object.keys(cacheList).length);

  await api.storage.set('traktList', cacheList);
  if (newTimestamp) await api.storage.set('traktLastCheck', newTimestamp);

  return cacheList;
}

export async function getSingle(
  ids: { trakt?: number; mal?: number; isMovie?: boolean },
  lazy = false,
): Promise<TraktCachedShow | null> {
  const list = await this.syncList(lazy);

  if (ids.trakt) {
    const key = listKey(ids.trakt, !!ids.isMovie);
    if (list[key] !== undefined) return list[key];
  }

  if (ids.mal) {
    const traktInfo = await malToTrakt(ids.mal, 'anime');
    if (traktInfo) {
      const key = listKey(traktInfo.traktId, !!traktInfo.isMovie);
      if (list[key] !== undefined) return list[key];
    }
  }

  return null;
}
