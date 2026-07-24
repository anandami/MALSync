// Runs alongside (not through) the Crunchyroll ChibiScript definition in ./main.ts.
// The chibi DSL only models "one page = one episode" (see PageInterface), which can't express
// a history list covering many series - this is plain, independent content-script logic instead,
// gated on the /history path so it never interferes with the normal watch-page sync flow.
//
// Selectors confirmed against a live /pt-br/history page: the list is virtualized (react-window
// style, [role="listitem"] rows positioned absolutely via `top`, only ~8-10 in the DOM at once) -
// items must be collected DURING scrolling, not just once at the end, or everything that scrolls
// out of view is lost. There's no separate series link in the card; the "Reproduzir" link's
// aria-label ("Reproduzir Episódio {N} de {Título}") carries both episode and series title.
//
// Two real bugs were confirmed live (2026-07) via diagnostic logging and fixed here:
// 1. The date regex (`\b\d{2}\/\d{2}\/\d{4}\b`) could never match - `item.textContent` concatenates
//    sibling text nodes with no separator ("...o ano que chega20/07/2026Não recomendado..."), so
//    the `\b` word-boundary assertion right before/after the digits never has anywhere to match
//    since both neighboring characters are word characters. Fixed by dropping the `\b` anchors -
//    the `/` separators in the date itself are distinctive enough without them.
// 2. findScrollContainer trusted computed `overflow-y` styling to find the real scrollable
//    ancestor, which sometimes missed it entirely (Crunchyroll's actual scroll panel apparently
//    isn't a direct styled ancestor of the list in every layout) and fell back to scrolling the
//    whole page - confirmed live: scrollTop got stuck exactly at that page's own
//    scrollHeight-clientHeight after only ~6-14 items, well before the real history was exhausted.
//    Fixed by testing genuine scrollability empirically (nudge scrollTop, check it actually moved)
//    instead of trusting CSS.
//
// A direct fetch() to Crunchyroll's own paginated watch-history JSON API was tried twice and
// reverted both times (2026-07-22 and 2026-07-24): even though a real HAR capture shows the
// page's own JS successfully calling content/v2/{accountId}/watch-history, replicating that same
// call - both from this content script and from a bare fetch() typed directly into the page's own
// console - consistently gets a 401 with an empty body, consistent with an edge-level (Cloudflare)
// bot-detection block rather than a missing parameter this code could fix. Not something to keep
// fighting or try to evade - scrolling the real page like a user does stays the reliable option.

type HarvestedEntry = {
  seriesId: string;
  seriesTitle: string;
  episode: number;
  date: string;
  /** Date of episode 1 for this series, if it was also found in the scrolled history - null otherwise. */
  firstEpisodeDate: string | null;
};

type HarvestState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; data: HarvestedEntry[]; reachedBottom: boolean }
  | { status: 'error'; error: string };

// Only chrome.tabs.sendMessage (targeted at this tab) is used to reach this listener - never
// chrome.runtime.sendMessage, which broadcasts to the background service worker too and
// (src/background/messageHandler.ts:58-59) throws "Unknown action" for any message name it
// doesn't explicitly handle.
//
// Start/poll instead of one long-held request-response (2026-07-22): holding a single
// chrome.tabs.sendMessage response pending for the whole scroll (which can take many minutes for
// a long history) turned out unreliable - confirmed live the caller's promise timed out while the
// scroll kept running fine in the tab, meaning the message port itself doesn't survive being held
// open that long, independent of any timeout value chosen on the caller's side. Every individual
// message here now resolves immediately; the caller polls status separately.
const START_MESSAGE = 'crunchyrollHarvestStart';
const STATUS_MESSAGE = 'crunchyrollHarvestStatus';

let state: HarvestState = { status: 'idle' };

// Dedup key for the "no date matched" diagnostic below - collect() re-parses the same DOM node
// many times while it's in the (virtualized) viewport, and logging every pass would flood the
// console for a run that can take minutes.
const loggedMissingDateFor = new Set<string>();

