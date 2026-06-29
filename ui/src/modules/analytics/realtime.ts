// Live sync: the analytics store broadcasts `analytics.changed` over Socket.IO on
// EVERY mutation (report/widget create·update·delete) — regardless of who made it
// (this tab, another tab, or an MCP agent). We subscribe and let the app refresh.
// Connects same-origin (Vite proxies /socket.io to the server).

import { io, type Socket } from 'socket.io-client'

export function onAnalyticsChanged(handler: (p: { report_id: string; action: string; widget_id?: string }) => void): () => void {
  let socket: Socket | null = null
  try {
    socket = io({ transports: ['websocket', 'polling'], reconnection: true })
    socket.on('analytics.changed', handler)
  } catch {
    /* sockets are a nice-to-have; the app still works without them */
  }
  // detach the handler before disconnecting so a remount (HMR / cache eviction) can't
  // stack duplicate listeners on a reused/reconnecting socket.
  return () => { socket?.off('analytics.changed', handler); socket?.disconnect() }
}
