import { search } from '../_provider/searchFactory';
import { getListbyType } from '../_provider/listFactory';
import { getSingle } from '../_provider/singleFactory';
import { getSyncMode, getProviderOption } from '../_provider/helper';
import { status } from '../_provider/definitions';
import type { listElement } from '../_provider/listAbstract';
import { syncItem, syncMissing, getType, shouldCheckDates } from './syncHandler';

// getType() never returns 'MALAPI' (myanimelist.net URLs always resolve to 'MAL' there), but
// getSyncMode() can. syncItem/syncMissing key their provider dispatch off getType()'s value
// space, so 'MALAPI' has to collapse to 'MAL' before it's compared or passed along - same
// normalization syncHandler.ts's own retriveLists() applies for the same reason.
function normalizedSyncMode(type: 'anime' | 'manga'): string {
  const mode = getSyncMode(type);
  return mode === 'MALAPI' ? 'MAL' : mode;
}

const HISTORY_URL = 'https://www.crunchyroll.com/history';
const START_MESSAGE = 'crunchyrollHarvestStart';
const STATUS_MESSAGE = 'crunchyrollHarvestStatus';
// Generous ceiling for the tab's listener to attach - this is a heavy page and can be slow to load.
const CONNECT_TIMEOUT_MS = 300000;
const CONNECT_RETRY_MS = 500;
const POLL_INTERVAL_MS = 3000;
// Overall ceiling on how long polling keeps checking in before giving up - generous because a long
// history's scroll can legitimately take a while. Each individual poll is short-lived; see
// historyHarvest.ts for why status is polled instead of held open in one long response.
const MAX_HARVEST_MS = 1800000;

export type HarvestedEntry = {
  seriesId: string;
  seriesTitle: string;
  episode: number;
  date: string;
  firstEpisodeDate: string | null;
};

export type CrunchyrollMatch = {
  seriesId: string;
  seriesTitle: string;
  episode: number;
  date: string;
  firstEpisodeDate: string | null;
  malId: number | null;
  malUrl: string | null;
  /** The search result's own URL, already on the user's actually-configured sync provider
   * (search() resolves the provider itself when no syncMode override is passed) - this is what
   * a brand-new list entry must be created at. malUrl above is myanimelist.net-shaped no matter
   * the sync provider and exists only to cross-reference the user's current MAL-keyed list; using
   * it as the write target would always create new entries on MyAnimeList regardless of the
   * configured provider. */
  providerUrl: string | null;
  totalEp?: number;
};

// Carries what's needed to resolve a manually-pasted link for the season *after* the one that
// was actually matched (possibleNextSeason) - the raw harvest match plus the cumulative episode
// count of every prior season already accounted for, since a continuation season's own episode
// number is (match.episode - episodeOffset), not the raw harvested number.
export type NextSeasonLinkContext = {
  match: CrunchyrollMatch;
  episodeOffset: number;
};

export type CrunchyrollDiffItem = {
  malId: number;
  title: string;
  url: string;
  currentEp: number;
  newEp: number;
  finishDate?: string;
  startDate?: string;
  /** True if the harvested episode exceeded this entry's total and had to be capped - likely
   * means Crunchyroll numbers episodes continuously across a franchise's seasons while MAL splits
   * them into separate entries, and a later season's progress needs handling on its own. */
  possibleNextSeason?: boolean;
  nextSeason?: NextSeasonLinkContext;
};

export type CrunchyrollMissingItem = {
  malId: number;
  title: string;
  url: string;
  watchedEp: number;
  finishDate?: string;
  startDate?: string;
  /** True when the harvested history reached this entry's own last episode - the entry is
   * created as Completed instead of Watching. */
  completed?: boolean;
  possibleNextSeason?: boolean;
  nextSeason?: NextSeasonLinkContext;
};

export type CrunchyrollImportPlan = {
  updates: CrunchyrollDiffItem[];
  missing: CrunchyrollMissingItem[];
  unmatched: CrunchyrollMatch[];
};

