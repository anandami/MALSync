import type { ChibiGenerator } from '../../../chibiScript/ChibiGenerator';
import { PageInterface } from '../../pageInterface';

const domain = 'https://www.max.com';

const TITLE_SELECTOR = '[data-testid="player-ux-asset-title"]';
const SEASON_EPISODE_SELECTOR = '[data-testid="player-ux-season-episode"]';

// Season/episode info is rendered as free text like "T1 Ep.3" - falls back
// to season 1 / episode 1 (movie) when neither part is present.
function seasonEpisodeText($c: ChibiGenerator<unknown>) {
  return $c.querySelector(SEASON_EPISODE_SELECTOR).ifNotReturn().text().trim();
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

// Both URL formats HBO Max uses put the id in the same path segment:
// /video/{seriesId}/{episodeId}  and  /watch/{id}
function currentId($c: ChibiGenerator<unknown>) {
  return $c.url().urlPart(4);
}

export const HBOMax: PageInterface = {
  name: 'HBOMax',
  domain,
  languages: ['Many'],
  type: 'anime',
  urls: {
    match: ['*://www.max.com/*'],
  },
  sync: {
    isSyncPage($c) {
      return $c.or($c.url().contains('/video/').run(), $c.url().contains('/watch/').run()).run();
    },
    getTitle($c) {
      return $c.querySelector(TITLE_SELECTOR).ifNotReturn().text().trim().run();
    },
    getIdentifier($c) {
      // Title-based (not the id parsed out of the URL): that id was only
      // confirmed for a single episode. If it turns out to be per-episode
      // rather than per-series, using it here would silently break episode
      // progress tracking. The series title is stable across episodes.
      return $c
        .this('sync.getTitle')
        .slugify()
        .concat('?s=')
        .concat(seasonNumber($c).string().run())
        .run();
    },
    getOverviewUrl($c) {
      return $c.string(`${domain}/series/`).concat(currentId($c).run()).run();
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
      return $c
        .detectURLChanges($c.trigger().run(), { ignoreQuery: true, ignoreAnchor: true })
        .detectChanges($c.querySelector(TITLE_SELECTOR).text().run(), $c.trigger().run())
        .domReady()
        .trigger()
        .run();
    },
  },
};
