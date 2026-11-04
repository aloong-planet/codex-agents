// Demo harness dock (copied from the prototype skill's template; do not edit by hand — change the skill
// template and copy it again). Scaffolding, not part of any design.
//
// Include it once per prototype page, after the element marked data-demo-harness:
//   <script src="../demo-harness.js"></script>
// The page keeps styling and filling its own bar; this script only changes how the bar sits on screen:
//   · the bar is exactly as wide as its widest row (a wrapped flex box otherwise keeps the full width
//     it was offered, leaving wide empty margins either side of the rows);
//   · its grip, or any bare background around and between the rows, drags it anywhere; a button
//     collapses it into a small ball that drags the same way, and clicking the ball expands it again;
//   · bar and ball are kept wholly inside the viewport, while dragging and after every resize;
//   · the position and the collapsed state carry over between prototype pages and reloads.
(() => {
  const h = document.querySelector('[data-demo-harness]')
  if (!h) return

  const GAP = 8        // the minimum distance kept between the dock and each viewport edge
  const BALL = 32
  const KEY = 'proto-demo-harness'

  document.head.insertAdjacentHTML('beforeend', `<style>
    [data-demo-harness] > .dh-handle{display:inline-flex;align-items:center;gap:2px;flex:none;
      color:rgba(255,255,255,.5)}
    .dh-handle > span{display:grid;place-items:center;height:22px;border-radius:6px}
    .dh-handle > span:hover{background:rgba(255,255,255,.1);color:#fff}
    [data-demo-harness]:not(.dh-ball){cursor:grab;touch-action:none}
    :where([data-demo-harness]:not(.dh-ball)) > :where(:not(.dh-handle)){cursor:auto}
    .dh-grip{width:14px;cursor:grab}
    .dh-min{width:22px;cursor:pointer}
    .dh-min:focus-visible,.dh-ball:focus-visible{outline:2px solid rgba(255,255,255,.7);outline-offset:1px}
    [data-demo-harness].dh-folded{visibility:hidden !important;pointer-events:none !important}
    .dh-ball[data-demo-harness]{position:fixed !important;right:auto !important;bottom:auto !important;
      transform:none !important;margin:0 !important;padding:0 !important;border:0 !important;
      width:${BALL}px !important;height:${BALL}px !important;min-width:0 !important;max-width:none !important;
      display:grid !important;place-items:center !important;border-radius:50% !important;
      color:rgba(255,255,255,.75) !important;box-shadow:0 4px 16px rgba(0,0,0,.35) !important;
      cursor:grab;touch-action:none;user-select:none}
    .dh-ball[data-demo-harness]:hover{color:#fff !important}
    .dh-ball[data-demo-harness][hidden]{display:none !important}
    .dh-dragging,.dh-dragging *{cursor:grabbing !important;user-select:none !important}
  </style>`)

  // Spans rather than buttons: several pages style every "[data-demo-harness] button" as one of their pills
  const handle = document.createElement('span')
  handle.className = 'dh-handle'
  handle.innerHTML =
    `<span class="dh-grip" title="Drag to move" aria-hidden="true"><svg width="8" height="14" viewBox="0 0 8 14"
      fill="currentColor"><circle cx="2" cy="2" r="1.2"/><circle cx="6" cy="2" r="1.2"/><circle cx="2" cy="7" r="1.2"/>
      <circle cx="6" cy="7" r="1.2"/><circle cx="2" cy="12" r="1.2"/><circle cx="6" cy="12" r="1.2"/></svg></span>` +
    `<span class="dh-min" role="button" tabindex="0" title="Collapse" aria-label="Collapse the demo bar"><svg
      width="12" height="12" viewBox="0 0 12 12"><path d="M2.5 6h7" stroke="currentColor" stroke-width="1.6"
      stroke-linecap="round"/></svg></span>`
  const grip = handle.firstElementChild
  const minBtn = handle.lastElementChild

  // The ball carries the marker too, so whatever filters out the harness filters it out as well
  const ball = document.createElement('div')
  ball.className = 'dh-ball'
  ball.setAttribute('data-demo-harness', '')
  ball.setAttribute('role', 'button')
  ball.tabIndex = 0
  ball.title = 'Demo controls: click to expand, drag to move'
  ball.setAttribute('aria-label', 'Expand the demo bar')
  ball.hidden = true
  ball.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    stroke-width="1.5" stroke-linecap="round"><path d="M2 5h12M2 11h12"/><circle cx="10" cy="5" r="2"
    fill="currentColor" stroke="none"/><circle cx="6" cy="11" r="2" fill="currentColor" stroke="none"/></svg>`
  document.body.appendChild(ball)
  const hs = getComputedStyle(h)
  const bg = hs.backgroundColor
  ball.style.setProperty('background', /^rgba\(.*, 0\)$|^transparent$/.test(bg) ? '#1c1c1e' : bg, 'important')
  ball.style.setProperty('z-index', hs.zIndex === 'auto' ? '50' : hs.zIndex, 'important')

  // { collapsed, pos }. pos is null while the bar sits where the page's own stylesheet puts it; once dragged,
  // it holds the anchor (the centre of the ball, which is also the centre of the bar's handle) as distances
  // from the nearer horizontal and vertical edge, so a dock left in a corner stays in that corner on resize
  let st = { collapsed: false, pos: null }
  try { st = { ...st, ...JSON.parse(localStorage.getItem(KEY) || '{}') } } catch {}
  if (!st.pos || !Number.isFinite(st.pos.x) || !Number.isFinite(st.pos.y)) st.pos = null
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)) } catch {} }

  const vw = () => document.documentElement.clientWidth
  const vh = () => document.documentElement.clientHeight
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi))
  const centre = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } }
  const POS = ['left', 'top', 'right', 'bottom', 'margin', 'transform']
  let dragging = false

  function anchor() {
    const p = st.pos
    if (!p) return null
    return { x: p.hx === 'l' ? p.x : vw() - p.x, y: p.vy === 't' ? p.y : vh() - p.y }
  }
  function remember({ x, y }) {
    const l = x < vw() / 2, t = y < vh() / 2
    st.pos = { hx: l ? 'l' : 'r', x: Math.round(l ? x : vw() - x), vy: t ? 't' : 'b', y: Math.round(t ? y : vh() - y) }
    save()
  }

  /** Puts el's top-left corner at (left, top), pulled back inside the viewport */
  function moveTo(el, left, top) {
    const r = el.getBoundingClientRect()
    const at = { left: clamp(left, GAP, vw() - r.width - GAP), top: clamp(top, GAP, vh() - r.height - GAP) }
    for (const k of POS) el.style.setProperty(k, k in at ? `${at[k]}px` : k === 'margin' ? '0' : k === 'transform' ? 'none' : 'auto', 'important')
  }

  /** The horizontal extent of the bar's rows: its children's margin boxes, plus any bare text */
  function rowsWidth() {
    let l = Infinity, r = -Infinity
    for (const n of h.childNodes) {
      let boxes = []
      if (n.nodeType === 1) {
        const cs = getComputedStyle(n)
        if (cs.display === 'none' || cs.position === 'absolute' || cs.position === 'fixed') continue
        const b = n.getBoundingClientRect()
        if (b.width || b.height) boxes = [{ left: b.left - parseFloat(cs.marginLeft), right: b.right + parseFloat(cs.marginRight) }]
      } else if (n.nodeType === 3 && n.data.trim()) {
        const range = document.createRange()
        range.selectNodeContents(n)
        boxes = [...range.getClientRects()]
      }
      for (const b of boxes) { l = Math.min(l, b.left); r = Math.max(r, b.right) }
    }
    return r > l ? r - l : 0
  }

  /**
   * Shrinks the bar to its widest row. Shrinking to that width never moves a line break: every row
   * still fits, and the first item of each next row did not fit even in the wider box. Returns false while
   * the page itself hides the bar (a context the switches do not apply to).
   */
  function fitWidth() {
    const cs = getComputedStyle(h)
    if (cs.display === 'none') return false
    const frame = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce((s, k) => s + parseFloat(cs[k]), 0)
    const toProp = cs.boxSizing === 'border-box' ? 0 : -frame   // a border-box width → the width property
    h.style.setProperty('width', 'max-content', 'important')
    const natural = h.getBoundingClientRect().width
    if (!natural) return false
    const cap = vw() - 2 * GAP
    if (natural > cap) h.style.setProperty('width', `${cap + toProp}px`, 'important')
    const want = Math.ceil(rowsWidth()) + 1 + frame
    if (want < Math.min(natural, cap)) h.style.setProperty('width', `${want + toProp}px`, 'important')
    return true
  }

  function place() {
    if (dragging) return
    if (h.firstChild !== handle) h.prepend(handle)
    const shown = fitWidth()
    h.classList.toggle('dh-folded', st.collapsed)
    ball.hidden = !(shown && st.collapsed)
    if (!shown) return
    const a = anchor()
    if (a) {
      const r = h.getBoundingClientRect(), c = centre(handle)
      moveTo(h, a.x - (c.x - r.left), a.y - (c.y - r.top))
    } else {
      for (const k of POS) h.style.removeProperty(k)
    }
    if (st.collapsed) {
      // Before the first drag the ball takes the handle's place in the bar
      const c = a || centre(handle)
      moveTo(ball, c.x - BALL / 2, c.y - BALL / 2)
    }
  }

  function setCollapsed(v, viaKeyboard) {
    st.collapsed = v
    save()
    place()
    if (viaKeyboard) (v ? ball : minBtn).focus()
  }

  /** A press on grabber, on a target that accepts allows, drags el; a press that does not move is a click */
  function draggable(grabber, el, { accepts = () => true, onClick } = {}) {
    grabber.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !accepts(e.target)) return
      e.preventDefault()
      const start = el.getBoundingClientRect(), sx = e.clientX, sy = e.clientY
      let moved = false
      grabber.setPointerCapture(e.pointerId)
      const move = (ev) => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy
        if (!moved && Math.hypot(dx, dy) < 4) return
        if (!moved) { moved = true; dragging = true; document.documentElement.classList.add('dh-dragging') }
        moveTo(el, start.left + dx, start.top + dy)
      }
      const end = () => {
        grabber.removeEventListener('pointermove', move)
        grabber.removeEventListener('pointerup', end)
        grabber.removeEventListener('pointercancel', end)
        document.documentElement.classList.remove('dh-dragging')
        dragging = false
        if (moved) { remember(centre(el === ball ? ball : handle)); place() } else if (onClick) onClick()
      }
      grabber.addEventListener('pointermove', move)
      grabber.addEventListener('pointerup', end)
      grabber.addEventListener('pointercancel', end)
    })
  }

  // The grip and the bar's own background start a drag; a press on a switch stays a press on the switch
  draggable(h, h, { accepts: (t) => t === h || t === handle || grip.contains(t) })
  draggable(ball, ball, { onClick: () => setCollapsed(false) })
  const onKey = (v) => (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCollapsed(v, true) } }
  minBtn.addEventListener('click', () => setCollapsed(true))
  minBtn.addEventListener('keydown', onKey(true))
  ball.addEventListener('keydown', onKey(false))

  // Pages rebuild their bars with innerHTML, which drops the handle and changes the widths. Changes the dock
  // makes to the bar element itself (its style and class) are not content changes and are skipped.
  new MutationObserver((records) => {
    if (records.some((r) => r.type !== 'attributes' || r.target !== h)) place()
  }).observe(h, { childList: true, subtree: true, characterData: true, attributes: true })
  // Shown or hidden by the page, or re-wrapped as fonts load: re-fit on the next frame
  let queued = false
  const later = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; place() }) } }
  new ResizeObserver(later).observe(h)
  addEventListener('resize', later)
  place()
})()