export async function harvestCrunchyrollHistory(): Promise<{
  entries: HarvestedEntry[];
  reachedBottom: boolean;
}> {
  const tab = await chrome.tabs.create({ url: HISTORY_URL, active: false });
  if (!tab.id) throw new Error('Could not open a Crunchyroll tab');
  const { id: tabId } = tab;

  await sendOnce(tabId, START_MESSAGE);

  const deadline = Date.now() + MAX_HARVEST_MS;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    await utils.wait(POLL_INTERVAL_MS);
    // eslint-disable-next-line no-await-in-loop
    const response = await sendOnce(tabId, STATUS_MESSAGE);
    const state = response?.state;

    if (state?.status === 'done') {
      // The tab is left open on purpose so its console stays readable for troubleshooting; the
      // user can close it, or just leave it - the next run doesn't care that an old tab exists.
      const entries: HarvestedEntry[] = state.data || [];
      const reachedBottom = state.reachedBottom !== false;
      con.log(
        '[Crunchyroll Import] harvest finished:',
        entries.length,
        'series/season entries, reachedBottom:',
        reachedBottom,
        '- with a finish date:',
        entries.filter(e => e.date).length,
        '- with a start date (ep 1 found):',
        entries.filter(e => e.firstEpisodeDate).length,
      );
      return { entries, reachedBottom };
    }
    if (state?.status === 'error') {
      con.error('[Crunchyroll Import] harvest reported an error, tab left open:', tabId, state);
      throw new Error(state.error || 'Harvest failed');
    }
    if (state?.status === 'idle') {
      // We already got an 'ok' response to START above, so a content script reporting 'idle' now
      // means its module state was reset without us asking - most likely the user reloaded the
      // harvest tab (the loading warning invites them to check its console). Nothing will ever
      // finish this run; fail immediately instead of polling a dead run for the full deadline.
      con.error('[Crunchyroll Import] harvest tab reset mid-run (reloaded?), tab:', tabId);
      throw new Error('The Crunchyroll tab reloaded before the history finished loading');
    }
    if (Date.now() > deadline) {
      con.error('[Crunchyroll Import] gave up polling, tab left open for inspection:', tabId);
      throw new Error('Timed out waiting for the Crunchyroll history to finish loading');
    }
    // status === 'running' (or a connection hiccup on this particular poll) - keep polling.
  }
}

// The content script attaches its listener as soon as it loads, but there's no signal for
// "loaded yet" other than trying - chrome.tabs.sendMessage rejects with "Could not establish
// connection" until it has. Retries within CONNECT_TIMEOUT_MS; used for both the initial start
// message and every status poll, since a poll can just as easily land while the tab is briefly
// unresponsive (navigating, GC pause, etc.) as the very first message can.
function sendOnce(tabId: number, name: string): Promise<{ ok: boolean; [key: string]: any }> {
  const connectDeadline = Date.now() + CONNECT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    attempt();

    function attempt() {
      chrome.tabs.sendMessage(tabId, { name }, response => {
        const malformed = !response || typeof response.ok !== 'boolean';
        if (chrome.runtime.lastError || malformed) {
          // "No tab with id" means the tab is gone for good (closed by the user, or by Chrome) -
          // unlike "could not establish connection" (page still loading), no amount of retrying
          // will ever get a response, so fail immediately with an accurate message instead of
          // retrying for the full CONNECT_TIMEOUT_MS and then blaming a page-load timeout.
          if (/no tab with id/i.test(chrome.runtime.lastError?.message || '')) {
            reject(new Error('The Crunchyroll tab was closed before the history finished loading'));
            return;
          }
          if (Date.now() < connectDeadline) {
            setTimeout(attempt, CONNECT_RETRY_MS);
            return;
          }
          reject(new Error('Timed out waiting for the Crunchyroll page to load'));
          return;
        }
        resolve(response);
      });
    }
  });
}

// No confidence score exists for this - same best-effort, first-result approach
// Local/import.ts already uses, since Crunchyroll has no id-mapping service (unlike Trakt/Simkl).
export async function matchToMal(entries: HarvestedEntry[]): Promise<CrunchyrollMatch[]> {
  const matches: CrunchyrollMatch[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    // eslint-disable-next-line no-await-in-loop
    const results = await search(entry.seriesTitle, 'anime').catch(() => []);
    const top = results[0];
    // malUrl() is declared as always async (definitions.ts), but the MAL search provider
    // (MyAnimeList_api/search.ts) returns the string directly - only providers that need an
    // extra network hop to resolve a MAL id (AniList/Kitsu/etc) actually return a Promise.
    // eslint-disable-next-line no-await-in-loop
    const malUrl = top ? await Promise.resolve(top.malUrl()).catch(() => null) : null;
    const malId = malUrl ? parseInt(malUrl.split('/')[4]) : NaN;

    matches.push({
      seriesId: entry.seriesId,
      seriesTitle: entry.seriesTitle,
      episode: entry.episode,
      date: entry.date,
      firstEpisodeDate: entry.firstEpisodeDate,
      malId: Number.isNaN(malId) ? null : malId,
      malUrl,
      providerUrl: top?.url || null,
      totalEp: top?.totalEp,
    });
  }

  con.log(
    '[Crunchyroll Import] matched',
    matches.filter(m => m.malId).length,
    'of',
    matches.length,
    'harvested series to a MAL id',
  );

  return matches;
}

