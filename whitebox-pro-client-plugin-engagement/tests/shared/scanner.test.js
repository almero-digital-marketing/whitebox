import { describe, it, expect } from 'vitest'
import {
  findReadable, shouldTrack, elementId, hashText,
  DEFAULT_TEXT_SELECTOR, DEFAULT_TEXT_EXCLUDE, DEFAULT_TEXT_ID_ATTR,
  DEFAULT_IMAGE_SELECTOR, DEFAULT_IMAGE_EXCLUDE, DEFAULT_IMAGE_ID_ATTR,
} from '../../src/scanner.js'

function root() {
  document.body.innerHTML = ''
  return document.body
}

const textOptions = {
  selector: DEFAULT_TEXT_SELECTOR,
  excludeSelector: DEFAULT_TEXT_EXCLUDE,
  idAttribute: DEFAULT_TEXT_ID_ATTR,
  minLength: 3,
}

const imageOptions = {
  selector: DEFAULT_IMAGE_SELECTOR,
  excludeSelector: DEFAULT_IMAGE_EXCLUDE,
  idAttribute: DEFAULT_IMAGE_ID_ATTR,
}

describe('scanner.findReadable (opt-in only)', () => {

  it('finds only elements matching the selector', () => {
    const r = root()
    r.innerHTML = `
      <p>${'A'.repeat(120)}</p>
      <p data-wb-text>${'B'.repeat(120)}</p>
      <h2>Untracked heading</h2>
      <h2 data-wb-text>Tracked heading</h2>
    `
    const found = findReadable(r, textOptions)
    expect(found).toHaveLength(2)
    expect(found[0].tagName).toBe('P')
    expect(found[1].tagName).toBe('H2')
  })

  it('works on any element type when opted in', () => {
    const r = root()
    r.innerHTML = `
      <div data-wb-text>Some div text</div>
      <span data-wb-text="cta">Click me</span>
      <article data-wb-text>An article</article>
    `
    expect(findReadable(r, textOptions)).toHaveLength(3)
  })

  it('honors data-wb-notext opt-out (including ancestors)', () => {
    const r = root()
    r.innerHTML = `
      <p data-wb-text>Tracked.</p>
      <footer data-wb-notext>
        <p data-wb-text>Footer paragraph — skipped.</p>
        <h2 data-wb-text>Footer heading — skipped.</h2>
      </footer>
    `
    const found = findReadable(r, textOptions)
    expect(found).toHaveLength(1)
    expect(found[0].textContent).toBe('Tracked.')
  })

  it('ignores elements without the selector attribute', () => {
    const r = root()
    r.innerHTML = `<p>${'A'.repeat(500)}</p><h1>Welcome</h1>`
    expect(findReadable(r, textOptions)).toHaveLength(0)
  })

  it('respects minLength threshold', () => {
    const r = root()
    r.innerHTML = `
      <p data-wb-text>   </p>
      <p data-wb-text>Hi</p>
      <p data-wb-text>Yes</p>
    `
    const found = findReadable(r, textOptions)
    expect(found).toHaveLength(1)
    expect(found[0].textContent.trim()).toBe('Yes')
  })

  it('returns [] for null/invalid root or missing selector', () => {
    expect(findReadable(null, textOptions)).toEqual([])
    expect(findReadable({}, textOptions)).toEqual([])
    expect(findReadable(root(), {})).toEqual([])
  })
})

describe('scanner.findReadable with custom config', () => {

  it('matches custom CSS selectors', () => {
    const r = root()
    r.innerHTML = `
      <p class="article-paragraph">First.</p>
      <h2 class="article-heading">Second</h2>
      <p>Plain — not tracked.</p>
    `
    const found = findReadable(r, {
      selector: '.article-paragraph, .article-heading',
    })
    expect(found).toHaveLength(2)
  })

  it('honors a custom excludeSelector', () => {
    const r = root()
    r.innerHTML = `
      <p class="track">First.</p>
      <div class="skip">
        <p class="track">Excluded via ancestor.</p>
      </div>
    `
    const found = findReadable(r, { selector: '.track', excludeSelector: '.skip' })
    expect(found).toHaveLength(1)
    expect(found[0].textContent).toBe('First.')
  })

  it('finds image opt-ins by default selector', () => {
    const r = root()
    r.innerHTML = `
      <img src="/a.png" data-wb-image>
      <img src="/b.png">
      <div data-wb-image>Image-wrapper div</div>
    `
    const found = findReadable(r, imageOptions)
    expect(found).toHaveLength(2)
  })
})

describe('scanner.shouldTrack', () => {

  it('returns false for elements not matching selector', () => {
    const r = root()
    r.innerHTML = `<p>${'A'.repeat(200)}</p>`
    expect(shouldTrack(r.firstElementChild, textOptions)).toBe(false)
  })

  it('returns true for opt-in elements with enough text', () => {
    const r = root()
    r.innerHTML = `<p data-wb-text>${'A'.repeat(50)}</p>`
    expect(shouldTrack(r.firstElementChild, textOptions)).toBe(true)
  })

  it('rejects opt-in element inside data-wb-notext ancestor', () => {
    const r = root()
    r.innerHTML = `<div data-wb-notext><p data-wb-text>${'A'.repeat(100)}</p></div>`
    expect(shouldTrack(r.querySelector('p'), textOptions)).toBe(false)
  })

  it('rejects an element with both attributes', () => {
    const r = root()
    r.innerHTML = `<p data-wb-text data-wb-notext>Skipped.</p>`
    expect(shouldTrack(r.firstElementChild, textOptions)).toBe(false)
  })

  it('returns false without a selector', () => {
    const r = root()
    r.innerHTML = `<p>hello</p>`
    expect(shouldTrack(r.firstElementChild, {})).toBe(false)
  })
})

describe('scanner.elementId', () => {

  it('uses idAttribute value when set', () => {
    const r = root()
    r.innerHTML = `<p data-wb-text="pricing-cta">Read this</p>`
    expect(elementId(r.firstElementChild, textOptions)).toBe('pricing-cta')
  })

  it('falls back to text hash when attribute is empty', () => {
    const r = root()
    r.innerHTML = `<p data-wb-text>Some content</p>`
    const id = elementId(r.firstElementChild, textOptions)
    expect(id.startsWith('wb:')).toBe(true)
  })

  it('uses src as hash basis for img elements', () => {
    const r = root()
    r.innerHTML = `<img src="https://x/a.png" data-wb-image>`
    const id = elementId(r.firstElementChild, imageOptions)
    expect(id.startsWith('wb:')).toBe(true)
  })

  it('honors custom idAttribute', () => {
    const r = root()
    r.innerHTML = `<p data-section-id="intro" data-wb-text>Read this</p>`
    expect(elementId(r.firstElementChild, { idAttribute: 'data-section-id' })).toBe('intro')
  })

  it('produces stable hashes', () => {
    expect(hashText('Hello world')).toBe(hashText('Hello world'))
    expect(hashText('Hello')).not.toBe(hashText('World'))
  })
})
