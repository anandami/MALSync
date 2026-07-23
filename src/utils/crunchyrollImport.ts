import { search } from '../_provider/searchFactory';
import { getListbyType } from '../_provider/listFactory';
import { getSyncMode } from '../_provider/helper';
import { status } from '../_provider/definitions';
import type { listElement } from '../_provider/listAbstract';
import { syncItem, syncMissing, getType } from './syncHandler';

const HISTORY_URL = 'https://www.crunchyroll.com/history';
const START_MESSAGE = 'crunchyrollHarvestStart';
const STATUS_MESSAGE = 'crunchyrollHarvestStatus';
// Covers establishing the very first connection to the tab's listener (before harvesting starts)
// - confirmed live that even 60s wasn't consistently enough for this heavy a page to finish
// loading and attach the listener. 5 minutes per the user's explicit request.
const CONNECT_TIMEOUT_MS = 300000;
const CONNECT_RETRY_MS = 500;
const POLL_INTERVAL_MS = 3000;
// Overall ceiling on how long polling will keep checking in before giving up - generous because a
// long history's scroll can legitimately take a long time. Each individual poll is short-lived
// (see the comment on historyHarvest.ts's START/STATUS split for why holding one long response
// instead of polling turned out unreliable).
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
  totalEp?: number;
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
};

export type CrunchyrollMissingItem = {
  malId: number;
  title: string;
  url: string;
  watchedEp: number;
  finishDate?: string;
  startDate?: string;
  possibleNextSeason?: boolean;
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
      chrome.tabs.remove(tabId).catch(() => {});
      return { entries: state.data || [], reachedBottom: state.reachedBottom !== false };
    }
    if (state?.status === 'error') {
      con.error('[Crunchyroll Import] harvest reported an error, tab left open:', tabId, state);
      throw new Error(state.error || 'Harvest failed');
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
      totalEp: top?.totalEp,
    });
  }

  return matches;
}

// Crunchyroll dates are DD/MM/YYYY; MAL/AniList expect YYYY-MM-DD (definitions.ts).
function toIsoDate(dateStr: string): string | undefined {
  const match = dateStr.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return undefined;
  const [, day, month, year] = match;
  return `${year}-${month}-${day}`;
}

// Only watchedEp and dates are touched for entries that already exist on the user's real list -
// score/status/rewatchCount are left alone so a manual "Dropped"/rating isn't silently reverted
// just because Crunchyroll has playback history. finishDate is always set to the date of the
// latest episode found (per the user's explicit request, even when that isn't the series'
// actual last episode); startDate is only set when episode 1 was also found in the scraped
// history. Either date can trigger an update even when the episode count itself hasn't changed
// (e.g. an entry already marked Completed with the right episode count but no dates recorded) -
// but only to fill in a date that's currently empty, never to overwrite one that's already set.
// New entries are always created as Watching (never Completed - there's no reliable way to know
// the harvested episode is the last one).
//
// Crunchyroll numbers episodes continuously across a franchise's seasons (confirmed live:
// "Snow White with the Red Hair" runs a single episode count across what MAL splits into
// "Akagami no Shirayuki-hime" (12 eps) and "...2nd Season" - the same class of problem
// HANDOFF.md documents for Trakt). Title search has no way to know a season split exists, so a
// harvested episode number can exceed the single MAL entry it matched to. The episode written is
// always capped at that entry's own total (never sent out of range) and flagged as
// possibleNextSeason so the UI can tell the user there's a later season needing separate handling
// - this only prevents a bad write, it doesn't attempt to locate/write the next season itself.
export async function buildImportPlan(matches: CrunchyrollMatch[]): Promise<CrunchyrollImportPlan> {
  const type = 'anime' as const;
  const syncMode = getSyncMode(type);
  const listProvider = getListbyType(syncMode, [status.All, type]);
  const currentList: listElement[] = await listProvider.getCompleteList();

  const byMalId = new Map<number, listElement>();
  currentList.forEach(el => {
    if (el.malId) byMalId.set(Number(el.malId), el);
  });

  const updates: CrunchyrollDiffItem[] = [];
  const missing: CrunchyrollMissingItem[] = [];
  const unmatched: CrunchyrollMatch[] = [];

  matches.forEach(match => {
    if (!match.malId || !match.malUrl) {
      unmatched.push(match);
      return;
    }

    const finishDate = toIsoDate(match.date);
    const startDate = match.firstEpisodeDate ? toIsoDate(match.firstEpisodeDate) : undefined;

    const existing = byMalId.get(match.malId);
    if (existing) {
      const totalEp = existing.totalEp;
      const possibleNextSeason = Boolean(totalEp && match.episode > totalEp);
      const cappedEpisode = possibleNextSeason ? totalEp! : match.episode;

      const epChanged = cappedEpisode > existing.watchedEp;
      const fillFinishDate = finishDate && !existing.finishDate ? finishDate : undefined;
      const fillStartDate = startDate && !existing.startDate ? startDate : undefined;

      if (epChanged || fillFinishDate || fillStartDate) {
        updates.push({
          malId: match.malId,
          title: existing.title,
          url: existing.url,
          currentEp: existing.watchedEp,
          newEp: epChanged ? cappedEpisode : existing.watchedEp,
          finishDate: fillFinishDate,
          startDate: fillStartDate,
          possibleNextSeason,
        });
      }
    } else {
      const possibleNextSeason = Boolean(match.totalEp && match.episode > match.totalEp);
      const cappedEpisode = possibleNextSeason ? match.totalEp! : match.episode;

      missing.push({
        malId: match.malId,
        title: match.seriesTitle,
        url: match.malUrl,
        watchedEp: cappedEpisode,
        finishDate,
        startDate,
        possibleNextSeason,
      });
    }
  });

  return { updates, missing, unmatched };
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
    try {
      // eslint-disable-next-line no-await-in-loop
      await syncItem(
        {
          url: item.url,
          diff: {
            ...(item.newEp !== item.currentEp ? { watchedEp: item.newEp } : {}),
            ...(item.finishDate !== undefined ? { finishDate: item.finishDate } : {}),
            ...(item.startDate !== undefined ? { startDate: item.startDate } : {}),
          },
        },
        getType(item.url),
      );
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
        status: status.Watching,
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
