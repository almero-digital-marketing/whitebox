<script setup lang="ts">
import Textarea from 'primevue/textarea'
defineProps<{ model: any }>()
</script>

<template>
  <label class="lab">Question</label>
  <Textarea v-model="model.question" rows="2" autoResize class="w" placeholder="e.g. What are clients most interested in?" />
  <p class="hint">Asked against everyone's memory; the answer is written by the AI.</p>
</template>
