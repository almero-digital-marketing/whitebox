import { createApp } from 'vue'
import { createPinia } from 'pinia'
import PrimeVue from 'primevue/config'
import ConfirmationService from 'primevue/confirmationservice'
import Tooltip from 'primevue/tooltip'
import { definePreset } from '@primevue/themes'
import Aura from '@primevue/themes/aura'
import 'primeicons/primeicons.css'
import App from './App.vue'
import { router } from './shell/router'
import './style.css'

// "Noir" — the black/white primary used on primevue.org (Aura with the primary
// ramp pointed at zinc, so the accent is near-black in light mode). Surfaces stay
// the neutral Aura grays.
const Noir = definePreset(Aura, {
  semantic: {
    primary: {
      50: '{zinc.50}', 100: '{zinc.100}', 200: '{zinc.200}', 300: '{zinc.300}',
      400: '{zinc.400}', 500: '{zinc.500}', 600: '{zinc.600}', 700: '{zinc.700}',
      800: '{zinc.800}', 900: '{zinc.900}', 950: '{zinc.950}',
    },
    colorScheme: {
      light: {
        primary: { color: '{zinc.950}', contrastColor: '#ffffff', hoverColor: '{zinc.900}', activeColor: '{zinc.800}' },
        highlight: { background: '{zinc.950}', focusBackground: '{zinc.700}', color: '#ffffff', focusColor: '#ffffff' },
      },
      dark: {
        primary: { color: '{zinc.50}', contrastColor: '{zinc.950}', hoverColor: '{zinc.100}', activeColor: '{zinc.200}' },
        highlight: { background: 'rgba(250,250,250,.16)', focusBackground: 'rgba(250,250,250,.24)', color: 'rgba(255,255,255,.87)', focusColor: 'rgba(255,255,255,.87)' },
      },
    },
  },
})

createApp(App)
  .use(createPinia())
  .use(router)
  .use(PrimeVue, { theme: { preset: Noir, options: { darkModeSelector: '.app-dark' } } })
  .use(ConfirmationService)
  .directive('tooltip', Tooltip)
  .mount('#app')
