// Browser-pixel dispatch over the COMPOSED client networks. Each is a descriptor
// from a network package's /client entry — { name, present(), collect(), fire() }
// (e.g. `import { meta } from 'whitebox-pro-adnetworks-meta/client'`). A missing
// pixel is a silent no-op; a throwing one doesn't sink the others.

export function createPixels({ networks = [], logger } = {}) {
  return {
    // kind: 'standard' | 'custom'. Returns the network names actually fired.
    fire(kind, name, payload, eventId) {
      const fired = []
      for (const net of networks) {
        if (!net?.present?.()) continue
        try {
          net.fire(kind, name, payload, eventId)
          fired.push(net.name)
        } catch (err) {
          logger?.warn?.(`conversions: ${net.name} pixel failed`, err)
        }
      }
      return fired
    },
  }
}