// Crunchyroll dates are DD/MM/YYYY; MAL/AniList expect YYYY-MM-DD (definitions.ts).
function toIsoDate(dateStr: string): string | undefined {
  const match = dateStr.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return undefined;
  const [, day, month, year] = match;
  return `${year}-${month}-${day}`;
}

type Progress = {
  /** True when Crunchyroll's episode number exceeds this entry's own total - Crunchyroll numbers
   * episodes continuously across a franchise's seasons (e.g. "Snow White with the Red Hair") while
   * the destination provider splits them into separate entries per season. Title search can't know
   * a season split exists, so the episode written is capped at this entry's own total (never sent
   * out of range) and flagged so the UI can offer linking the next season - this only prevents a
   * bad write, it doesn't locate/write the next season on its own. */
  possibleNextSeason: boolean;
  cappedEpisode: number;
  /** Only set once the (capped) progress actually reaches this entry's own last episode - a
   * "latest episode watched" date is not the same thing as "finished the series", so this must
   * never be set just because *some* episode was the most recent one found. */
  finishDate?: string;
  /** Date of episode 1, if it was also found in the scraped history. */
  startDate?: string;
  /** True once the (capped) progress reaches this entry's own last episode - independent of
   * finishDate, since a capped possibleNextSeason case reaches the last episode without the
   * harvest knowing exactly when that happened. */
  completed: boolean;
};

function computeProgress(
  episode: number,
  date: string,
  firstEpisodeDate: string | null,
  totalEp: number | undefined,
): Progress {
  const possibleNextSeason = Boolean(totalEp && episode > totalEp);
  const cappedEpisode = possibleNextSeason ? (totalEp as number) : episode;
  const reachedLastEpisode = Boolean(totalEp) && cappedEpisode >= (totalEp as number);
  const startDate = firstEpisodeDate ? toIsoDate(firstEpisodeDate) : undefined;
  // When capping applies, `date` is the watch date of a higher (later-season) episode, not of
  // this season's own last episode - we don't actually know when this season finished, so leave
  // finishDate unset rather than stamping it with a date that belongs to a different season.
  const finishDate = reachedLastEpisode && !possibleNextSeason ? toIsoDate(date) : undefined;

  return {
    possibleNextSeason,
    cappedEpisode,
    finishDate,
    startDate,
    // Completion is about reaching the last episode, not about knowing when - kept independent
    // of finishDate so a capped season (finishDate intentionally left unset above) still gets
    // marked Completed instead of incorrectly falling back to Watching.
    completed: reachedLastEpisode,
  };
}

