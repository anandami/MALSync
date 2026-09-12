import { Single as MalSingle } from '../_provider/MyAnimeList_hybrid/single';
import { Single as AniListSingle } from '../_provider/AniList/single';
import { Single as KitsuSingle } from '../_provider/Kitsu/single';
import { Single as SimklSingle } from '../_provider/Simkl/single';
import { Single as ShikiSingle } from '../_provider/Shikimori/single';
import { Single as BakaSingle } from '../_provider/MangaBaka/single';
import { Single as TraktSingle } from '../_provider/Trakt/single';
import { UserList as TraktList } from '../_provider/Trakt/list';
import { malToTrakt } from '../_provider/Trakt/helper';

import { UserList as MalList } from '../_provider/MyAnimeList_hybrid/list';
import { UserList as AnilistList } from '../_provider/AniList/list';
import { UserList as KitsuList } from '../_provider/Kitsu/list';
import { UserList as SimklList } from '../_provider/Simkl/list';
import { UserList as ShikiList } from '../_provider/Shikimori/list';
import { UserList as BakaList } from '../_provider/MangaBaka/list';
import { getSyncMode } from '../_provider/helper';
import { listElement } from '../_provider/listAbstract';
import { status } from '../_provider/definitions';

export async function generateSync(
  masterList: object,
  slaveLists: object[],
  mode,
  typeArray,
  list,
  missing,
) {
  mapToArray(masterList, list, true);

  for (const i in slaveLists) {
    mapToArray(slaveLists[i], list, false);
  }

  for (const i in list) {
    changeCheck(list[i], mode);
    missingCheck(list[i], missing, typeArray, mode);
  }

  await consolidateTraktMultiSeasonFranchises(list, missing, typeArray);
  await filterFalseTraktMissing(missing);
}

// Simkl's per-MAL-entry season mapping isn't reliable enough for franchises
// split across multiple MAL entries (one per season) to each write to their
// own Trakt season independently - two MAL entries of the same franchise can
// both resolve to "season 1" and repeatedly undo each other's history/rating
// writes. Rather than trust that mapping at all for these, collapse every
// MAL entry that resolves to the same Trakt show into a single write: sum
// their watched-episode counts and let
// Trakt/single.ts (in "consolidate" mode) spread that flat total across
// every real season Trakt reports, skipping status and rating entirely so
// this can never re-introduce the same fight over those fields.
async function consolidateTraktMultiSeasonFranchises(
  list: any,
  missing: any[],
  typeArray: any[],
): Promise<void> {
  if (!typeArray.includes('TRAKT')) return;

  const malIds = Object.keys(list)
    .map(Number)
    .filter(id => !Number.isNaN(id) && list[id].master && list[id].master.type === 'anime');

  const groups = new Map<number, number[]>();
  for (let i = 0; i < malIds.length; i++) {
    const malId = malIds[i];
    // eslint-disable-next-line no-await-in-loop
    const info = await malToTrakt(malId, 'anime').catch(() => null);
    if (!info || info.isMovie) continue;
    if (!groups.has(info.traktId)) groups.set(info.traktId, []);
    (groups.get(info.traktId) as number[]).push(malId);
  }

  const allGroups = Array.from(groups.values());
  for (let g = 0; g < allGroups.length; g++) {
    const groupIds = allGroups[g];
    if (groupIds.length < 2) continue;

    let combinedWatchedEp = 0;
    for (let i = 0; i < groupIds.length; i++) {
      const item = list[groupIds[i]];
      combinedWatchedEp += item.master.watchedEp || 0;
      item.slaves = item.slaves.filter((s: any) => getType(s.url) !== 'TRAKT');
      item.diff = item.slaves.some((s: any) => Object.keys(s.diff).length > 0);
    }
    for (let i = missing.length - 1; i >= 0; i--) {
      if (missing[i].syncType === 'TRAKT' && groupIds.includes(missing[i].malId)) {
        missing.splice(i, 1);
      }
    }

    const carrierMalId = groupIds[0];
    missing.push({
      title: list[carrierMalId].master.title,
      type: 'anime',
      syncType: 'TRAKT',
      malId: carrierMalId,
      watchedEp: combinedWatchedEp,
      url: `https://myanimelist.net/anime/${carrierMalId}`,
      error: null,
      traktConsolidated: true,
    });
  }
}

