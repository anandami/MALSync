import { NotAutenticatedError } from '../Errors';
import { ListAbstract, listElement } from '../listAbstract';
import * as helper from './helper';
import * as definitions from '../definitions';

export class UserList extends ListAbstract {
  name = 'Trakt';

  authenticationUrl = helper.activateUrl;

  async getUserObject(): Promise<{ username: string; picture: string; href: string }> {
    return this.call('/users/me?extended=full').then((res: any) => {
      if (res && res.username) {
        return {
          username: String(res.username),
          picture:
            res.images && res.images.avatar && res.images.avatar.full
              ? String(res.images.avatar.full)
              : '',
          href: `https://trakt.tv/users/${res.username}`,
        };
      }
      throw new NotAutenticatedError('Not Authenticated');
    });
  }

  deauth(): Promise<void> {
    return api.settings.set('traktToken', '');
  }

  errorHandling = helper.errorHandling;

  _getSortingOptions(): { icon: string; title: string; value: string; asc?: boolean }[] {
    return [];
  }

  async getPart(): Promise<listElement[]> {
    con.log('[UserList][Trakt]', `status: ${this.status}`);
    if (this.listType === 'manga') throw new Error('Trakt does not support manga');

    return this.syncList().then(async (list: Record<number, helper.TraktCachedShow>) => {
      this.done = true;
      const data = await this.prepareData(Object.values(list), this.status);
      con.log(data);
      return data;
    });
  }

  private async prepareData(
    data: helper.TraktCachedShow[],
    status: number,
  ): Promise<listElement[]> {
    const newData: listElement[] = [];

    for (let i = 0; i < data.length; i++) {
      const el = data[i];

      // Derive MAL status from Trakt data - same rule as the single-item sync,
      // so an entry never shows a different status depending on which one
      // read it.
      const derivedStatus = helper.deriveWatchStatus({
        completedEpisodes: el.watchedEpisodes,
        totalAired: el.totalAired,
        inWatchlist: el.inWatchlist,
      });

      const malStatus = parseInt(helper.translateStatus(derivedStatus));

      if (status !== definitions.status.All && malStatus !== status) {
        continue;
      }

      // Map TMDB → MAL ID. NOTE: a Trakt show that Trakt splits into several
      // seasons still only produces one row here, resolved to whichever MAL
      // entry Simkl treats as canonical (usually season 1) - Trakt's bulk
      // endpoints have no per-season breakdown to disambiguate further, so
      // watchedEp/totalEp below are the whole franchise's totals, not just
      // that one season's. The single-item sync path does not have this
      // limitation.
      // eslint-disable-next-line no-await-in-loop
      const malId = el.tmdbId
        ? await helper.tmdbToMal(el.tmdbId, el.isMovie ? 'movie' : 'tv').catch(() => null)
        : null;

      const cacheKey = helper.getCacheKey(malId, el.traktId, el.isMovie);

      // eslint-disable-next-line no-await-in-loop
      const tempData = await this.fn({
        malId,
        apiCacheKey: malId ?? `trakt:${el.isMovie ? 'm' : ''}${el.traktId}`,
        uid: el.traktId,
        cacheKey,
        type: 'anime',
        title: el.title,
        url: `https://trakt.tv/${el.isMovie ? 'movies' : 'shows'}/${el.slug}`,
        score: el.userRating ?? 0,
        watchedEp: el.watchedEpisodes,
        totalEp: el.totalAired,
        status: malStatus,
        image: '',
        tags: '',
      });

      newData.push(tempData);
    }

    return newData;
  }

  protected syncList = helper.syncList;

  protected call = helper.call;
}
