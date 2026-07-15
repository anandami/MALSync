import { SingleAbstract } from '../singleAbstract';
import * as helper from './helper';
import * as definitions from '../definitions';
import { NotAutenticatedError, NotFoundError, UrlNotSupportedError } from '../Errors';

export class Single extends SingleAbstract {
  constructor(protected url: string) {
    super(url);
    this.logger = con.m(this.shortName, '#ed1c24');
    return this;
  }

  private animeInfo: {
    traktId: number;
    slug: string;
    title: string;
    totalEpisodes: number;
    watchedEpisodes: number;
    status: helper.TraktWatchStatus;
    userRating: number | null;
    inWatchlist: boolean;
    seasonsMeta: helper.SeasonEpisodeCount[];
  } | null = null;

  private episodeUpdate = false;

  private statusUpdate = false;

  private ratingUpdate = false;

  private lastSyncedEp = 0;

  shortName = 'Trakt';

  authenticationUrl = helper.getAuthUrl();

  protected rewatchingSupport = false;

  protected datesSupport = false;

  protected handleUrl(url: string): void {
    if (url.match(/trakt\.tv\/shows\/[^/]+/i)) {
      this.type = 'anime';
      this.ids.trakt.slug = utils.urlPart(url, 4);
      return;
    }
    if (url.match(/myanimelist\.net\/(anime|manga)\/\d+/i)) {
      this.type = utils.urlPart(url, 3) === 'anime' ? 'anime' : 'manga';
      this.ids.mal = Number(utils.urlPart(url, 4));
      if (this.type === 'manga') throw new UrlNotSupportedError('Trakt has no manga support');
      return;
    }
    throw new UrlNotSupportedError(url);
  }

  getCacheKey(): number | string {
    return this.getKey(['TRAKT']);
  }

  getPageId(): number {
    return this.ids.trakt.id;
  }

  _getStatus(): definitions.status {
    if (!this.animeInfo) return definitions.status.NoState;
    return parseInt(helper.translateStatus(this.animeInfo.status));
  }

  _setStatus(status: definitions.status): void {
    if (!this.animeInfo) return;

    let traktStatus: helper.TraktWatchStatus;
    if (status === definitions.status.Rewatching) {
      traktStatus = 'watching';
    } else {
      traktStatus =
        (helper.translateStatus(null, parseInt(status.toString())) as helper.TraktWatchStatus) ??
        'watching';
    }

    if (traktStatus !== this.animeInfo.status) {
      this.statusUpdate = true;
    }
    this.animeInfo.status = traktStatus;
  }

  _getStartDate(): never {
    throw new Error('Trakt does not support Start Date');
  }

  _setStartDate(_startDate: definitions.startFinishDate): void {
    // no-op: Trakt does not support Start Date
  }

  _getFinishDate(): never {
    throw new Error('Trakt does not support Finish Date');
  }

  _setFinishDate(_finishDate: definitions.startFinishDate): void {
    // no-op: Trakt does not support Finish Date
  }

  _getRewatchCount(): never {
    throw new Error('Trakt does not support Rewatch Count');
  }

  _setRewatchCount(_rewatchCount: definitions.rewatchCount): void {
    // no-op: Trakt does not support Rewatch Count
  }

  _getScore(): definitions.score {
    if (!this.animeInfo || this.animeInfo.userRating === null) return 0;
    return this.animeInfo.userRating;
  }

  _setScore(score: definitions.score): void {
    if (!this.animeInfo) return;
    const newScore = score === 0 ? null : score;
    if (newScore !== this.animeInfo.userRating) this.ratingUpdate = true;
    this.animeInfo.userRating = newScore;
  }

  _getAbsoluteScore(): definitions.score100 {
    return this.getScore() * 10;
  }

  _setAbsoluteScore(score: definitions.score100): void {
    if (!score) {
      this.setScore(0);
      return;
    }
    if (score < 10) {
      this.setScore(1);
      return;
    }
    this.setScore(Math.round(score / 10));
  }

  _getEpisode(): number {
    if (!this.animeInfo) return 0;
    if (this._getStatus() === definitions.status.Completed) {
      return this._getTotalEpisodes();
    }
    return this.animeInfo.watchedEpisodes;
  }

  _setEpisode(episode: number): void {
    if (!this.animeInfo) return;
    if (episode !== this.animeInfo.watchedEpisodes) this.episodeUpdate = true;
    this.animeInfo.watchedEpisodes = episode;
  }

  _getVolume(): number {
    return 0;
  }

  _setVolume(_volume: number): void {
    // no-op: Trakt does not support volumes
  }

  _getTags(): string {
    return '';
  }

  _setTags(_tags: string): void {
    // no-op: Trakt does not support tags
  }

  _getTitle(_raw = false): string {
    return this.animeInfo ? this.animeInfo.title : '';
  }

  _getTotalEpisodes(): number {
    return this.animeInfo ? this.animeInfo.totalEpisodes : 0;
  }

  _getTotalVolumes(): number {
    return 0;
  }

