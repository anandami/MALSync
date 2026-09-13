import type { ChibiGenerator } from '../../../chibiScript/ChibiGenerator';
import { PageInterface } from '../../pageInterface';

// Confirmed live against a Brazil-based account: real playback URLs are on
// play.hbomax.com (e.g. https://play.hbomax.com/video/watch/{seriesId}/{episodeId}),
// not the global "Max" rebrand domain (max.com) this was originally written
// against - that domain may still be accurate for other regions/rollout
// stages, but this implementation was only verified against play.hbomax.com.
const domain = 'https://play.hbomax.com';

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

export const HBOMax: PageInterface = {
  name: 'HBOMax',
  domain,
  languages: ['Many'],
  type: 'anime',
  urls: {
    match: ['*://play.hbomax.com/*'],
  },
  sync: {
    isSyncPage($c) {
      return $c.or($c.url().contains('/video/').run(), $c.url().contains('/watch/').run()).run();
    },
    getTitle($c) {
      // Guard on the text itself (not just the element existing) in case the
      // title node is present-but-empty before playback actually starts, the
      // same behavior confirmed live on Prime Video's equivalent selector.
      return $c.querySelector(TITLE_SELECTOR).ifNotReturn().text().trim().ifNotReturn().run();
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
      // Unlike the /video/watch/ playback path above, a `/series/{id}` overview page was never
      // actually confirmed live (Prime Video's equivalent /detail/{id} path was). Guessing it
      // wrong would give the "continue watching" quick-link a 404 instead of a working page, so
      // this falls back to the current (confirmed-real) URL - always valid, if less ideal than a
      // true overview page. Replace with the real overview path once confirmed against a live
      // account.
      return $c.url().run();
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
          // Confirmed live on Prime Video's identical player layout that the URL and the title
          // element can both stay unchanged across a same-series episode advance (only this
          // episode-info text changes) - watching it here too as a safety net, since HBO Max's own
          // URL behavior between episodes hasn't been confirmed either way yet.
          // ifNotReturn() is required: this element lives in the player's control overlay, which
          // gets removed from the DOM whenever the controls auto-hide during normal playback -
          // without it, .text() on the resulting null throws every 500ms while controls are hidden.
          .detectChanges(
            $c.querySelector(SEASON_EPISODE_SELECTOR).ifNotReturn().text().run(),
            $c.trigger().run(),
          )
          .domReady()
          .trigger()
          .run()
      );
    },
  },
};
