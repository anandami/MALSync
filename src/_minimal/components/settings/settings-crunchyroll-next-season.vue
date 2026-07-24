<template>
  <div class="warning">⚠ {{ lang('crunchyrollImport_PossibleNextSeasonWarning') }}</div>
  <div v-if="linked" class="hint">✓ {{ lang('crunchyrollImport_NextSeasonLinked') }}</div>
  <div v-else class="manual-link">
    <FormText
      :model-value="modelValue"
      :placeholder="lang('crunchyrollImport_NextSeasonSuffix', [manualLinkLabel])"
      :disabled="linking"
      class="manual-link-input"
      @update:model-value="$emit('update:modelValue', $event)"
    />
    <FormButton color="primary" :disabled="linking || !modelValue" @click="$emit('submit')">
      {{
        linking ? lang('crunchyrollImport_LinkButtonLoading') : lang('crunchyrollImport_LinkButton')
      }}
    </FormButton>
  </div>
  <div v-if="error" class="error">{{ error }}</div>
</template>

<script lang="ts" setup>
import FormButton from '../form/form-button.vue';
import FormText from '../form/form-text.vue';

defineProps<{
  manualLinkLabel: string;
  linked: boolean;
  linking: boolean;
  error?: string;
  modelValue: string;
}>();
defineEmits<{
  (e: 'update:modelValue', value: string): void;
  (e: 'submit'): void;
}>();
</script>

<style lang="less" scoped>
.warning {
  color: orange;
  margin-top: 4px;
}
.hint {
  color: green;
  margin-top: 4px;
}
.error {
  color: red;
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