  _getDisplayUrl(): string {
    if (this.animeInfo && this.animeInfo.slug) {
      const [season] = this.ids.trakt.seasons;
      const single = this.ids.trakt.seasons.length === 1;
      return single
        ? `https://trakt.tv/shows/${this.animeInfo.slug}/seasons/${season}`
        : `https://trakt.tv/shows/${this.animeInfo.slug}`;
    }
    return this.url;
  }

  _getImage(): string {
    return '';
  }

  async _getRating(): Promise<string> {
    return 'N/A';
  }

  async _update(): Promise<void> {
    this._authenticated = true;

    // Resolve Trakt ID + which season(s) this MAL entry maps to
    if (!Number.isNaN(this.ids.mal)) {
      const traktInfo = await helper
        .malToTrakt(this.ids.mal, this.type as 'anime' | 'manga')
        .catch(() => null);
      if (traktInfo) {
        this.ids.trakt.id = traktInfo.traktId;
        this.ids.trakt.slug = traktInfo.slug;
        this.ids.trakt.seasons = traktInfo.seasons;
      }
    } else if (this.ids.trakt.slug && Number.isNaN(this.ids.trakt.id)) {
      const malId = await helper.traktSlugToMal(this.ids.trakt.slug).catch(() => null);
      if (malId) this.ids.mal = malId;
      // Navigating in from a trakt.tv URL only gives us the show slug, and
      // Simkl's reverse lookup always resolves to the franchise's canonical
      // entry - there is no reliable way to know which season the user is
      // actually on, so default to season 1.
      if (!this.ids.trakt.seasons.length) this.ids.trakt.seasons = [1];
    }

    // Load cached entry
    const cached = await this.getSingle(
      !Number.isNaN(this.ids.trakt.id) ? { trakt: this.ids.trakt.id } : { mal: this.ids.mal },
    ).catch(e => {
      if (e instanceof NotAutenticatedError) {
        this._authenticated = false;
        return null;
      }
      throw e;
    });

    this.episodeUpdate = false;
    this.statusUpdate = false;
    this.ratingUpdate = false;

    if (!this._authenticated) throw new NotAutenticatedError('Not Authenticated');

    // If we still don't have a Trakt ID and have a slug, try to fetch it
    if (Number.isNaN(this.ids.trakt.id) && this.ids.trakt.slug) {
      const showResponse = await api.request.xhr('GET', {
        url: `https://api.trakt.tv/shows/${this.ids.trakt.slug}?extended=full`,
        headers: {
          'Content-Type': 'application/json',
          'trakt-api-version': '2',
          'trakt-api-key': helper.clientId,
        },
      });
      if (showResponse.status === 200) {
        const showData = JSON.parse(showResponse.responseText);
        if (showData && showData.ids && showData.ids.trakt) {
          this.ids.trakt.id = Number(showData.ids.trakt);
        }
      }
    }

    if (Number.isNaN(this.ids.trakt.id)) throw new NotFoundError('Trakt: show not found');
    if (!this.ids.trakt.seasons.length) this.ids.trakt.seasons = [1];

    // Get detailed watch progress, broken down by season
    const progress = await this.call(`/shows/${this.ids.trakt.id}/progress/watched`).catch(
      () => null,
    );

    const mappedSeasons: any[] =
      progress && Array.isArray(progress.seasons)
        ? progress.seasons.filter((s: any) => this.ids.trakt.seasons.includes(Number(s.number)))
        : [];

    let completedEpisodes = 0;
    if (mappedSeasons.length) {
      completedEpisodes = mappedSeasons.reduce((sum, s) => sum + (Number(s.completed) || 0), 0);
    } else if (cached) {
      completedEpisodes = cached.watchedEpisodes;
    }

    const totalAired = mappedSeasons.length
      ? mappedSeasons.reduce((sum, s) => sum + (Number(s.aired) || 0), 0)
      : 0;

    // Per-season episode counts, used later to translate a flat episode
    // number back into (season, episode) pairs when writing history. Falls
    // back to a single, unbounded season when progress couldn't be fetched.
    const seasonsMeta: helper.SeasonEpisodeCount[] = mappedSeasons.length
      ? mappedSeasons
          .map(s => ({
            number: Number(s.number),
            episodeCount: Array.isArray(s.episodes) ? s.episodes.length : Number(s.aired) || 0,
          }))
          .sort((a, b) => a.number - b.number)
      : this.ids.trakt.seasons.map(number => ({ number, episodeCount: Infinity }));

    const derivedStatus = helper.deriveWatchStatus({
      completedEpisodes,
      totalAired,
      inWatchlist: cached ? cached.inWatchlist : false,
    });

    this.animeInfo = {
      traktId: this.ids.trakt.id,
      slug: this.ids.trakt.slug,
      title: cached ? cached.title : '',
      totalEpisodes: totalAired,
      watchedEpisodes: completedEpisodes,
      status: derivedStatus,
      userRating: cached ? cached.userRating : null,
      inWatchlist: cached ? cached.inWatchlist : false,
      seasonsMeta,
    };

    this.lastSyncedEp = completedEpisodes;
    this._onList = cached !== null || completedEpisodes > 0;

    this.logger.log('Trakt animeInfo', this.animeInfo);
  }