// The bulk Trakt list collapses an entire franchise into one row, resolved to
// whichever season Simkl treats as canonical (see Trakt/list.ts) - a MAL
// entry for any other season of that franchise never matches a slave in the
// bulk comparison above and would sit in "missing" forever, even though
// writing to it already works fine (Trakt/single.ts resolves the right
// season on its own). Trakt's bulk endpoints have no per-season breakdown to
// fix this in the mass fetch itself, so instead re-resolve just the
// candidates that would show as missing - normally a handful, not the whole
// list - one at a time via the same malToTrakt + /progress/watched lookup
// single.ts already does, and drop the ones that are actually already in
// sync.
async function filterFalseTraktMissing(missing: any[]): Promise<void> {
  const candidates = missing.filter(m => m.syncType === 'TRAKT');
  for (let i = 0; i < candidates.length; i++) {
    const miss = candidates[i];
    // eslint-disable-next-line no-await-in-loop
    const satisfied = await isTraktMissingSatisfied(miss).catch(() => false);
    if (satisfied) {
      const idx = missing.indexOf(miss);
      if (idx !== -1) missing.splice(idx, 1);
    }
  }
}

async function isTraktMissingSatisfied(miss: any): Promise<boolean> {
  const single = new TraktSingle(miss.url);
  // Consolidated entries were resolved against the sum of every season in
  // the franchise (see consolidateTraktMultiSeasonFranchises) - checking
  // them here without the same flag compares that combined total against
  // just one season, which can never match, so the item never leaves
  // "missing" even once it's genuinely fully synced.
  if (miss.traktConsolidated) (single as any).setConsolidateSeasons();
  await single.update();
  if (!single.isOnList()) return false;

  const slaveScore = single.getScore();
  const slaveStatus = single.getStatus();

  // Reuse changeCheck so "already synced" is judged by the exact same rules
  // (including the Trakt status-projection block) as a normal diff check -
  // just fed with this one entry's real, season-scoped state instead of the
  // franchise-collapsed bulk row. Consolidated entries never carry their own
  // score/status (consolidateTraktMultiSeasonFranchises skips both), so fall
  // back to whatever Trakt already reports instead of comparing against
  // `undefined`, which would always read as a mismatch and defeat the whole
  // point of this check.
  const item = {
    diff: false,
    master: {
      uid: miss.malId,
      type: miss.type,
      score: miss.score ?? slaveScore,
      watchedEp: miss.watchedEp,
      status: miss.status ?? slaveStatus,
    },
    slaves: [
      {
        url: single.getDisplayUrl(),
        score: slaveScore,
        watchedEp: single.getEpisode(),
        totalEp: single.getTotalEpisodes(),
        status: slaveStatus,
        diff: {},
      },
    ],
  } as any;

  changeCheck(item, 'mirror');
  return !item.diff;
}

export function getType(url) {
  if (utils.isDomainMatching(url, 'anilist.co')) return 'ANILIST';
  if (utils.isDomainMatching(url, 'kitsu.app')) return 'KITSU';
  if (utils.isDomainMatching(url, 'myanimelist.net')) return 'MAL';
  if (utils.isDomainMatching(url, 'simkl.com')) return 'SIMKL';
  if (utils.isDomainMatching(url, 'shikimori.one') || utils.isDomainMatching(url, 'shikimori.io'))
    return 'SHIKI';
  if (utils.isDomainMatching(url, 'mangabaka.org')) return 'MANGABAKA';
  if (utils.isDomainMatching(url, 'trakt.tv')) return 'TRAKT';
  throw 'Type not found';
}

export function mapToArray(provierList, resultList, masterM = false) {
  for (let i = 0; i < provierList.length; i++) {
    const el = provierList[i];
    let temp = resultList[el.malId];
    if (typeof temp === 'undefined') {
      temp = {
        diff: false,
        master: {},
        slaves: [],
      };
    }

    if (masterM) {
      temp.master = el;
    } else {
      el.diff = {};
      temp.slaves.push(el);
    }
    if (!Number.isNaN(el.malId) && el.malId) {
      resultList[el.malId] = temp;
    } else {
      // TODO: List them
    }
  }
}

export function shouldCheckDates(item) {
  return ['MAL', 'ANILIST', 'KITSU', 'MANGABAKA'].includes(getType(item.url));
}

export function shouldCheckRewatchCount(item) {
  return ['MAL', 'ANILIST', 'KITSU', 'SHIKI', 'MANGABAKA'].includes(getType(item.url));
}

