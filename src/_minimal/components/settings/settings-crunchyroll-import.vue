<template>
  <SettingsGeneral component="checkbox" :title="title">
    <template #component>
      <div class="buttons">
        <FormButton color="primary" :disabled="loading" @click="startHarvest()">
          {{
            loading
              ? lang('crunchyrollImport_FetchButtonLoading')
              : lang('crunchyrollImport_FetchButton')
          }}
        </FormButton>
      </div>
    </template>
  </SettingsGeneral>

  <Section v-if="loading">
    <Card
      ><div class="warning">⚠ {{ lang('crunchyrollImport_LoadingWarning') }}</div></Card
    >
  </Section>

  <Section v-if="error">
    <Card
      ><div class="error">{{ error }}</div></Card
    >
  </Section>

  <Section v-if="plan && !reachedBottom">
    <Card
      ><div class="warning">⚠ {{ lang('crunchyrollImport_NotReachedBottomWarning') }}</div></Card
    >
  </Section>

  <Section v-if="plan">
    <Card v-if="plan.updates.length === 0 && plan.missing.length === 0">
      <div>{{ lang('crunchyrollImport_NothingNew') }}</div>
    </Card>

    <template v-else>
      <Header v-if="plan.updates.length" spacer="half">
        {{ lang('crunchyrollImport_UpdatesHeader', [String(plan.updates.length)]) }}
      </Header>
      <Description v-if="plan.updates.length" :height="400">
        <Section v-for="item in plan.updates" :key="item.malId" spacer="half">
          <Card class="listDiff">
            <Header spacer="half"
              ><span class="title-text">{{ item.title }}</span></Header
            >
            <div v-if="item.newEp !== item.currentEp">
              {{ lang('crunchyrollImport_EpisodeChange', [String(item.currentEp)]) }}
              <span class="highlight">{{ item.newEp }}</span>
            </div>
            <div v-else>
              {{ lang('crunchyrollImport_EpisodeUnchanged', [String(item.currentEp)]) }}
            </div>
            <div v-if="item.finishDate">
              {{ lang('crunchyrollImport_FinishDateArrow') }}
              <span class="highlight">{{ item.finishDate }}</span>
            </div>
            <div v-if="item.startDate">
              {{ lang('crunchyrollImport_StartDateArrow') }}
              <span class="highlight">{{ item.startDate }}</span>
            </div>
            <SettingsCrunchyrollNextSeason
              v-if="item.nextSeason"
              :manual-link-label="manualLinkLabel"
              :linked="!!linkedNextSeasons[item.malId]"
              :linking="!!nextSeasonLinking[item.malId]"
              :error="nextSeasonLinkErrors[item.malId]"
              :model-value="nextSeasonLinkInputs[item.malId] || ''"
              @update:model-value="nextSeasonLinkInputs[item.malId] = $event"
              @submit="linkNextSeason(item)"
            />
          </Card>
        </Section>
      </Description>

      <Header v-if="plan.missing.length" spacer="half">
        {{ lang('crunchyrollImport_MissingHeader', [String(plan.missing.length)]) }}
      </Header>
      <Description v-if="plan.missing.length" :height="400">
        <Section v-for="item in plan.missing" :key="item.malId" spacer="half">
          <Card class="listDiff">
            <Header spacer="half"
              ><span class="title-text">{{ item.title }}</span></Header
            >
            <div>
              {{
                lang('crunchyrollImport_MissingStatusLine', [
                  item.completed ? lang('UI_Status_Completed') : lang('UI_Status_watching_anime'),
                  String(item.watchedEp),
                ])
              }}
            </div>
            <div v-if="item.finishDate">
              {{ lang('crunchyrollImport_FinishDateColon', [item.finishDate]) }}
            </div>
            <div v-if="item.startDate">
              {{ lang('crunchyrollImport_StartDateColon', [item.startDate]) }}
            </div>
            <SettingsCrunchyrollNextSeason
              v-if="item.nextSeason"
              :manual-link-label="manualLinkLabel"
              :linked="!!linkedNextSeasons[item.malId]"
              :linking="!!nextSeasonLinking[item.malId]"
              :error="nextSeasonLinkErrors[item.malId]"
              :model-value="nextSeasonLinkInputs[item.malId] || ''"
              @update:model-value="nextSeasonLinkInputs[item.malId] = $event"
              @submit="linkNextSeason(item)"
            />
          </Card>
        </Section>
      </Description>

      <FormButton color="primary" :disabled="applying || hasActiveLink" @click="apply()">
        {{
          applying
            ? lang('crunchyrollImport_ApplyButtonLoading')
            : lang('crunchyrollImport_ApplyButton')
        }}
      </FormButton>
    </template>

    <Card v-if="plan.unmatched.length">
      <Header spacer="half">
        {{
          lang('crunchyrollImport_UnmatchedHeader', [syncModeTitle, String(plan.unmatched.length)])
        }}
      </Header>
      <Section v-for="item in plan.unmatched" :key="item.seriesId" spacer="half">
        <div class="title-text">{{ item.seriesTitle }}</div>
        <div class="manual-link">
          <FormText
            v-model="linkInputs[item.seriesId]"
            :placeholder="manualLinkLabel"
            :disabled="linking[item.seriesId]"
            class="manual-link-input"
          />
          <FormButton
            color="primary"
            :disabled="linking[item.seriesId] || !linkInputs[item.seriesId]"
            @click="linkManually(item)"
          >
            {{
              linking[item.seriesId]
                ? lang('crunchyrollImport_LinkButtonLoading')
                : lang('crunchyrollImport_LinkButton')
            }}
          </FormButton>
        </div>
        <div v-if="linkErrors[item.seriesId]" class="error">{{ linkErrors[item.seriesId] }}</div>
      </Section>
    </Card>
  </Section>

  <Section v-if="result">
    <Card>
      <div>
        {{
          lang('crunchyrollImport_ResultSummary', [String(result.updated), String(result.created)])
        }}
      </div>
      <div v-if="result.errors.length">
        {{ lang('crunchyrollImport_ResultErrors', [String(result.errors.length)]) }}
      </div>
    </Card>
  </Section>