export function initCrunchyrollHistoryHarvest() {
  if (!isHistoryPage()) return;

  con.log('[Crunchyroll History] listener attached on', window.location.href);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return undefined;

    if (msg.name === START_MESSAGE) {
      con.log('[Crunchyroll History] start request received, current state:', state.status);
      if (state.status === 'idle' || state.status === 'done' || state.status === 'error') {
        state = { status: 'running' };
        harvest()
          .then(({ data, reachedBottom }) => {
            con.log(
              '[Crunchyroll History] done,',
              data.length,
              'series, reachedBottom:',
              reachedBottom,
            );
            state = { status: 'done', data, reachedBottom };
          })
          .catch(e => {
            con.error('[Crunchyroll History] harvest() rejected:', e);
            state = { status: 'error', error: e instanceof Error ? e.message : String(e) };
          });
      }
      sendResponse({ ok: true });
      return undefined;
    }

    if (msg.name === STATUS_MESSAGE) {
      sendResponse({ ok: true, state });
      return undefined;
    }

    return undefined;
  });
}

function isHistoryPage() {
  return (
    window.location.hostname.endsWith('crunchyroll.com') &&
    /\/history(\/|$)/.test(window.location.pathname)
  );
}

async function harvest(): Promise<{ data: HarvestedEntry[]; reachedBottom: boolean }> {
  await waitForFirstItems();

  const bySeries = new Map<string, HarvestedEntry>();
  const collect = () => {
    document.querySelectorAll('[role="listitem"]').forEach(item => {
      const parsed = parseHistoryItem(item);
      if (!parsed) return;
      const existing = bySeries.get(parsed.seriesId);
      if (!existing) {
        bySeries.set(parsed.seriesId, parsed);
        return;
      }
      if (parsed.episode > existing.episode) {
        existing.episode = parsed.episode;
        // May be '' if this card's date text hasn't rendered yet - don't treat that as final,
        // the branch below backfills it on a later collect() pass while the card is still in
        // the (virtualized) DOM, instead of the empty value sticking forever.
        existing.date = parsed.date;
      } else if (parsed.episode === existing.episode && parsed.date && !existing.date) {
        // Same row seen again with its date now rendered - fill it in. Without this, a card
        // whose date lagged behind on the pass that first recorded its (highest) episode number
        // would never get a date at all, since the branch above only fires on a higher episode.
        existing.date = parsed.date;
      }
      if (parsed.episode === 1 && !existing.firstEpisodeDate) {
        existing.firstEpisodeDate = parsed.date || null;
      }
    });
  };

  collect();
  const reachedBottom = await scrollCollecting(collect);

  con.log(
    '[Crunchyroll History]',
    bySeries.size,
    'series collected, reachedBottom:',
    reachedBottom,
  );

  return { data: Array.from(bySeries.values()), reachedBottom };
}

function parseHistoryItem(item: Element): HarvestedEntry | null {
  const playLink = item.querySelector('a[aria-label^="Reproduzir"]');
  const ariaLabel = playLink?.getAttribute('aria-label') || '';
  const match = ariaLabel.match(/^Reproduzir Epis[óo]dio (\d+) de (.+)$/);
  if (!match) return null;

  const episode = parseInt(match[1]);
  const seriesTitle = match[2].trim();
  if (!seriesTitle) return null;

  // No \b anchors - item.textContent concatenates sibling text nodes with no whitespace
  // separator, so a word-boundary check right before/after the digits fails whenever the
  // adjacent character (in surrounding prose, on either side) is itself a letter/digit. The `/`
  // separators inside the date pattern are distinctive enough on their own.
  const dateMatch = item.textContent?.match(/\d{2}\/\d{2}\/\d{4}/);
  const date = dateMatch ? dateMatch[0] : '';

  if (!date && !loggedMissingDateFor.has(seriesTitle)) {
    loggedMissingDateFor.add(seriesTitle);
    con.log(
      '[Crunchyroll History] no DD/MM/YYYY date found for',
      seriesTitle,
      '- raw card text:',
      (item.textContent || '').slice(0, 300),
    );
  }

  return {
    seriesId: normalizeTitle(seriesTitle),
    seriesTitle,
    episode,
    date,
    firstEpisodeDate: episode === 1 && date ? date : null,
  };
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase();
}

