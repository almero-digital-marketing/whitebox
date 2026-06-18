# 02 · Reading model (text)

Text isn't tracked like images. People read **top-to-bottom, one block at a time**, spending time
proportional to length, and a block "loaded on screen" is not a block "read". This is the model that
encodes that.

## The reading band

A block is **visible** (eligible to accrue) when at least `minRatio` of it sits inside the band defined
by `rootMargin`. The band is the part of the viewport where reading happens:

```
  0% ┌─────────────────────────┐ ← top of viewport   (rootMargin top)
     │  RELEASED                │  a block scrolled up to here lets go of focus
 25% ├─────────────────────────┤ ← reading line       (readingLineRatio)
     │                          │
     │   ACTIVE reading band    │  the focused block accrues dwell here
     │                          │
 70% ├─────────────────────────┤ ← band bottom        (rootMargin bottom = -30%)
     │  ARRIVING (not yet)      │  must rise into the band before it can take focus
100% └─────────────────────────┘ ← bottom of viewport
```

- **`rootMargin`** sets the band edges. The demo uses `'0% 0% -30% 0%'` — open at the top (count from
  the very top), held back 30% at the bottom (arriving content waits until it's risen into view). The
  SDK default is the central `'-20% 0% -20% 0%'`.
- **`minRatio`** (default `0.5`; demo `0.35`) — how much of a block must be in the band to count.

## Sequential focus — one block at a time

In sequential mode (the text default), only **one** block accrues dwell at a time: the **topmost
visible, not-yet-read block**. When it's read (or scrolls away), focus advances to the next one down.
That's why reads light up one-by-one as you scroll, instead of a whole screenful firing at once.

### Independent queues per kind

Headings and paragraphs read as **separate** top-to-bottom queues (grouped by kind). A heading never
blocks the paragraph under it, and vice-versa — each queue has its own focus, running in parallel.
(Images and video are separate trackers entirely, also parallel.)

## Releasing a block you've scrolled past

Plain "topmost visible" has a flaw: a block you've already read but scrolled to the top of the screen
keeps the focus and blocks the block you're *now* reading. So a block **releases** focus once its
**middle** rises above the **reading line** (`readingLineRatio`, default `0.25`).

The subtlety is telling "fresh content at the top on load" apart from "already-read content at the top
after scrolling". The signal is **document position, not viewport position**:

> A block is **above-the-fold** iff `rect.top + scrollY < viewportHeight` — i.e. it's in the document's
> first screen. Above-the-fold blocks are **never** released by the reading line (they count from the
> top on load). Everything deeper releases once its middle passes the line.

This is also what makes a **mid-page refresh** work: after a refresh deep in the page, the blocks at the
top of the viewport are deep in the *document*, so they're not above-the-fold — they release, and focus
lands on the block you're actually looking at.

## End-of-document — the mirror of above-the-fold

The bottom margin means the **last screen** of content can never be scrolled up into the band — so
without help, the final paragraphs would never be tracked. `endOfDocument` (default `true` for text)
fixes it: when you've scrolled into the last screen (`scrollY + vh > docHeight - vh`), a block pinned in
the bottom band still counts if it's substantially on screen. So the closing paragraphs track even with
no whitespace below them. (There is no widely-used term for this — we call it *end-of-document*.)

## Pointer attention (desktop)

People also direct attention with the mouse. If the pointer **rests on a tracked block** for
`pointerDwellMs` (default 500 ms), that block becomes the focus for its queue, **overriding reading
order** — because that's most likely what's being read. It's inert on touch (no hover), so mobile
falls back cleanly to scroll-driven sequential reading. Disable with `pointerAttention:false`.

## Worked examples

**Reading top-to-bottom (no mouse).** Focus is the topmost visible paragraph. You dwell, it fires
green, focus drops to the next. Scroll smoothly and pause on each — reads cascade in order.

**Jumping with the mouse.** You park the cursor on paragraph 5 while 3–4 are above it. Focus jumps to
5 (pointer attention); 3–4 don't accrue (you're not reading them).

**A long paragraph being read.** Its top scrolls above the viewport but its middle is still below the
reading line → it keeps focus (you're mid-paragraph). Only once its middle passes the line does it
release.

**Loading mid-page (refresh).** The top-of-viewport blocks are deep in the document → not
above-the-fold → they release → focus lands on the block centered in front of you. ✓

**The last paragraph.** At max scroll it's pinned in the bottom 30% (below the band). `endOfDocument`
makes it eligible anyway, so the closing block still fires. ✓

## The knobs that shape all of this

| option | default (SDK · demo) | effect |
|---|---|---|
| `rootMargin` | `-20%/-20%` · `0%/-30%` | the band edges |
| `minRatio` | `0.5` · `0.35` | how much of a block must be in the band |
| `sequential` | `true` | one focus at a time (vs parallel) |
| `readingLineRatio` | `0.25` | where a block releases focus after you scroll past |
| `endOfDocument` | `true` | count the document's last screen |
| `pointerAttention` | `true` | mouse-rest overrides reading order (desktop) |
| `pointerDwellMs` | `500` | how long the mouse must rest |

Dwell (how *long* a block must hold focus) is [03 · Gates & dwell](03-gates-and-dwell.md).