</template>

<script lang="ts" setup>
import { ref, computed } from 'vue';
import {
  harvestCrunchyrollHistory,
  matchToMal,
  buildImportPlan,
  applyCrunchyrollImport,
  resolveManualLink,
  getManualLinkProviderTitle,
  type CrunchyrollImportPlan,
  type CrunchyrollMatch,
  type CrunchyrollDiffItem,
  type CrunchyrollMissingItem,
} from '../../../utils/crunchyrollImport';
import FormButton from '../form/form-button.vue';
import FormText from '../form/form-text.vue';
import Card from '../card.vue';
import Section from '../section.vue';
import Header from '../header.vue';
import Description from '../description.vue';
import SettingsGeneral from './settings-general.vue';
import SettingsCrunchyrollNextSeason from './settings-crunchyroll-next-season.vue';

defineProps({
  title: {
    type: String,
    required: true,
  },
});

const loading = ref(false);
const applying = ref(false);
const error = ref('');
const plan = ref<CrunchyrollImportPlan | null>(null);
const result = ref<{ updated: number; created: number; errors: unknown[] } | null>(null);
const reachedBottom = ref(true);

const syncModeTitle = getManualLinkProviderTitle();
const manualLinkLabel = api.storage.lang('crunchyrollImport_ManualLinkLabel', [syncModeTitle]);
const linkInputs = ref<Record<string, string>>({});
const linkErrors = ref<Record<string, string>>({});
const linking = ref<Record<string, boolean>>({});

const nextSeasonLinkInputs = ref<Record<number, string>>({});
const nextSeasonLinkErrors = ref<Record<number, string>>({});
const nextSeasonLinking = ref<Record<number, boolean>>({});
const linkedNextSeasons = ref<Record<number, boolean>>({});