// Only watchedEp and dates are touched for entries that already exist on the user's real list -
// score/status/rewatchCount are left alone so a manual "Dropped"/rating isn't silently reverted
// just because Crunchyroll has playback history. Either date can trigger an update even when the
// episode count itself hasn't changed (e.g. an entry already marked Completed with the right
// episode count but no dates recorded) - but only to fill in a date that's currently empty, never
// to overwrite one that's already set. New entries are created as Completed (with both dates)
// only when the harvested history actually reaches this entry's last episode and also found
// episode 1 - otherwise they're created as Watching, same as before.
export async function buildImportPlan(matches: CrunchyrollMatch[]): Promise<CrunchyrollImportPlan> {
  const type = 'anime' as const;
  const syncMode = getSyncMode(type);
  const listProvider = getListbyType(syncMode, [status.All, type]);
  const currentList: listElement[] = await listProvider.getCompleteList();

  const byMalId = new Map<number, listElement>();
  currentList.forEach(el => {
    if (el.malId) byMalId.set(Number(el.malId), el);
  });

  // Two harvested Crunchyroll entries can independently resolve to the same provider entry (a
  // sub/dub pair, or two title-search hits landing on the same result) - without this, both would
  // become separate plan items sharing one malId, and applying them in sequence would let
  // whichever syncs last silently overwrite the other's (possibly higher) episode count. Keep
  // only the one with the most progress per malId before building the plan.
  const dedupedMatches: CrunchyrollMatch[] = [];
  const bestByMalId = new Map<number, CrunchyrollMatch>();
  matches.forEach(match => {
    if (!match.malId) {
      dedupedMatches.push(match);
      return;
    }
    const current = bestByMalId.get(match.malId);
    if (!current || match.episode > current.episode) {
      bestByMalId.set(match.malId, match);
    }
  });
  dedupedMatches.push(...bestByMalId.values());

  const updates: CrunchyrollDiffItem[] = [];
  const missing: CrunchyrollMissingItem[] = [];
  const unmatched: CrunchyrollMatch[] = [];

  dedupedMatches.forEach(match => {
    if (!match.malId || !match.malUrl || !match.providerUrl) {
      unmatched.push(match);
      return;
    }

    const existing = byMalId.get(match.malId);
    const matchedTotalEp = existing ? existing.totalEp : match.totalEp;
    const progress = computeProgress(
      match.episode,
      match.date,
      match.firstEpisodeDate,
      matchedTotalEp,
    );
    const nextSeason: NextSeasonLinkContext | undefined = progress.possibleNextSeason
      ? { match, episodeOffset: matchedTotalEp as number }
      : undefined;

    if (existing) {
      // Simkl/Shikimori list snapshots never carry startDate/finishDate at all (datesSupport is
      // false for both), so "existing.finishDate is empty" there means "this provider doesn't
      // expose dates", not "no date is recorded" - filling it in would silently invent/overwrite
      // provider-side state we can't actually see. shouldCheckDates() is the same gate
      // syncHandler.ts's own list-sync diffing uses for this.
      const canFillDates = shouldCheckDates(existing);
      const epChanged = progress.cappedEpisode > existing.watchedEp;
      const fillFinishDate =
        canFillDates && progress.finishDate && !existing.finishDate
          ? progress.finishDate
          : undefined;
      const fillStartDate =
        canFillDates && progress.startDate && !existing.startDate ? progress.startDate : undefined;

      if (epChanged || fillFinishDate || fillStartDate || nextSeason) {
        updates.push({
          malId: match.malId,
          title: existing.title,
          url: existing.url,
          currentEp: existing.watchedEp,
          newEp: epChanged ? progress.cappedEpisode : existing.watchedEp,
          finishDate: fillFinishDate,
          startDate: fillStartDate,
          possibleNextSeason: progress.possibleNextSeason,
          nextSeason,
        });
      } else {
        con.log('[Crunchyroll Import] no diff, skipped:', existing.title, {
          harvestedEp: match.episode,
          malWatchedEp: existing.watchedEp,
          totalEp: existing.totalEp,
          harvestedFinishDateRaw: match.date,
          harvestedStartDateRaw: match.firstEpisodeDate,
          malStartDate: existing.startDate,
          malFinishDate: existing.finishDate,
        });
      }
    } else {
      missing.push({
        malId: match.malId,
        title: match.seriesTitle,
        // The provider-native URL (not malUrl, which is always myanimelist.net-shaped) - this is
        // what determines which provider applyCrunchyrollImport() actually writes the new entry
        // to, via getType(item.url).
        url: match.providerUrl,
        watchedEp: progress.cappedEpisode,
        finishDate: progress.finishDate,
        startDate: progress.startDate,
        completed: progress.completed,
        possibleNextSeason: progress.possibleNextSeason,
        nextSeason,
      });
    }
  });

  con.log('[Crunchyroll Import] plan built:', {
    matched: matches.length,
    updates: updates.length,
    missing: missing.length,
    unmatched: unmatched.length,
  });

  return { updates, missing, unmatched };
}

// Lets the user paste the destination-provider URL by hand for a series Crunchyroll's title
// search couldn't resolve on its own (e.g. a season split differently than on Crunchyroll, like
// Snow White with the Red Hair above). The pasted link must be on the same provider as the
// user's configured sync destination (getManualLinkProviderTitle) - the whole rest of the import
// only ever writes there, so a link to a different site could never actually be synced. The
// harvested episode/date data for that series is then run through the exact same computeProgress
// rules as an automatic match, so a manually linked entry behaves identically to one search found
// on its own.
export function getManualLinkProviderTitle(): string {
  const syncMode = getSyncMode('anime');
  return getProviderOption(syncMode)?.title || syncMode;
}

export type ManualLinkResult =
  { kind: 'update'; item: CrunchyrollDiffItem } | { kind: 'missing'; item: CrunchyrollMissingItem };

