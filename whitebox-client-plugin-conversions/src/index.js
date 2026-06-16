// Conversions plugin — sends conversion events to whitebox-server.
// STUB: pending the server-side conversions module.

export default function conversionsPlugin() {
  return {
    name: 'conversions',
    install(core) {
      const { http, queue, logger } = core

      async function track(name, { value, currency, meta, event_id } = {}) {
        if (!name) throw new Error('conversions.track: `name` is required')

        const eventId = event_id || crypto.randomUUID()
        return queue(async () => {
          await http.request('/conversions/events', {
            method: 'POST',
            body: {
              events: [{
                event_id: eventId,
                name,
                ts: new Date().toISOString(),
                url: typeof window !== 'undefined' ? window.location.href : null,
                value,
                currency,
                meta,
              }],
            },
          })
          return { event_id: eventId }
        })
      }

      core.attach('conversions', { track })
    },
  }
}
