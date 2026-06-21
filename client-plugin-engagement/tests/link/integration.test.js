import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import createLink from '../../src/link.js'

function click(el) { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) }

describe('link-click tracking', () => {
  let tracker, onClick
  beforeEach(() => {
    document.body.innerHTML = ''
    onClick = vi.fn()
    tracker = createLink({ onClick })
    tracker.start()
  })
  afterEach(() => tracker.stop())

  it('uses the data-wb-link override when the visible text is generic', () => {
    document.body.innerHTML = '<a id="a" href="/implants" data-wb-link="dental implant pricing">Learn more</a>'
    click(document.getElementById('a'))
    expect(onClick).toHaveBeenCalledWith(expect.objectContaining({ text: 'dental implant pricing' }))
  })

  it('uses the anchor text when it is meaningful (bare data-wb-link)', () => {
    document.body.innerHTML = '<a id="a" href="/x" data-wb-link>Compare whitening options</a>'
    click(document.getElementById('a'))
    expect(onClick.mock.calls[0][0].text).toBe('Compare whitening options')
  })

  it('falls back to the href when text is generic and no override/label', () => {
    document.body.innerHTML = '<a id="a" href="/implant-pricing" data-wb-link>Learn more</a>'
    click(document.getElementById('a'))
    expect(onClick.mock.calls[0][0].text).toBe('implant pricing')
  })

  it('resolves the anchor when a child element is clicked', () => {
    document.body.innerHTML = '<a id="a" href="/x" data-wb-link="veneers"><span id="s">Read more</span></a>'
    click(document.getElementById('s'))
    expect(onClick).toHaveBeenCalledWith(expect.objectContaining({ text: 'veneers', href: expect.stringContaining('/x') }))
  })

  it('ignores links that did not opt in', () => {
    document.body.innerHTML = '<a id="a" href="/x">Home</a>'
    click(document.getElementById('a'))
    expect(onClick).not.toHaveBeenCalled()
  })

  it('stops listening after stop()', () => {
    document.body.innerHTML = '<a id="a" href="/x" data-wb-link="z">go</a>'
    tracker.stop()
    click(document.getElementById('a'))
    expect(onClick).not.toHaveBeenCalled()
  })
})
