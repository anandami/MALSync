<template>
  <div class="list-sync">
    <SettingsGeneral
      v-if="isExtension()"
      component="checkbox"
      :title="lang('settings_listsync_background')"
    >
      <template #component> <FormCheckbox v-model="backgroundSync" /> </template>
    </SettingsGeneral>
    <Section spacer="half" direction="both">
      <Card>
        <div>
          <MediaLink color="secondary" href="https://github.com/MALSync/MALSync/wiki/List-Sync">
            {{ lang('settings_more_info') }}
          </MediaLink>
        </div>
      </Card>
    </Section>
    <Card class="list-sync provider">
      <Section>
        <FormSwitch
          v-model="parameters.type"
          :options="[
            {
              value: 'anime',
              title: lang('Anime'),
            },
            {
              value: 'manga',
              title: lang('Manga'),
            },
          ]"
        />
      </Section>
      <div class="provider-section">
        <div
          v-for="provider in Object.values(providerList) as any[]"
          :key="provider.providerType"
          class="provider-item"
        >
          <FormButton v-if="provider.providerSettings.master" :animation="false" color="secondary">
            {{ lang('settings_listsync_master') }}
          </FormButton>
          <div v-else-if="provider.providerSettings.text === 'Done'" class="provider-item-header">
            <FormButton :animation="false" color="primary">
              {{ lang('settings_listsync_slave') }}
            </FormButton>
            <FormButton
              v-if="provider.providerSettings.text === 'Done' && !provider.providerSettings.master"
              :animation="false"
              color="secondary"
              @click="deauth(provider.listProvider)"
              ><b>X</b></FormButton
            >
          </div>
          <FormButton :animation="false" class="provider-item-content">
            <div>
              {{ provider.providerType }}
            </div>
            <div v-dompurify-html="provider.providerSettings.text" />
            <div>
              {{ lang('settings_listsync_list') }}
              {{ provider.providerSettings.list ? provider.providerSettings.list.length : '??' }}
            </div>
          </FormButton>
        </div>
      </div>
    </Card>

    <Card v-if="syncRequest.loading" class="spinner-wrap"><Spinner /></Card>

    <Section v-if="!syncRequest.loading && syncRequest.data">
      <Card>
        <Section v-if="!syncing" spacer="half">
          {{ lang('settings_listsync_itemcount') }}
          <CodeBlock>
            <strong>{{ itemNumber }}</strong>
          </CodeBlock>
        </Section>

        <Section v-else spacer="half">
          {{ lang('settings_listsync_syncinprogress') }}
          <CodeBlock>
            <strong>{{ totalItems - itemNumber }} / {{ totalItems }}</strong>
          </CodeBlock>
        </Section>

        <FormButton
          v-if="!syncRequest.loading && syncRequest.data"
          color="primary"
          :disabled="syncing || itemNumber === 0"
          @click="!syncing ? startSync() : ''"
        >
          {{ lang('settings_listsync_syncbutton') }}
        </FormButton>
        <div v-if="!syncRequest.loading && syncRequest.data && !syncing" class="selection-controls">
          <FormButton :animation="false" color="secondary" padding="mini" @click="selectAll()">
            {{ lang('settings_listsync_select_all') }}
          </FormButton>
          <FormButton :animation="false" color="secondary" padding="mini" @click="selectNone()">
            {{ lang('settings_listsync_select_none') }}
          </FormButton>
        </div>
      </Card>
    </Section>

    <Section v-if="!syncRequest.loading && listDiff">
      <Header spacer="half">{{ lang('settings_listsync_updates') }}</Header>
      <Description :height="500">
        <Section v-for="(item, index) in listDiff" :key="index" spacer="half">
          <Card class="listDiff">
            <Header spacer="half" class="listDiff-header">
              <span class="title-text">{{ item.master.title }}</span>
              <FormCheckbox
                :model-value="isSelected(Number(index))"
                @update:model-value="value => setSelected(Number(index), value)"
              />
            </Header>
            <div class="listDiff-inner">
              <FormButton :animation="false">
                {{ index }}
              </FormButton>
              <FormButton
                v-if="item.master && item.master.uid"
                :animation="false"
                color="secondary"
                class="master"
              >
                <div>{{ sync.getType(item.master.url) }}</div>
                <div>
                  ID:
                  <MediaLink :href="item.master.url">{{ item.master.uid }}</MediaLink>
                </div>
                <div>{{ lang('settings_listsync_score') }} {{ item.master.score }}</div>
                <div>
                  {{ lang(`settings_listsync_progress_${item.master.type}`) }}
                  {{ item.master.watchedEp }}
                </div>
                <div v-if="item.master.type === 'manga'">
                  {{ lang('settings_listsync_volume') }} {{ item.master.readVol }}
                </div>
                <div>
                  {{ lang('settings_listsync_status') }}
                  {{ getStatusText(item.master.type, item.master.status) }}
                </div>
                <div>
                  {{ lang('settings_listsync_startdate') }}
                  {{
                    item.master.startDate
                      ? new IntlDateTime(item.master.startDate).getDateTimeText()
                      : lang('settings_listsync_unknowndate')
                  }}
                </div>
                <div>
                  {{ lang('settings_listsync_finishdate') }}
                  {{
                    item.master.finishDate
                      ? new IntlDateTime(item.master.finishDate).getDateTimeText()
                      : lang('settings_listsync_unknowndate')
                  }}
                </div>
                <div>
                  {{ lang(`settings_listsync_repeatcount_${item.master.type}`) }}
                  {{ item.master.rewatchCount ?? 0 }}
                </div>
              </FormButton>
              <FormButton
                v-for="slave in item.slaves"
                :key="slave.uid"
                :animation="false"
                class="slave"
              >
                <div>{{ sync.getType(slave.url) }}</div>
                <div>
                  ID: <MediaLink :href="slave.url" color="secondary">{{ slave.uid }}</MediaLink>
                </div>
                <div>
                  {{ lang('settings_listsync_score') }} {{ slave.score }}
                  <span v-if="slave.diff && slave.diff.score !== undefined">
                    → <text class="highlight">{{ slave.diff.score }}</text>
                  </span>
                </div>
                <div>
                  {{ lang(`settings_listsync_progress_${slave.type}`) }} {{ slave.watchedEp }}
                  <span v-if="slave.diff && slave.diff.watchedEp !== undefined">
                    → <text class="highlight">{{ slave.diff.watchedEp }}</text>
                  </span>
                </div>
                <div v-if="slave.type === 'manga'">
                  {{ lang('settings_listsync_volume') }} {{ slave.readVol }}
                  <span v-if="slave.diff && slave.diff.readVol !== undefined">
                    → <text class="highlight">{{ slave.diff.readVol }}</text>
                  </span>
                </div>
                <div>
                  {{ lang('settings_listsync_status') }}
                  {{ getStatusText(slave.type, slave.status) }}
                  <span v-if="slave.diff && slave.diff.status !== undefined">
                    →
                    <text class="highlight">{{
                      getStatusText(slave.type, slave.diff.status)
                    }}</text>
                  </span>
                </div>
                <div>
                  {{ lang('settings_listsync_startdate') }}
                  {{
                    slave.startDate
                      ? new IntlDateTime(slave.startDate).getDateTimeText()
                      : lang('settings_listsync_unknowndate')
                  }}
                  <span v-if="slave.diff && slave.diff.startDate !== undefined">
                    →
                    <text class="highlight">{{
                      slave.diff.startDate
                        ? new IntlDateTime(slave.diff.startDate).getDateTimeText()
                        : lang('settings_listsync_unknowndate')
                    }}</text>
                  </span>
                </div>
                <div>
                  {{ lang('settings_listsync_finishdate') }}
                  {{
                    slave.finishDate
                      ? new IntlDateTime(slave.finishDate).getDateTimeText()
                      : lang('settings_listsync_unknowndate')
                  }}
                  <span v-if="slave.diff && slave.diff.finishDate !== undefined">
                    →
                    <text class="highlight">{{
                      slave.diff.finishDate
                        ? new IntlDateTime(slave.diff.finishDate).getDateTimeText()
                        : lang('settings_listsync_unknowndate')
                    }}</text>
                  </span>
                </div>
                <div>
                  {{ lang(`settings_listsync_repeatcount_${slave.type}`) }}
                  {{ slave.rewatchCount ?? 0 }}
                  <span v-if="slave.diff && slave.diff.rewatchCount !== undefined">
                    → <text class="highlight">{{ slave.diff.rewatchCount }}</text>
                  </span>
                </div>
              </FormButton>
            </div>
          </Card>
        </Section>
      </Description>
    </Section>

    <Section
      v-if="!syncRequest.loading && syncRequest.data && syncRequest.data.missingGroupBy.length"
    >
      <Header spacer="half">{{ lang('settings_listsync_missing') }}</Header>
      <Description :height="500">
        <Grid :min-width="250">
          <Section
            v-for="(missing_title, index) in syncRequest.data.missingGroupBy"
            :key="index"
            spacer="half"
          >
            <Card class="missing">
              <Header spacer="half" class="listDiff-header">
                <span class="title-text">{{ missing_title[0].title }}</span>
                <FormCheckbox
                  :model-value="isSelected(missing_title[0].malId)"
                  @update:model-value="value => setSelected(missing_title[0].malId, value)"
                />
              </Header>
              <div class="missing-item">
                <FormButton :animation="false">
                  <div>
                    ID:
                    <MediaLink :href="missing_title[0].url" color="secondary">{{
                      missing_title[0].malId
                    }}</MediaLink>
                  </div>
                  <div>{{ lang('settings_listsync_score') }} {{ missing_title[0].score }}</div>
                  <div>
                    {{ lang(`settings_listsync_progress_${missing_title[0].type}`) }}
                    {{ missing_title[0].watchedEp }}
                  </div>
                  <div v-if="missing_title[0].type === 'manga'">
                    {{ lang('settings_listsync_volume') }} {{ missing_title[0].readVol }}
                  </div>
                  <div>
                    {{ lang('settings_listsync_status') }}
                    {{ getStatusText(missing_title[0].type, missing_title[0].status) }}
                  </div>
                  <div>
                    {{ lang('settings_listsync_startdate') }}
                    {{
                      missing_title[0].startDate
                        ? new IntlDateTime(missing_title[0].startDate).getDateTimeText()
                        : lang('settings_listsync_unknowndate')
                    }}
                  </div>
                  <div>
                    {{ lang('settings_listsync_finishdate') }}
                    {{
                      missing_title[0].finishDate
                        ? new IntlDateTime(missing_title[0].finishDate).getDateTimeText()
                        : lang('settings_listsync_unknowndate')
                    }}
                  </div>
                  <div>
                    {{ lang(`settings_listsync_repeatcount_${missing_title[0].type}`) }}
                    {{ missing_title[0].rewatchCount ?? 0 }}
                  </div>
                </FormButton>
                <FormButton v-for="item in missing_title" :key="item.malId" :animation="false">
                  <div>{{ item.syncType }}</div>
                  <FormButton v-if="item.error" :animation="false" color="secondary" padding="mini">
                    {{ item.error }}
                  </FormButton>
                </FormButton>
              </div>
            </Card>
          </Section>
        </Grid>
      </Description>
    </Section>
  </div>
