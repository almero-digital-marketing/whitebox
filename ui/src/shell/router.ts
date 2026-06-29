// Client-side routing. Each module owns a top-level path (/analytics, /campaigns, …)
// derived from its id in the registry, so adding a module to modules.ts gives it a
// route for free. "/" redirects to the first module; unknown paths fall back to it.
import { createRouter, createWebHistory } from 'vue-router'
import { modules } from './modules'

const home = `/${modules[0].id}`

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: home },
    ...modules.map((m) => ({ path: m.subPath ? `/${m.id}/${m.subPath}` : `/${m.id}`, name: m.id, component: m.component })),
    { path: '/:pathMatch(.*)*', redirect: home },
  ],
})
