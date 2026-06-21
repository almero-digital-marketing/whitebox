import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import createVelocity from '../../src/velocity.js'

describe('velocity gate', () => {
  let velocity

  beforeEach(() => {
    velocity = createVelocity({ maxVelocity: 1.0, quietMs: 50 })
    velocity.attach()
    window.scrollY = 0
  })

  afterEach(() => velocity.detach())

  it('starts stable (no scroll movement)', () => {
    expect(velocity.isStable()).toBe(true)
  })

  it('becomes unstable when scrolled rapidly', async () => {
    // Simulate rapid scrolling
    window.scrollY = 0
    window.dispatchEvent(new Event('scroll'))
    await new Promise(r => setTimeout(r, 10))
    window.scrollY = 2000
    window.dispatchEvent(new Event('scroll'))
    expect(velocity.isStable()).toBe(false)
  })

  it('returns to stable after quietMs without scroll', async () => {
    window.scrollY = 500
    window.dispatchEvent(new Event('scroll'))
    await new Promise(r => setTimeout(r, 70))  // > quietMs
    expect(velocity.isStable()).toBe(true)
  })

  it('getVelocity() returns current px/ms value', async () => {
    window.scrollY = 0
    window.dispatchEvent(new Event('scroll'))
    await new Promise(r => setTimeout(r, 20))
    window.scrollY = 200
    window.dispatchEvent(new Event('scroll'))
    expect(velocity.getVelocity()).toBeGreaterThan(0)
  })
})
