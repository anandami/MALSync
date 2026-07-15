import { NotAutenticatedError } from '../Errors';
import { ListAbstract, listElement } from '../listAbstract';
import * as helper from './helper';
import * as definitions from '../definitions';

export class UserList extends ListAbstract {
  name = 'Trakt';

  authenticationUrl = helper.getAuthUrl();

  async getUserObject(): Promise<{ username: string; picture: string; href: string }> {
    return this.call('/users/me?extended=full').then((res: any) => {
      if (res && res.username) {
        return {
          username: String(res.username),
          picture: res.images && res.images.avatar && res.images.avatar.full
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

      // Derive MAL status from Trakt data
      let derivedStatus: helper.TraktWatchStatus;
      if (el.inWatchlist && el.watchedEpisodes === 0) {
        derivedStatus = 'plantowatch';
      } else if (el.watchedEpisodes > 0) {
        derivedStatus = 'watching';
      } else {
        derivedStatus = 'plantowatch';
      }

      const malStatus = parseInt(helper.translateStatus(derivedStatus) as any);

      if (status !== definitions.status.All && malStatus !== status) {
        continue;
      }

      // Map TMDB → MAL ID
      let malId: number | null = null;
      if (el.tmdbId) {
        const simklResponse = await api.request
          .xhr('GET', {
            url: `https://api.simkl.com/search/id?tmdb=${el.tmdbId}&type=tv`,
            headers: {
              'simkl-api-key': __MAL_SYNC_KEYS__.simkl.id,
              'Content-Type': 'application/json',
            },
          })
          .catch(() => null);

        if (simklResponse && simklResponse.status === 200 && simklResponse.responseText) {
          try {
            const simklData = JSON.parse(simklResponse.responseText);
            if (Array.isArray(simklData) && simklData.length && simklData[0].ids && simklData[0].ids.mal) {
              malId = Number(simklData[0].ids.mal);
            }
          } catch (_e) {
            // ignore parse errors
          }
        }
      }

      const cacheKey = helper.getCacheKey(malId, el.traktId);

      // eslint-disable-next-line no-await-in-loop
      const tempData = await this.fn({
        malId,
        apiCacheKey: malId ?? `trakt:${el.traktId}`,
        uid: el.traktId,
        cacheKey,
        type: 'anime',
        title: el.title,
        url: `https://trakt.tv/shows/${el.slug}`,
        score: el.userRating ?? 0,
        watchedEp: el.watchedEpisodes,
        totalEp: 0, // Trakt doesn't provide total episodes in bulk endpoints
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
