import type { ChibiGenerator } from '../../../chibiScript/ChibiGenerator';
import { PageInterface } from '../../pageInterface';

const domain = 'https://www.primevideo.com';

const TITLE_SELECTOR = '.atvwebplayersdk-title-text';
const EPISODE_INFO_SELECTOR = '.atvwebplayersdk-episode-info';

// Episode info is rendered as free text like "T1 Ep.3" - falls back to
// season 1 / episode 1 (movie) when neither part is present.
function seasonEpisodeText($c: ChibiGenerator<unknown>) {
  return $c.querySelector(EPISODE_INFO_SELECTOR).ifNotReturn().text().trim();
}

function seasonNumber($c: ChibiGenerator<unknown>) {
  return $c.if(
    seasonEpisodeText($c).matches('T(\\d+)').run(),
    seasonEpisodeText($c).regex('T(\\d+)', 1).number().run(),
    $c.number(1).run(),
  );
}

function episodeNumber($c: ChibiGenerator<unknown>) {
  return $c.if(
    seasonEpisodeText($c).matches('Ep\\.(\\d+)').run(),
    seasonEpisodeText($c).regex('Ep\\.(\\d+)', 1).number().run(),
    $c.number(1).run(),
  );
}

export const PrimeVideo: PageInterface = {
  name: 'PrimeVideo',
  domain,
  languages: ['Many'],
  type: 'anime',
  urls: {
    match: ['*://www.primevideo.com/*'],
  },
  sync: {
    isSyncPage($c) {
      // Prime Video can open the player either on its own /watch/ page or as
      // a modal on top of the /detail/ (overview) page.
      return $c.or($c.url().contains('/watch/').run(), $c.url().contains('/detail/').run()).run();
    },
    getTitle($c) {
      // The title element is present in the DOM even before playback starts
      // (empty and hidden) - guard on the text itself, not just the element,
      // so a bare /detail/ page (not actually playing) is correctly treated
      // as "not ready yet" instead of an empty title.
      return $c.querySelector(TITLE_SELECTOR).ifNotReturn().text().trim().ifNotReturn().run();
    },
    getIdentifier($c) {
      // Title-based rather than the id in the /watch//detail/ URL. Confirmed
      // live that the id is actually stable within a season (unchanged from
      // episode 1 through episode 10 of the same season, reached via the
      // in-player "next episode" button) - the original caution about it was
      // wrong - but the title is equally reliable and this was already
      // written and working, so left as-is rather than churning it.
      return $c
        .this('sync.getTitle')
        .slugify()
        .concat('?s=')
        .concat(seasonNumber($c).string().run())
        .run();
    },
    getOverviewUrl($c) {
      // Prime Video serves the same page under both /detail/{id} and
      // /-/{locale}/detail/{id} (confirmed live: this site's own "related
      // titles" links use the locale-prefixed form) - a fixed path-segment
      // index would only work for one of them, so pull the id out with a
      // regex that doesn't care what precedes "detail/"/"watch/".
      return $c
        .string(`${domain}/detail/`)
        .concat($c.url().regex('/(?:detail|watch)/([^/?#]+)', 1).run())
        .run();
    },
    getEpisode($c) {
      return episodeNumber($c).run();
    },
    uiInjection($c) {
      return $c.querySelector(TITLE_SELECTOR).ifNotReturn().uiAfter().run();
    },
  },
  lifecycle: {
    setup($c) {
      return $c.addStyle(require('./style.less?raw').toString()).run();
    },
    ready($c) {
      return (
        $c
          .detectURLChanges($c.trigger().run(), { ignoreQuery: true, ignoreAnchor: true })
          .detectChanges($c.querySelector(TITLE_SELECTOR).text().run(), $c.trigger().run())
          // Confirmed live: clicking the in-player "next episode" button changes
          // neither the URL nor the title element (both stay identical from
          // episode 1 through episode 10 of the same season) - only this episode
          // info text does. Without watching it directly, MALSync would never
          // notice a same-series episode advance and would stop syncing after
          // the first episode of a viewing session.
          .detectChanges($c.querySelector(EPISODE_INFO_SELECTOR).text().run(), $c.trigger().run())
          .domReady()
          .trigger()
          .run()
      );
    },
  },
};