  async _sync(): Promise<void> {
    if (!this.animeInfo) throw new Error('Trakt: animeInfo not loaded');

    this.logger.log(
      '[SET] status:',
      this.statusUpdate,
      'episode:',
      this.episodeUpdate,
      'rating:',
      this.ratingUpdate,
      'lastSynced:',
      this.lastSyncedEp,
      'cur:',
      this.animeInfo.watchedEpisodes,
    );

    // ── Episode history ───────────────────────────────────────────────────────
    if (this.episodeUpdate || !this.isOnList()) {
      const cur = this.animeInfo.watchedEpisodes;
      const last = this.lastSyncedEp;

      if (cur > last) {
        const now = new Date().toISOString();
        const grouped = helper.groupFlatEpisodesBySeason(last + 1, cur, this.animeInfo.seasonsMeta);
        const seasons = Array.from(grouped.entries()).map(([number, epNumbers]) => ({
          number,
          episodes: epNumbers.map(n => ({ number: n, watched_at: now })),
        }));
        const response = await this.call(
          '/sync/history',
          { shows: [{ ids: { trakt: this.animeInfo.traktId }, seasons }] },
          false,
          'POST',
        );
        this.logger.log('Episode history add response', response);
      } else if (cur < last) {
        const grouped = helper.groupFlatEpisodesBySeason(cur + 1, last, this.animeInfo.seasonsMeta);
        const seasons = Array.from(grouped.entries()).map(([number, epNumbers]) => ({
          number,
          episodes: epNumbers.map(n => ({ number: n })),
        }));
        const response = await this.call(
          '/sync/history/remove',
          { shows: [{ ids: { trakt: this.animeInfo.traktId }, seasons }] },
          false,
          'POST',
        );
        this.logger.log('Episode history remove response', response);
      }

      this.lastSyncedEp = cur;
    }

    // ── Watchlist / status ────────────────────────────────────────────────────
    if (this.statusUpdate || !this.isOnList()) {
      const { status } = this.animeInfo;

      if (status === 'plantowatch') {
        if (!this.animeInfo.inWatchlist) {
          const response = await this.call(
            '/sync/watchlist',
            { shows: [{ ids: { trakt: this.animeInfo.traktId } }] },
            false,
            'POST',
          );
          this.logger.log('Watchlist add response', response);
          this.animeInfo.inWatchlist = true;
        }
      } else if (this.animeInfo.inWatchlist) {
        // For watching / completed / on-hold / dropped → remove from watchlist
        const response = await this.call(
          '/sync/watchlist/remove',
          { shows: [{ ids: { trakt: this.animeInfo.traktId } }] },
          false,
          'POST',
        );
        this.logger.log('Watchlist remove response', response);
        this.animeInfo.inWatchlist = false;
      }
    }

    // ── Rating ────────────────────────────────────────────────────────────────
    if (this.ratingUpdate) {
      if (this.animeInfo.userRating) {
        const response = await this.call(
          '/sync/ratings',
          {
            shows: [
              {
                rating: this.animeInfo.userRating,
                ids: { trakt: this.animeInfo.traktId },
              },
            ],
          },
          false,
          'POST',
        );
        this.logger.log('Rating add response', response);
      } else {
        const response = await this.call(
          '/sync/ratings/remove',
          { shows: [{ ids: { trakt: this.animeInfo.traktId } }] },
          false,
          'POST',
        );
        this.logger.log('Rating remove response', response);
      }
    }

    this.episodeUpdate = false;
    this.statusUpdate = false;
    this.ratingUpdate = false;
  }

  async _delete(): Promise<void> {
    if (!this.animeInfo) throw new Error('Trakt: animeInfo not loaded');

    // Omitting `episodes` removes a season's entire history. Scoping this to
    // just the season(s) this MAL entry maps to (instead of the bare show id,
    // which would wipe every season) keeps other seasons of the same
    // franchise untouched on Trakt.
    //
    // NOTE: watchlist is inherently show-level on Trakt (no per-season
    // watchlist exists), so removing one MAL season entry still clears the
    // whole show from the watchlist - a platform limitation, not a bug here.
    await Promise.all([
      this.call(
        '/sync/history/remove',
        {
          shows: [
            {
              ids: { trakt: this.animeInfo.traktId },
              seasons: this.ids.trakt.seasons.map(number => ({ number })),
            },
          ],
        },
        false,
        'POST',
      ),
      this.call(
        '/sync/watchlist/remove',
        { shows: [{ ids: { trakt: this.animeInfo.traktId } }] },
        false,
        'POST',
      ),
    ]);
  }

  protected syncList = helper.syncList;

  protected getSingle = helper.getSingle;

  protected call = helper.call;

  protected errorHandling = helper.errorHandling;
}
