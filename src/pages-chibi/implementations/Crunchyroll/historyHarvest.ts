// Runs alongside (not through) the Crunchyroll ChibiScript definition in ./main.ts.
// The chibi DSL only models "one page = one episode" (see PageInterface), which can't express
// a history list covering many series - this is plain, independent content-script logic instead,
// gated on the /history path so it never interferes with the normal watch-page sync flow.
//
// The list is virtualized (react-window style, [role="listitem"] rows positioned absolutely via
// `top`, only ~8-10 in the DOM at once), so items must be collected DURING scrolling, not just
// once at the end, or everything that scrolls out of view is lost. There's no separate series
// link in the card; the "Reproduzir" link's aria-label ("Reproduzir Episódio {N} de {Título}")
// carries both episode and series title. Only verified against the Portuguese (pt-BR) Crunchyroll
// UI - a different display language renders a different aria-label and won't match parseHistoryItem
// below, so history harvesting silently finds nothing for those users until someone extends the
// pattern for their language.
//
// A direct fetch() to Crunchyroll's own paginated watch-history JSON API would be more robust than
// scrolling, but consistently returns a 401 with an empty body - consistent with an edge-level
// (Cloudflare) bot-detection block rather than a missing parameter, so scrolling the real page like
// a user does is the reliable option here.

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

// Only chrome.tabs.sendMessage (targeted at this tab) reaches this listener - never
// chrome.runtime.sendMessage, which also broadcasts to the background service worker and
// (src/background/messageHandler.ts) throws "Unknown action" for any name it doesn't handle.
//
// Start/poll instead of one long-held request-response: a chrome.tabs.sendMessage response left
// pending for the whole scroll (which can take minutes for a long history) doesn't survive that
// long - the message port itself gets torn down regardless of timeout. Every message here resolves
// immediately; the caller polls status separately.
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

  // No \b anchors: item.textContent concatenates sibling text nodes with no separator, so a
  // word-boundary check would fail whenever the surrounding prose touches the digits directly.
  // The `/` separators in the date pattern are distinctive enough on their own.
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
// genuinely scrollable, verified by nudging scrollTop and checking it moved. Trusting computed
// `overflow-y` alone isn't reliable here - Crunchyroll's real scroll panel isn't always a styled
// ancestor of the list, which would silently fall back to scrolling the whole page instead.
// Every candidate is logged (not just the winner) so a run where none of them qualify - e.g. a
// virtualized list driven by wheel/transform instead of native scrollTop - is diagnosable from the
// console instead of just silently falling back to the page.
function findScrollContainer(start: Element): Element {
  const candidates: HTMLElement[] = [];
  let el: Element | null = start;
  while (el) {
    candidates.push(el as HTMLElement);
    el = el.parentElement;
  }
  const fallback = (document.scrollingElement || document.documentElement) as HTMLElement;
  if (!candidates.includes(fallback)) candidates.push(fallback);

  let found: Element | null = null;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const tallEnough = c.scrollHeight > c.clientHeight + 4;
    let moved = false;
    if (tallEnough) {
      const before = c.scrollTop;
      c.scrollTop = before + 50;
      moved = c.scrollTop !== before;
      c.scrollTop = before;
    }
    con.log(
      '[Crunchyroll History] scroll candidate',
      i,
      `<${c.tagName.toLowerCase()} class="${c.className}">`,
      '- scrollHeight:',
      c.scrollHeight,
      'clientHeight:',
      c.clientHeight,
      'tallEnough:',
      tallEnough,
      'moved:',
      moved,
    );
    if (!found && tallEnough && moved) found = c;
  }
  return found || fallback;
}

// Scrolls in small steps and waits between them because the virtualized list's lazy-loading can
// lag behind a faster scroll - scrollHeight briefly stalling doesn't mean the history actually
// ended, just that the next batch hasn't arrived yet. Only gives up after several consecutive
// rounds with no growth or movement, each with extra time for a lazy-loaded batch to arrive.
async function scrollCollecting(collect: () => void): Promise<boolean> {
  // Anchored on an actual [role="listitem"] (already confirmed real by waitForFirstItems/collect)
  // rather than the page's first [role="list"] - Crunchyroll's history page isn't necessarily the
  // only place on the page using that role (e.g. a recommendations rail above it), and starting
  // the ancestor walk from the wrong list silently searches the wrong part of the page entirely.
  const list = document.querySelector('[role="listitem"]');
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
    const step = Math.max(scrollContainer.clientHeight * 0.5, 300);
    scrollContainer.scrollTop += step;
    // Synthetic (untrusted) events never move native scroll themselves, but if the container
    // findScrollContainer picked doesn't actually use native scrollTop - e.g. a virtualizer driven
    // by its own wheel listener instead - this still gives its JS a chance to react, on top of the
    // scrollTop nudge above.
    scrollContainer.dispatchEvent(
      new WheelEvent('wheel', { deltaY: step, bubbles: true, cancelable: true }),
    );
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