export async function resolveManualLink(
  match: CrunchyrollMatch,
  url: string,
  // Set to the matched season's total when linking the *next* season after one Crunchyroll's
  // continuous numbering overflowed (possibleNextSeason) - match.episode is offset by it so the
  // continuation season gets its own relative episode number instead of the raw harvested one
  // (e.g. harvested ep 15 on top of a 12-episode season 1 means episode 3 of season 2).
  episodeOffset = 0,
): Promise<ManualLinkResult> {
  const trimmedUrl = url.trim();
  // Normalized the same way as syncType below - getType() can never return 'MALAPI' (a
  // myanimelist.net URL always resolves to 'MAL' there), so comparing against the raw
  // getSyncMode() result would reject every valid link when the user's mode is 'MALAPI'.
  const expectedSyncMode = normalizedSyncMode('anime');

  let syncType: string;
  try {
    syncType = getType(trimmedUrl);
  } catch (e) {
    throw new Error(api.storage.lang('crunchyrollImport_InvalidLinkError'));
  }
  if (syncType !== expectedSyncMode) {
    throw new Error(
      api.storage.lang('crunchyrollImport_WrongProviderError', [getManualLinkProviderTitle()]),
    );
  }

  const singleObj = getSingle(trimmedUrl);
  await singleObj.update();

  const malId = singleObj.getMalId();
  const title = singleObj.getTitle();
  if (!malId || !title) {
    throw new Error(api.storage.lang('crunchyrollImport_LinkLoadError'));
  }

  const totalEp = singleObj.getTotalEpisodes() || undefined;
  const harvestedEpisode = match.episode - episodeOffset;
  // Episode 1's date belongs to whichever season actually started with it - for a continuation
  // season (episodeOffset > 0) that's an earlier season, not this one, and the harvest doesn't
  // track a per-episode date map that would reveal when this later season itself began.
  const firstEpisodeDate = episodeOffset > 0 ? null : match.firstEpisodeDate;
  const progress = computeProgress(harvestedEpisode, match.date, firstEpisodeDate, totalEp);
  // Rare, but nothing stops Crunchyroll's continuous numbering from spanning three-plus seasons -
  // chain the same offset trick so the UI can offer linking yet another season after this one.
  const nextSeason: NextSeasonLinkContext | undefined = progress.possibleNextSeason
    ? { match, episodeOffset: episodeOffset + (totalEp as number) }
    : undefined;

  if (singleObj.isOnList()) {
    const currentEp = singleObj.getEpisode();
    const fillFinishDate =
      progress.finishDate && !singleObj.getFinishDate() ? progress.finishDate : undefined;
    const fillStartDate =
      progress.startDate && !singleObj.getStartDate() ? progress.startDate : undefined;

    return {
      kind: 'update',
      item: {
        malId,
        title,
        url: singleObj.getDisplayUrl(),
        currentEp,
        newEp: progress.cappedEpisode > currentEp ? progress.cappedEpisode : currentEp,
        finishDate: fillFinishDate,
        startDate: fillStartDate,
        possibleNextSeason: progress.possibleNextSeason,
        nextSeason,
      },
    };
  }

  return {
    kind: 'missing',
    item: {
      malId,
      title,
      url: singleObj.getDisplayUrl(),
      watchedEp: progress.cappedEpisode,
      finishDate: progress.finishDate,
      startDate: progress.startDate,
      completed: progress.completed,
      possibleNextSeason: progress.possibleNextSeason,
      nextSeason,
    },
  };
}

export async function applyCrunchyrollImport(
  updates: CrunchyrollDiffItem[],
  missing: CrunchyrollMissingItem[],
): Promise<{ updated: number; created: number; errors: { title: string; error: any }[] }> {
  let updated = 0;
  let created = 0;
  const errors: { title: string; error: any }[] = [];

  for (let i = 0; i < updates.length; i++) {
    const item = updates[i];
    // Items carried into the plan only to surface a possibleNextSeason link (see buildImportPlan)
    // can have nothing of their own left to change once that link's been resolved separately -
    // skip the no-op sync call so the reported count reflects what was actually written.
    const diff = {
      ...(item.newEp !== item.currentEp ? { watchedEp: item.newEp } : {}),
      ...(item.finishDate !== undefined ? { finishDate: item.finishDate } : {}),
      ...(item.startDate !== undefined ? { startDate: item.startDate } : {}),
    };
    if (Object.keys(diff).length === 0) continue;

    try {
      // eslint-disable-next-line no-await-in-loop
      await syncItem({ url: item.url, diff }, getType(item.url));
      updated++;
    } catch (e) {
      con.error('[Crunchyroll Import] update failed', item.title, e);
      errors.push({ title: item.title, error: e });
    }
  }

  for (let i = 0; i < missing.length; i++) {
    const item = missing[i];
    try {
      // eslint-disable-next-line no-await-in-loop
      await syncMissing({
        url: item.url,
        type: 'anime',
        syncType: getType(item.url),
        watchedEp: item.watchedEp,
        status: item.completed ? status.Completed : status.Watching,
        finishDate: item.finishDate,
        startDate: item.startDate,
      });
      created++;
    } catch (e) {
      con.error('[Crunchyroll Import] create failed', item.title, e);
      errors.push({ title: item.title, error: e });
    }
  }

  return { updated, created, errors };
}
