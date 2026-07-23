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
            <div>Assistindo — episódio {{ item.watchedEp }}</div>
            <div v-if="item.finishDate">Data de término: {{ item.finishDate }}</div>
            <div v-if="item.startDate">Data de início: {{ item.startDate }}</div>
            <div v-if="item.possibleNextSeason" class="warning">
              ⚠ Crunchyroll mostra episódio além do total desta entrada — provável temporada
              seguinte não capturada. Progresso limitado ao total desta entrada.
            </div>
          </Card>
        </Section>
      </Description>

      <FormButton color="primary" :disabled="applying" @click="apply()">
        {{ applying ? 'Importando...' : 'Importar' }}
      </FormButton>
    </template>

    <Card v-if="plan.unmatched.length">
      <Header spacer="half">Não encontrados no MAL ({{ plan.unmatched.length }})</Header>
      <div v-for="item in plan.unmatched" :key="item.seriesId">{{ item.seriesTitle }}</div>
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
  type CrunchyrollImportPlan,
} from '../../../utils/crunchyrollImport';
import FormButton from '../form/form-button.vue';
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
</style>
