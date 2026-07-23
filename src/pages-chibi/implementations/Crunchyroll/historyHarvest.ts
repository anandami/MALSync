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
// A direct fetch() to Crunchyroll's own paginated watch-history JSON API was tried and reverted
// (2026-07-22): content/v2/{accountId}/watch-history is NOT cookie-authenticated - confirmed live
// that even a bare fetch() run from the Crunchyroll page's own console (no extension involved)
// gets a 401. Their own JS must attach something beyond cookies (a bearer token minted/rotated
// internally) that isn't visible in a HAR capture. Replicating that would mean reverse-engineering
// an undocumented internal auth mechanism - fragile and not something to imitate. Scrolling the
// real page like a user does stays the reliable option, just slower for very long histories.

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
  const playLink = item.querySelector('a[aria-label^="Reproduzir"]') as HTMLAnchorElement | null;
  const ariaLabel = playLink?.getAttribute('aria-label') || '';
  const match = ariaLabel.match(/^Reproduzir Epis[óo]dio (\d+) de (.+)$/);
  if (!match) return null;

  const episode = parseInt(match[1]);
  const seriesTitle = match[2].trim();
  if (!seriesTitle) return null;

  const dateMatch = item.textContent?.match(/\b\d{2}\/\d{2}\/\d{4}\b/);
  const date = dateMatch ? dateMatch[0] : '';

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

function findScrollContainer(start: Element): Element {
  let el: Element | null = start;
  while (el && el !== document.body && el !== document.documentElement) {
    const elStyle = window.getComputedStyle(el);
    const scrollable = elStyle.overflowY === 'auto' || elStyle.overflowY === 'scroll';
    if (scrollable && el.scrollHeight > el.clientHeight + 4) {
      return el;
    }
    el = el.parentElement;
  }
  return document.scrollingElement || document.documentElement;
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
      // Give the lazy-loaded batch extra time to arrive before counting this round as real
      // "no progress" - a still-loading page and a genuinely finished list look identical for a
      // moment, only patience tells them apart.
      // eslint-disable-next-line no-await-in-loop
      await utils.wait(1500);
      collect();
      if (scrollContainer.scrollHeight > heightBefore) noProgressRounds = 0;
    }

    if (noProgressRounds >= maxNoProgressRounds) {
      reachedBottom = true;
      break;
    }
  }

  return reachedBottom;
}