export function changeCheck(item, mode) {
  if (item.master && item.master.uid) {
    const checkDates = shouldCheckDates(item.master);
    const checkRewatchCount = shouldCheckRewatchCount(item.master);
    for (let i = 0; i < item.slaves.length; i++) {
      const slave = item.slaves[i];
      if (slave.score !== item.master.score) {
        item.diff = true;
        slave.diff.score = item.master.score;
      }
      if (slave.watchedEp !== item.master.watchedEp) {
        if (item.master.status === status.Completed) {
          if (slave.watchedEp !== slave.totalEp) {
            item.diff = true;
            slave.diff.watchedEp = slave.totalEp;
          }
        } else {
          item.diff = true;
          slave.diff.watchedEp = item.master.watchedEp;
        }
      }
      if (item.master.type === 'manga' && slave.readVol !== item.master.readVol) {
        if (item.master.status === status.Completed) {
          if (slave.readVol !== slave.totalVol) {
            item.diff = true;
            slave.diff.readVol = slave.totalVol;
          }
        } else {
          item.diff = true;
          slave.diff.readVol = item.master.readVol;
        }
      }
      if (normalizeStatus(slave.status) !== normalizeStatus(item.master.status)) {
        // Trakt can only represent watchlist/watching/completed (a status is
        // derived from watch history, so dropped/on-hold don't exist and a
        // fully watched title always reads as completed). Compare against the
        // status Trakt will actually report after a write - otherwise these
        // entries generate a diff that no amount of syncing can ever clear.
        if (getType(slave.url) === 'TRAKT') {
          const masterStatus = normalizeStatus(item.master.status);
          const targetEp =
            masterStatus === status.Completed ? slave.totalEp : item.master.watchedEp;
          let projected = status.PlanToWatch;
          if (targetEp > 0 && slave.totalEp > 0 && targetEp >= slave.totalEp) {
            projected = status.Completed;
          } else if (targetEp > 0) {
            projected = status.Watching;
          }
          if (
            projected === status.Completed &&
            normalizeStatus(slave.status) === status.Watching &&
            slave.watchedEp >= item.master.watchedEp
          ) {
            // The Trakt row covers the whole franchise; this entry's own
            // episodes are all watched, the show only reads "watching"
            // because other seasons exist. Nothing left to write.
            projected = status.Watching;
          }
          if (normalizeStatus(slave.status) !== projected) {
            item.diff = true;
            slave.diff.status = masterStatus;
          }
        } else {
          item.diff = true;
          slave.diff.status = normalizeStatus(item.master.status);
        }
      }
      if (checkDates && shouldCheckDates(slave)) {
        if (slave.startDate !== item.master.startDate) {
          item.diff = true;
          slave.diff.startDate = item.master.startDate;
        }
        if (slave.finishDate !== item.master.finishDate) {
          item.diff = true;
          slave.diff.finishDate = item.master.finishDate;
        }
      }
      if (checkRewatchCount && shouldCheckRewatchCount(slave)) {
        if ((slave.rewatchCount ?? 0) !== (item.master.rewatchCount ?? 0)) {
          item.diff = true;
          slave.diff.rewatchCount = item.master.rewatchCount ?? 0;
        }
      }
    }
  }
}

export function missingCheck(item, missing, types, mode) {
  if (item.master && item.master.uid) {
    const tempTypes: any[] = [];
    tempTypes.push(getType(item.master.url));
    for (let i = 0; i < item.slaves.length; i++) {
      const slave = item.slaves[i];
      tempTypes.push(getType(slave.url));
    }
    for (const t in types) {
      const type = types[t];
      if (!tempTypes.includes(type)) {
        const entry = {
          title: item.master.title,
          type: item.master.type,
          syncType: type,
          malId: item.master.malId,
          score: item.master.score,
          watchedEp: item.master.watchedEp,
          status: item.master.status,
          startDate: item.master.startDate,
          finishDate: item.master.finishDate,
          rewatchCount: item.master.rewatchCount,
          url: `https://myanimelist.net/${item.master.type}/${item.master.malId}`,
          error: null,
        } as Partial<listElement>;
        if (item.master.type === 'manga') {
          entry.readVol = item.master.readVol;
        }
        missing.push(entry);
      }
    }
  }
}

// Sync

