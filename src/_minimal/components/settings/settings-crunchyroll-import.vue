<template>
  <SettingsGeneral component="checkbox" :title="title">
    <template #component>
      <div class="buttons">
        <FormButton color="primary" :disabled="loading" @click="startHarvest()">
          {{ loading ? 'Buscando...' : 'Buscar histórico Crunchyroll' }}
        </FormButton>
      </div>
    </template>
  </SettingsGeneral>

  <Section v-if="loading">
    <Card
      ><div class="warning">
        ⚠ Uma aba da Crunchyroll vai abrir em segundo plano e rolar o histórico sozinha — pode levar
        alguns minutos num histórico longo. Ela fica aberta no final (não fecha sozinha), então dá
        pra conferir o console dela antes de fechar, se precisar.
      </div></Card
    >
  </Section>

  <Section v-if="error">
    <Card
      ><div class="error">{{ error }}</div></Card
    >
  </Section>

  <Section v-if="plan && !reachedBottom">
    <Card
      ><div class="warning">
        ⚠ A rolagem não chegou ao fim do seu histórico da Crunchyroll (muito longo). O resultado
        abaixo pode não cobrir tudo o que você já assistiu — rode de novo periodicamente pra ir
        cobrindo o que faltou.
      </div></Card
    >
  </Section>

  <Section v-if="plan">
    <Card v-if="plan.updates.length === 0 && plan.missing.length === 0">
      <div>Nada novo encontrado no histórico da Crunchyroll.</div>
    </Card>

    <template v-else>
      <Header v-if="plan.updates.length" spacer="half">
        Atualizações ({{ plan.updates.length }})
      </Header>
      <Description v-if="plan.updates.length" :height="400">
        <Section v-for="item in plan.updates" :key="item.malId" spacer="half">
          <Card class="listDiff">
            <Header spacer="half"
              ><span class="title-text">{{ item.title }}</span></Header
            >
            <div v-if="item.newEp !== item.currentEp">
              Episódio {{ item.currentEp }} →
              <text class="highlight">{{ item.newEp }}</text>
            </div>
            <div v-else>Episódio {{ item.currentEp }} (sem mudança)</div>
            <div v-if="item.finishDate">
              Data de término → <text class="highlight">{{ item.finishDate }}</text>
            </div>
            <div v-if="item.startDate">
              Data de início → <text class="highlight">{{ item.startDate }}</text>
            </div>
            <div v-if="item.possibleNextSeason" class="warning">
              ⚠ Crunchyroll mostra episódio além do total desta entrada — provável temporada
              seguinte não capturada. Progresso limitado ao total desta entrada.
            </div>
            <template v-if="item.nextSeason">
              <div v-if="linkedNextSeasons[item.malId]" class="hint">
                ✓ Temporada seguinte vinculada — confira a nova entrada na lista.
              </div>
              <div v-else class="manual-link">
                <FormText
                  v-model="nextSeasonLinkInputs[item.malId]"
                  :placeholder="`${manualLinkLabel} (temporada seguinte)`"
                  :disabled="nextSeasonLinking[item.malId]"
                  class="manual-link-input"
                />
                <FormButton
                  color="primary"
                  :disabled="nextSeasonLinking[item.malId] || !nextSeasonLinkInputs[item.malId]"
                  @click="linkNextSeason(item)"
                >
                  {{ nextSeasonLinking[item.malId] ? 'Vinculando...' : 'Vincular' }}
                </FormButton>
              </div>
              <div v-if="nextSeasonLinkErrors[item.malId]" class="error">
                {{ nextSeasonLinkErrors[item.malId] }}
              </div>
            </template>
          </Card>
        </Section>
      </Description>

      <Header v-if="plan.missing.length" spacer="half">
        Novas entradas ({{ plan.missing.length }})
      </Header>
      <Description v-if="plan.missing.length" :height="400">
        <Section v-for="item in plan.missing" :key="item.malId" spacer="half">
          <Card class="listDiff">
            <Header spacer="half"
              ><span class="title-text">{{ item.title }}</span></Header
            >
            <div>
              {{ item.completed ? 'Completo' : 'Assistindo' }} — episódio {{ item.watchedEp }}
            </div>
            <div v-if="item.finishDate">Data de término: {{ item.finishDate }}</div>
            <div v-if="item.startDate">Data de início: {{ item.startDate }}</div>
            <div v-if="item.possibleNextSeason" class="warning">
              ⚠ Crunchyroll mostra episódio além do total desta entrada — provável temporada
              seguinte não capturada. Progresso limitado ao total desta entrada.
            </div>
            <template v-if="item.nextSeason">
              <div v-if="linkedNextSeasons[item.malId]" class="hint">
                ✓ Temporada seguinte vinculada — confira a nova entrada na lista.
              </div>
              <div v-else class="manual-link">
                <FormText
                  v-model="nextSeasonLinkInputs[item.malId]"
                  :placeholder="`${manualLinkLabel} (temporada seguinte)`"
                  :disabled="nextSeasonLinking[item.malId]"
                  class="manual-link-input"
                />
                <FormButton
                  color="primary"
                  :disabled="nextSeasonLinking[item.malId] || !nextSeasonLinkInputs[item.malId]"
                  @click="linkNextSeason(item)"
                >
                  {{ nextSeasonLinking[item.malId] ? 'Vinculando...' : 'Vincular' }}
                </FormButton>
              </div>
              <div v-if="nextSeasonLinkErrors[item.malId]" class="error">
                {{ nextSeasonLinkErrors[item.malId] }}
              </div>
            </template>
          </Card>
        </Section>
      </Description>

      <FormButton color="primary" :disabled="applying" @click="apply()">
        {{ applying ? 'Importando...' : 'Importar' }}
      </FormButton>
    </template>

    <Card v-if="plan.unmatched.length">
      <Header spacer="half"
        >Não encontrados no {{ syncModeTitle }} ({{ plan.unmatched.length }})</Header
      >
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
            {{ linking[item.seriesId] ? 'Vinculando...' : 'Vincular' }}
          </FormButton>
        </div>
        <div v-if="linkErrors[item.seriesId]" class="error">{{ linkErrors[item.seriesId] }}</div>
      </Section>
    </Card>
  </Section>

  <Section v-if="result">
    <Card>
      <div>{{ result.updated }} atualizados, {{ result.created }} criados</div>
      <div v-if="result.errors.length">{{ result.errors.length }} com erro</div>
    </Card>
  </Section>
</template>

<script lang="ts" setup>
import { ref } from 'vue';
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
const manualLinkLabel = `Link da temporada no ${syncModeTitle}`;
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
.hint {
  color: green;
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
