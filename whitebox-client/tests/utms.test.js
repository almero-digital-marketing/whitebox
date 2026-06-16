import { describe, it, expect } from 'vitest'
import { extractUtms, getReferrer } from '../src/utms.js'

describe('extractUtms', () => {
  it('extracts present UTMs from the URL', () => {
    history.replaceState({}, '', '/?utm_source=google&utm_medium=cpc&utm_campaign=spring')
    expect(extractUtms()).toEqual({
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'spring',
    })
  })

  it('returns empty object when no UTMs', () => {
    history.replaceState({}, '', '/no-utms')
    expect(extractUtms()).toEqual({})
  })

  it('ignores non-UTM query params', () => {
    history.replaceState({}, '', '/?foo=bar&utm_source=x')
    expect(extractUtms()).toEqual({ utm_source: 'x' })
  })
})

describe('getReferrer', () => {
  it('returns document.referrer or null', () => {
    // happy-dom defaults referrer to ''
    expect(getReferrer()).toBeNull()
  })
})