export async function syncList(list, thisMissing) {
  for (const i in list) {
    const el = list[i];
    if (el.diff) {
      try {
        await syncListItem(el);
        el.diff = false;
      } catch (e) {
        con.error(e);
      }
    }
  }

  const missing = thisMissing.slice();
  for (const i in missing) {
    const miss = missing[i];
    con.log('Sync missing', miss);
    await syncMissing(miss)
      .then(() => {
        thisMissing.splice(thisMissing.indexOf(miss), 1);
      })
      .catch(e => {
        con.error('Error', e);
        miss.error = e;
      });
  }
}

export async function syncListItem(item) {
  for (let i = 0; i < item.slaves.length; i++) {
    const slave = item.slaves[i];
    con.log('sync list item', slave);
    await syncItem(slave, getType(slave.url));
  }
}

export async function syncMissing(item) {
  // Built conditionally (rather than always including every field) so a
  // consolidated Trakt franchise entry - which only ever sets watchedEp -
  // can leave score/status/dates untouched instead of blanking them.
  item.diff = {};
  if (item.score !== undefined) item.diff.score = item.score;
  if (item.watchedEp !== undefined) item.diff.watchedEp = item.watchedEp;
  if (item.status !== undefined) item.diff.status = normalizeStatus(item.status);
  if (item.startDate !== undefined) item.diff.startDate = item.startDate;
  if (item.finishDate !== undefined) item.diff.finishDate = item.finishDate;
  if (item.rewatchCount !== undefined) item.diff.rewatchCount = item.rewatchCount;
  if (item.type === 'manga' && item.readVol !== undefined) {
    item.diff.readVol = item.readVol;
  }
  return syncItem(item, item.syncType);
}

// eslint-disable-next-line consistent-return
export function syncItem(slave, pageType) {
  if (Object.keys(slave.diff).length !== 0) {
    let singleClass: any;
    if (pageType === 'MAL') {
      singleClass = new MalSingle(slave.url);
    } else if (pageType === 'ANILIST') {
      singleClass = new AniListSingle(slave.url);
    } else if (pageType === 'KITSU') {
      singleClass = new KitsuSingle(slave.url);
    } else if (pageType === 'SIMKL') {
      singleClass = new SimklSingle(slave.url);
    } else if (pageType === 'SHIKI') {
      singleClass = new ShikiSingle(slave.url);
    } else if (pageType === 'MANGABAKA') {
      singleClass = new BakaSingle(slave.url);
    } else if (pageType === 'TRAKT') {
      singleClass = new TraktSingle(slave.url);
      if (slave.traktConsolidated) singleClass.setConsolidateSeasons();
    } else {
      throw 'No sync type';
    }
    singleClass.setSyncMethod('listSync');

    return singleClass
      .update()
      .then(() => {
        if (typeof slave.diff.score !== 'undefined') singleClass.setScore(slave.diff.score);
        if (typeof slave.diff.watchedEp !== 'undefined')
          singleClass.setEpisode(slave.diff.watchedEp);
        if (typeof slave.diff.readVol !== 'undefined') singleClass.setVolume(slave.diff.readVol);
        if (typeof slave.diff.status !== 'undefined')
          singleClass.setStatus(normalizeStatus(slave.diff.status));
        // 'null' is valid for start/finish date
        if (slave.diff.startDate !== undefined) singleClass.setStartDate(slave.diff.startDate);
        if (slave.diff.finishDate !== undefined) singleClass.setFinishDate(slave.diff.finishDate);
        if (typeof slave.diff.rewatchCount !== 'undefined')
          singleClass.setRewatchCount(slave.diff.rewatchCount);
        return singleClass.sync();
      })
      .then(() => {
        return utils.wait(3000);
      })
      .catch(async e => {
        await utils.wait(3000);
        throw e;
      });
  }
}

// retrive lists
export async function retriveLists(
  providerList: {
    providerType: string;
    providerSettings: any;
    listProvider: any;
  }[],
  type,
  getListF,
) {
  const typeArray: any = [];

  const tempMode = getSyncMode(type);
  const masterMode = tempMode === 'MALAPI' ? 'MAL' : tempMode;

  const listP: any = [];

  providerList.forEach(pi => {
    pi.providerSettings.text = api.storage.lang('Loading');
    // @ts-ignore
    listP.push(
      getListF(pi.listProvider, type)
        .then((list: any) => {
          pi.providerSettings.list = list;
          pi.providerSettings.text = api.storage.lang('settings_listsync_provider_done');
          if (masterMode === pi.providerType) pi.providerSettings.master = true;
          typeArray.push(pi.providerType);
        })
        .catch(e => {
          pi.providerSettings.text = e;
        }),
    );
  });

  await Promise.all(listP);

  let master = false;
  const slaves: any = [];

  providerList.forEach(function (pi) {
    if (pi.providerSettings.master) {
      master = pi.providerSettings.list;
    } else if (pi.providerSettings.list !== null) slaves.push(pi.providerSettings.list);
  });

  return {
    master,
    slaves,
    typeArray,
  };
}

