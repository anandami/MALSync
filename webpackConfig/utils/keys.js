const mode = process.env.CI_MODE || 'default';

module.exports = {
  getKeys() {
    let simklId = '90d0be129d5988174e02a05391b5a1315be10f392c64756cbae472ee015a82e4';
    let simklSecret = '1e0282776749b0be38c198db748df3e2172c48affc94f2ef15b940f009bf39c2';

    let mangabakaId = 'gkakHAvTRJdSNROnJVeCborCYCqveNSx';
    let mangabakaSecret = 'aSJdQANfWahFBPpqkVqYDYaFzvYjRUJv';

    // Trakt API credentials — https://trakt.tv/oauth/applications
    let traktId = 'kAB0U5mp1WJzbwmab_7vPzB3m6FlaEwISC7P4jyUIWk';
    let traktSecret = '41HDqf0Jmmbl38_YYaUrKYvB_uTrFKc1NsrPTCuXa2k';

    if (mode === 'travis') {
      if (!process.env.SIMKL_API_ID || !process.env.SIMKL_API_SECRET || !process.env.MANGABAKA_API_ID || !process.env.MANGABAKA_API_SECRET) {
        throw new Error('SIMKL_API_ID, SIMKL_API_SECRET, MANGABAKA_API_ID and MANGABAKA_API_SECRET are not set');
      }

      simklId = process.env.SIMKL_API_ID;
      simklSecret = process.env.SIMKL_API_SECRET;
      mangabakaId = process.env.MANGABAKA_API_ID;
      mangabakaSecret = process.env.MANGABAKA_API_SECRET;

      if (process.env.TRAKT_API_ID && process.env.TRAKT_API_SECRET) {
        traktId = process.env.TRAKT_API_ID;
        traktSecret = process.env.TRAKT_API_SECRET;
      }
    }

    return {
      simkl: {
        id: simklId,
        secret: simklSecret,
      },
      mangabaka: {
        id: mangabakaId,
        secret: mangabakaSecret,
      },
      trakt: {
        id: traktId,
        secret: traktSecret,
      },
    }
  }
};