</template>

<script lang="ts" setup>
import { computed, reactive, ref, watch } from 'vue';
import * as sync from '../../../utils/syncHandler';
import { getStatusText } from '../../../utils/general';
import { createRequest } from '../../utils/reactive';
import Card from '../card.vue';
import FormSwitch from '../form/form-switch.vue';
import FormButton from '../form/form-button.vue';
import Section from '../section.vue';
import Spinner from '../spinner.vue';
import Header from '../header.vue';
import MediaLink from '../media-link.vue';
import Description from '../description.vue';
import CodeBlock from '../code-block.vue';
import SettingsGeneral from './settings-general.vue';
import FormCheckbox from '../form/form-checkbox.vue';
import { IntlDateTime } from '../../../utils/IntlWrapper';
import Grid from '../grid.vue';

defineProps({
  title: {
    type: String,
    required: true,
  },
});

const mode = 'mirror';

const providerList = ref(null as any);
const syncing = ref(false);
const totalItems = ref(0);

const parameters = ref({
  type: 'anime',
});

const syncRequest = createRequest(parameters, async params => {
  syncing.value = false;
  totalItems.value = 0;
  const listProvider = reactive({
    mal: {
      text: 'Init',
      list: null,
      master: false,
    },
    anilist: {
      text: 'Init',
      list: null,
      master: false,
    },
    kitsu: {
      text: 'Init',
      list: null,
      master: false,
    },
    mangabaka: {
      text: 'Init',
      list: null,
      master: false,
    },
    simkl: {
      text: 'Init',
      list: null,
      master: false,
    },
    shiki: {
      text: 'Init',
      list: null,
      master: false,
    },
  });

  providerList.value = sync.getListProvider({
    mal: listProvider.mal,
    anilist: listProvider.anilist,
    kitsu: listProvider.kitsu,
    mangabaka: listProvider.mangabaka,
    simkl: listProvider.simkl,
    shiki: listProvider.shiki,
  });

  const listOptions = await sync.retriveLists(providerList.value, params.value.type, sync.getList);

  const list = [] as any[];
  const missing = [] as any[];

  sync.generateSync(
    listOptions.master as any,
    listOptions.slaves,
    mode,
    listOptions.typeArray,
    list,
    missing,
  );

  // @ts-expect-error --works
  // eslint-disable-next-line es-x/no-object-groupby
  const missingGroupBy = Object.values(Object.groupBy(missing, ({ malId }) => malId)) as any[];

  return {
    list,
    missing,
    missingGroupBy,
  };
});