export function getListProvider(providerSettingList) {
  return [
    {
      providerType: 'MAL',
      providerSettings: providerSettingList.mal,
      listProvider: MalList,
    },
    {
      providerType: 'ANILIST',
      providerSettings: providerSettingList.anilist,
      listProvider: AnilistList,
    },
    {
      providerType: 'KITSU',
      providerSettings: providerSettingList.kitsu,
      listProvider: KitsuList,
    },
    {
      providerType: 'MANGABAKA',
      providerSettings: providerSettingList.mangabaka,
      listProvider: BakaList,
    },
    {
      providerType: 'SIMKL',
      providerSettings: providerSettingList.simkl,
      listProvider: SimklList,
    },
    {
      providerType: 'SHIKI',
      providerSettings: providerSettingList.shiki,
      listProvider: ShikiList,
    },
    {
      providerType: 'TRAKT',
      providerSettings: providerSettingList.trakt,
      listProvider: TraktList,
    },
  ];
}

export function getList(Prov, type) {
  const listProvider = new Prov(7, type);

  return listProvider
    .getCompleteList()
    .then(list => {
      return list;
    })
    .catch(e => {
      con.m(listProvider.name).error(e);
      throw listProvider.errorMessage(e);
    });
}

export const background = {
  async isEnabled() {
    return api.storage.get('backgroundListSync').then(async function (state) {
      con.info('background list sync state', state);
      if (
        state &&
        state.mode === (await api.settings.getAsync('syncMode')) &&
        state.syncModeSimkl === (await api.settings.getAsync('syncModeSimkl')) &&
        state.splitTracking === (await api.settings.getAsync('splitTracking'))
      ) {
        return true;
      }
      background.disable();
      return false;
    });
  },
  async enable() {
    return api.storage.set('backgroundListSync', {
      mode: await api.settings.getAsync('syncMode'),
      syncModeSimkl: await api.settings.getAsync('syncModeSimkl'),
      splitTracking: await api.settings.getAsync('splitTracking'),
    });
  },
  disable() {
    return api.storage.remove('backgroundListSync');
  },
  async sync() {
    if (await background.isEnabled()) {
      con.log('Start Background list Sync');
      setBadgeText('♻');

      return syncLists('anime')
        .then(() => {
          return syncLists('manga');
        })
        .then(() => {
          setBadgeText('');
        })
        .catch(e => {
          con.error(e);
          setBadgeText('');
        });
    }
    con.error('Background list Sync not allowed');
    return [];

    async function syncLists(type) {
      const mode = 'mirror';
      const list = {};
      const missing = [];

      const providerList = getListProvider({
        mal: {
          text: 'Init',
          list: null,
          master: false,
        },
        anilist: {
          text: 'Init',
          list: null,
          master: false,
        },
        kitsu: {
          text: 'Init',
          list: null,
          master: false,
        },
        mangabaka: {
          text: 'Init',
          list: null,
          master: false,
        },
        simkl: {
          text: 'Init',
          list: null,
          master: false,
        },
        shiki: {
          text: 'Init',
          list: null,
          master: false,
        },
        trakt: {
          text: 'Init',
          list: null,
          master: false,
        },
      });

      const listOptions: any = await retriveLists(providerList, type, getList);

      await generateSync(
        listOptions.master,
        listOptions.slaves,
        mode,
        listOptions.typeArray,
        list,
        missing,
      );
      con.log('Start syncing', list, missing);
      await syncList(list, missing);
    }
  },
};

function normalizeStatus(st: status): status {
  if (st === status.Considering) return status.PlanToWatch;
  return st;
}

function setBadgeText(text: string) {
  // @ts-ignore
  if (api.type === 'userscript') return;
  try {
    chrome.action.setBadgeText({ text });
  } catch (e) {
    con.error(e);
  }
}
