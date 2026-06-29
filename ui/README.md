# WhiteBox Analytics console

The three-pane composition UI (docs/analytics-concept.md §12) over the analytics
plugin: **left** reports · **center** compose box · **right** the board of charts /
answers. v1 keeps the dependency surface tight — Vue 3 + Vite + vue-echarts +
socket.io-client (PrimeVue / Pinia / vue-query are the documented target to layer in
during polish).

## Run

```bash
# 1) Server running with the analytics plugin (from the repo's server/ dir)
cd ../server && npm run seed:analytics      # populate demo data (once)
npm start                                    # serve on :3000

# 2) This SPA
cd ../analytics-ui
cp .env.example .env.local                   # set VITE_ANALYTICS_TOKEN = server's WB_ANALYTICS_TOKEN
npm install
npm run dev                                   # http://localhost:5173
```

Vite proxies `/analytics` and `/socket.io` to `http://localhost:3000`, so the SPA
talks same-origin and live updates (`analytics.report.changed`) flow through.

## What it does

- **Ask** a plain-language question → `POST /analytics/compose` → the AI assembles
  widgets (stat · timeseries · breakdown · table · answer) and they render on the board.
- **Reports** persist (left rail); open one to re-resolve its widgets live.
- Charts via ECharts; the board re-fetches the open report on the live socket event.

Deferred to polish: drag-grid arrange, draft/published badges, share links, the
inline widget editor — see docs/analytics-concept.md.