async function waitForFirstItems(): Promise<void> {
  const maxAttempts = 30;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (document.querySelectorAll('[role="listitem"]').length > 0) return;
    // eslint-disable-next-line no-await-in-loop
    await utils.wait(500);
  }
}

// Walks every ancestor from `start` up to the document root and picks the first one that's
// genuinely scrollable, verified by actually nudging scrollTop and checking it moved - trusting
// computed `overflow-y` alone (the previous approach) missed Crunchyroll's real scroll panel in
// at least some layouts and silently fell back to scrolling the whole page instead, confirmed
// live via scrollTop getting stuck exactly at that page's own max after only ~6-14 items.
function findScrollContainer(start: Element): Element {
  const candidates: HTMLElement[] = [];
  let el: Element | null = start;
  while (el) {
    candidates.push(el as HTMLElement);
    el = el.parentElement;
  }
  const fallback = (document.scrollingElement || document.documentElement) as HTMLElement;
  if (!candidates.includes(fallback)) candidates.push(fallback);

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (c.scrollHeight <= c.clientHeight + 4) continue;
    const before = c.scrollTop;
    c.scrollTop = before + 50;
    const moved = c.scrollTop !== before;
    c.scrollTop = before;
    if (moved) return c;
  }
  return fallback;
}

// Confirmed live: jumping 80% of a viewport every 500ms can outrun the virtualized list's own
// lazy-loading - scrollHeight briefly stops growing not because the history actually ended, but
// because the next batch hasn't finished loading yet, and the old logic mistook that pause for
// "reached the bottom". Scroll in smaller steps, wait longer per step, and when nothing seems to
// be happening give it extra patience (a longer wait + recheck) before trusting that it's really
// the end - only concede after several consecutive rounds of genuinely no progress.
async function scrollCollecting(collect: () => void): Promise<boolean> {
  const list =
    document.querySelector('[role="list"]') || document.querySelector('[role="listitem"]');
  const scrollContainer = findScrollContainer(list || document.body);

  con.log(
    '[Crunchyroll History] scroll container:',
    scrollContainer === document.documentElement || scrollContainer === document.body
      ? '(page itself - no scrollable ancestor matched)'
      : `<${scrollContainer.tagName.toLowerCase()} class="${(scrollContainer as HTMLElement).className}">`,
    '- scrollHeight:',
    scrollContainer.scrollHeight,
    'clientHeight:',
    scrollContainer.clientHeight,
  );

  let lastScrollTop = -1;
  let noProgressRounds = 0;
  const maxAttempts = 900;
  const maxNoProgressRounds = 8;
  let reachedBottom = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const heightBefore = scrollContainer.scrollHeight;
    scrollContainer.scrollTop += Math.max(scrollContainer.clientHeight * 0.5, 300);
    // eslint-disable-next-line no-await-in-loop
    await utils.wait(900);
    collect();

    const grew = scrollContainer.scrollHeight > heightBefore;
    const moved = scrollContainer.scrollTop !== lastScrollTop;
    lastScrollTop = scrollContainer.scrollTop;

    if (grew || moved) {
      noProgressRounds = 0;
    } else {
      noProgressRounds++;
      con.log(
        '[Crunchyroll History] no progress, round',
        noProgressRounds,
        'of',
        maxNoProgressRounds,
        '- scrollTop:',
        scrollContainer.scrollTop,
        'scrollHeight:',
        scrollContainer.scrollHeight,
        'items in DOM:',
        document.querySelectorAll('[role="listitem"]').length,
      );
      // Give the lazy-loaded batch extra time to arrive before counting this round as real
      // "no progress" - a still-loading page and a genuinely finished list look identical for a
      // moment, only patience tells them apart.
      // eslint-disable-next-line no-await-in-loop
      await utils.wait(1500);
      collect();
      if (scrollContainer.scrollHeight > heightBefore) noProgressRounds = 0;
    }

    if (noProgressRounds >= maxNoProgressRounds) {
      con.log(
        '[Crunchyroll History] giving up after',
        attempt + 1,
        'scroll attempts - final scrollTop:',
        scrollContainer.scrollTop,
        'scrollHeight:',
        scrollContainer.scrollHeight,
      );
      reachedBottom = true;
      break;
    }
  }

  return reachedBottom;
}
