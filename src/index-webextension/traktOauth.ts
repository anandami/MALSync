import { traktOauth } from '../_provider/Trakt/oauth';

api.settings.init().then(() => {
  traktOauth();
});
