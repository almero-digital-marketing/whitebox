// The registry of feature modules shown in the activity bar (VS Code-style).
// Add a module here and it appears as an icon on the left. Analytics is first;
// Campaigns (email/SMS planning + execution) is next. Each module is a self-
// contained folder under src/modules/<id>/ with its own components/api/styles.
import { markRaw, type Component } from 'vue'
import Analytics from '../modules/analytics/Analytics.vue'
import Audiences from '../modules/audiences/Audiences.vue'
import Campaigns from '../modules/campaigns/Campaigns.vue'

export interface ModuleDef {
  id: string
  label: string
  icon: string        // primeicons class
  component: Component
  // optional route sub-segments appended to the module's path, so deep state lives in
  // the URL (analytics carries the open report + selected widget). Omit for a flat path.
  subPath?: string
}

export const modules: ModuleDef[] = [
  { id: 'analytics', label: 'Analytics', icon: 'pi pi-chart-bar', component: markRaw(Analytics), subPath: ':reportId?/:widgetId?' },
  { id: 'audiences', label: 'Audiences', icon: 'pi pi-users', component: markRaw(Audiences), subPath: ':audienceId?' },
  { id: 'campaigns', label: 'Campaigns', icon: 'pi pi-send', component: markRaw(Campaigns), subPath: ':campaignId?' },
]