// Which malIds will actually be synced on the next click - defaults to
// "everything" (matching the old always-sync-all behavior) whenever a fresh
// list loads, but lets a cautious run be narrowed down to a handful of
// titles first (e.g. to verify a fix before trusting it with the full list).
const selectedMalIds = reactive(new Set<number>());

watch(
  () => syncRequest.data,
  data => {
    selectedMalIds.clear();
    if (!data) return;
    Object.keys(data.list).forEach(key => {
      if (data.list[key].diff) selectedMalIds.add(Number(key));
    });
    data.missing.forEach((m: any) => selectedMalIds.add(m.malId));
  },
);

function isSelected(malId: number) {
  return selectedMalIds.has(malId);
}

function setSelected(malId: number, value: boolean) {
  if (value) selectedMalIds.add(malId);
  else selectedMalIds.delete(malId);
}

function selectAll() {
  if (!syncRequest.data) return;
  Object.keys(syncRequest.data.list).forEach(key => {
    if (syncRequest.data!.list[key].diff) selectedMalIds.add(Number(key));
  });
  syncRequest.data.missing.forEach((m: any) => selectedMalIds.add(m.malId));
}

function selectNone() {
  selectedMalIds.clear();
}

const listDiff = computed(() => {
  const res = {} as any;
  if (syncRequest.loading || !syncRequest.data) {
    return res;
  }
  for (const key in syncRequest.data.list) {
    if (
      Object.prototype.hasOwnProperty.call(syncRequest.data.list, key) &&
      syncRequest.data.list[key].diff
    ) {
      res[key] = syncRequest.data.list[key];
    }
  }
  return res;
});

