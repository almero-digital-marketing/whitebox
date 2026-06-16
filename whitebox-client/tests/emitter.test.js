import { describe, it, expect, vi } from 'vitest'
import createEmitter from '../src/emitter.js'

describe('emitter', () => {
  it('on() registers a listener invoked by emit()', () => {
    const e = createEmitter()
    const fn = vi.fn()
    e.on('foo', fn)
    e.emit('foo', { x: 1 })
    expect(fn).toHaveBeenCalledWith({ x: 1 })
  })

  it('on() returns an unsubscribe function', () => {
    const e = createEmitter()
    const fn = vi.fn()
    const off = e.on('foo', fn)
    off()
    e.emit('foo', {})
    expect(fn).not.toHaveBeenCalled()
  })

  it('off() removes a listener', () => {
    const e = createEmitter()
    const fn = vi.fn()
    e.on('foo', fn)
    e.off('foo', fn)
    e.emit('foo', {})
    expect(fn).not.toHaveBeenCalled()
  })

  it('a thrown listener does not break others', () => {
    const e = createEmitter()
    const bad = vi.fn(() => { throw new Error('boom') })
    const good = vi.fn()
    e.on('foo', bad)
    e.on('foo', good)
    e.emit('foo', {})
    expect(good).toHaveBeenCalled()
  })

  it('emit() on an unknown event is a no-op', () => {
    const e = createEmitter()
    expect(() => e.emit('nothing', {})).not.toThrow()
  })

  it('clear() removes all listeners', () => {
    const e = createEmitter()
    const fn = vi.fn()
    e.on('foo', fn)
    e.clear()
    e.emit('foo', {})
    expect(fn).not.toHaveBeenCalled()
  })
})