async function startHarvest() {
  if (loading.value) return;
  loading.value = true;
  error.value = '';
  plan.value = null;
  result.value = null;
  // A fresh harvest builds a brand new plan - any link state from a previous run (which items are
  // linked, pending inputs/errors) refers to items that may not exist in the new plan at all, and
  // stale "linked" state would wrongly hide an item that still needs linking this time around.
  linkInputs.value = {};
  linkErrors.value = {};
  linking.value = {};
  nextSeasonLinkInputs.value = {};
  nextSeasonLinkErrors.value = {};
  nextSeasonLinking.value = {};
  linkedNextSeasons.value = {};
  try {
    const { entries, reachedBottom: reachedBottomResult } = await harvestCrunchyrollHistory();
    reachedBottom.value = reachedBottomResult;
    const matches = await matchToMal(entries);
    plan.value = await buildImportPlan(matches);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

// True while any manual/next-season link resolve is in flight - apply() must not be allowed to
// null out the plan while one of those is still going to push its result into it (see the null
// re-checks in linkManually/linkNextSeason below, which are the other half of this guard).
const hasActiveLink = computed(
  () =>
    Object.values(linking.value).some(Boolean) ||
    Object.values(nextSeasonLinking.value).some(Boolean),
);

async function apply() {
  if (!plan.value) return;
  applying.value = true;
  try {
    result.value = await applyCrunchyrollImport(plan.value.updates, plan.value.missing);
    plan.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    applying.value = false;
  }
}

async function linkManually(item: CrunchyrollMatch) {
  if (!plan.value) return;
  const url = (linkInputs.value[item.seriesId] || '').trim();
  if (!url) return;

  linkErrors.value[item.seriesId] = '';
  linking.value[item.seriesId] = true;
  try {
    const linkResult = await resolveManualLink(item, url);
    // apply() can null the plan out while this was in flight (import ran and cleared it) - the
    // resolved link then has nowhere to go; surface that instead of dereferencing a null plan.
    if (!plan.value) {
      throw new Error(api.storage.lang('crunchyrollImport_LinkLoadError'));
    }
    if (linkResult.kind === 'update') {
      plan.value.updates.push(linkResult.item);
    } else {
      plan.value.missing.push(linkResult.item);
    }
    plan.value.unmatched = plan.value.unmatched.filter(u => u.seriesId !== item.seriesId);
  } catch (e) {
    linkErrors.value[item.seriesId] = e instanceof Error ? e.message : String(e);
  } finally {
    linking.value[item.seriesId] = false;
  }
}

async function linkNextSeason(item: CrunchyrollDiffItem | CrunchyrollMissingItem) {
  if (!plan.value || !item.nextSeason) return;
  const url = (nextSeasonLinkInputs.value[item.malId] || '').trim();
  if (!url) return;

  nextSeasonLinkErrors.value[item.malId] = '';
  nextSeasonLinking.value[item.malId] = true;
  try {
    const linkResult = await resolveManualLink(
      item.nextSeason.match,
      url,
      item.nextSeason.episodeOffset,
    );
    if (!plan.value) {
      throw new Error(api.storage.lang('crunchyrollImport_LinkLoadError'));
    }
    if (linkResult.kind === 'update') {
      plan.value.updates.push(linkResult.item);
    } else {
      plan.value.missing.push(linkResult.item);
    }
    linkedNextSeasons.value[item.malId] = true;
  } catch (e) {
    nextSeasonLinkErrors.value[item.malId] = e instanceof Error ? e.message : String(e);
  } finally {
    nextSeasonLinking.value[item.malId] = false;
  }
}
</script>

<style lang="less" scoped>
.buttons {
  display: flex;
  justify-content: flex-end;
}
.title-text {
  font-weight: bold;
}
.highlight {
  color: orange;
  font-weight: bold;
}
.error {
  color: red;
}
.warning {
  color: orange;
  margin-top: 4px;
}
.manual-link {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 4px;
  flex-wrap: wrap;
}
.manual-link-input {
  flex: 1;
  min-width: 240px;
}
</style>