const itemNumber = computed(() => {
  if (!listDiff.value || !syncRequest.data) {
    return 0;
  }
  return (
    Object.keys(listDiff.value).filter(key => selectedMalIds.has(Number(key))).length +
    syncRequest.data.missing.filter(el => !el.error && selectedMalIds.has(el.malId)).length
  );
});

function startSync() {
  syncing.value = true;
  totalItems.value = itemNumber.value;

  sync.syncList(syncRequest.data!.list, syncRequest.data!.missing, (malId: number) =>
    selectedMalIds.has(malId),
  );
}

function isExtension() {
  return api.type === 'webextension';
}

function deauth(ListProvider) {
  new ListProvider()
    .deauth()
    .then(() => {
      syncRequest.execute();
    })
    .catch(() => {
      alert('Failed');
    });
}

const backSync = ref(false);
async function updateBackgroundSyncState() {
  backSync.value = await sync.background.isEnabled();
}
const backgroundSync = computed({
  get() {
    return backSync.value;
  },
  set(value) {
    if (value) {
      sync.background.enable().finally(updateBackgroundSyncState);
    } else {
      sync.background.disable().finally(updateBackgroundSyncState);
    }
  },
});
updateBackgroundSyncState();
</script>

<style lang="less" scoped>
@import '../../less/_globals.less';

.list-sync {
  margin: @spacer-half 0;
}

.provider {
  &-item {
    display: flex;
    flex-direction: column;
    gap: 5px;
    &-content {
      display: flex !important;
      flex-direction: column;
      gap: 5px;
    }
    &-header {
      gap: 3px;
      display: flex;
    }
  }
  &-section {
    align-items: end;
    display: flex;
    flex-wrap: wrap;
    grid-gap: 5px;
    :deep(a) {
      color: var(--cl-secondary);
    }
  }
}

.listDiff-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;

  .title-text {
    flex: 1;
    min-width: 0;
  }

  // FormCheckbox's root is a fixed 60x32px toggle - without this it gets
  // squeezed by flexbox alongside long, wrapping titles, which visually
  // splits the slider's thumb from its track (looks like two loose dots).
  :deep(.checkbox) {
    flex-shrink: 0;
  }
}

.selection-controls {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
  margin-top: 5px;
}

.listDiff {
  .listDiff-inner {
    display: flex;
    gap: 5px;
  }

  .highlight {
    background-color: var(--cl-primary);
    color: var(--cl-primary-contrast);
    padding-left: 5px;
    padding-right: 5px;
    border-radius: 5px;
  }
}

.missing {
  width: 100%;
  height: 100%;

  > * {
    display: flex;
    flex-direction: column;
    height: 100%;
    justify-content: space-between;

    .missing-item {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
  }
}
</style>
