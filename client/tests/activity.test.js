import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import createActivity from '../src/activity.js'

describe('activity gate', () => {
  let activity

  beforeEach(() => {
    activity = createActivity({ idleAfterMs: 100 })
    activity.attach()
  })

  afterEach(() => {
    activity.detach()
  })

  it('starts active (recent activity, focused, visible)', () => {
    expect(activity.isActive()).toBe(true)
  })

  it('marks inactive when tab becomes hidden', () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(activity.isActive()).toBe(false)
    // restore
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })

  it('marks inactive on window blur, active on focus', () => {
    window.dispatchEvent(new Event('blur'))
    expect(activity.isActive()).toBe(false)
    window.dispatchEvent(new Event('focus'))
    expect(activity.isActive()).toBe(true)
  })

  it('on() callback fires when state changes', () => {
    const handler = vi.fn()
    activity.on(handler)
    window.dispatchEvent(new Event('blur'))
    expect(handler).toHaveBeenCalled()
  })

  it('becomes inactive after idle timeout elapses', async () => {
    // No user activity for > idleAfterMs (100ms)
    await new Promise(r => setTimeout(r, 130))
    expect(activity.isActive()).toBe(false)
  })

  it('activity events refresh the idle timer', async () => {
    await new Promise(r => setTimeout(r, 80))
    window.dispatchEvent(new Event('mousemove'))
    await new Promise(r => setTimeout(r, 50))
    // 50ms after last activity, still well within idleAfterMs window
    expect(activity.isActive()).toBe(true)
  })
})
