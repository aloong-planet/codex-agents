// Demo harness dock (copied from the prototype skill's template; do not edit by hand — change the skill
// template and copy it again). Scaffolding, not part of any design.
//
// Include it once per prototype page, after the element marked data-demo-harness:
//   <script src="../demo-harness.js"></script>
//
// The page fills the bar with the markup below and leaves its whole look to this script (the prototype
// skill's UI.md, harness clause 1, says what the page may not add), so every bar looks the same and a
// reader recognises a title, an option and an action on any page.
//   <div data-demo-harness>
//     <span class="dh-tag">Demo ·</span>                     the fixed prefix, in the project's working language
//     <div class="dh-group">                                 one card per group of mock-state switches
//       <span class="dh-title">List state</span>             the group's title, a raised key on the card's left
//       <div class="dh-opts">
//         <button type="button" class="dh-opt" aria-pressed="true">Loading</button>
//         <button type="button" class="dh-opt" aria-pressed="false">Empty</button>
//       </div>
//     </div>
//     <div class="dh-group dh-actions">                      one-shot triggers, not a choice: dashed card
//       <span class="dh-title">Actions</span>
//       <div class="dh-acts"><button type="button" class="dh-act">Quit and reopen</button></div>
//     </div>
//     <p class="dh-note">App: set by the first load of the notes; no such control.</p>
//   </div>
// · Every option is a button in the row, never a drop-down: a closed drop-down shows its current value
//   only, so neither the other values nor which one is selected can be seen. The page sets aria-pressed
//   on the selected option of each group; a group whose options do not fit on one line is split in two.
// · A group that applies to one context only is hidden with the hidden attribute outside it.
// · The page's own script may find the bar's parts by id or data-* attributes; those carry no look.
// · Build the bar once and update aria-pressed and hidden in place: rebuilding it on every change moves
//   keyboard focus away and drops the flash an action shows when pressed.
//
// On top of that look, the script changes how the bar sits on screen:
//   · the bar is exactly as wide as its widest row (a wrapped flex box otherwise keeps the full width
//     it was offered, leaving wide empty margins either side of the rows); a note wraps at 420px, so a
//     long note does not stretch the bar across the page and over the design;
//   · its rows wrap at three quarters of the viewport's width (or at its widest single group, when that is
//     wider), so a bar of many groups does not span the viewport: centred, it leaves both bottom corners
//     clear, where app windows keep edge controls such as a side rail's last items;
//   · its grip, or any bare background around and between the rows, drags it anywhere; a button
//     collapses it into a small ball that drags the same way, and clicking the ball expands it again;
//   · bar and ball are kept wholly inside the viewport, while dragging and after every resize;
//   · the position and the collapsed state carry over between prototype pages and reloads;
//   · a pressed action flashes the selected look for 0.2s and fades back in 0.1s, so the reader sees it
//     fired without it staying selected.
(() => {
  const h = document.querySelector('[data-demo-harness]')
  if (!h) return
  // The look is scoped to the bar this script docks: other elements marked data-demo-harness (the note
  // demo-dimensions.js adds, say) keep their own
  h.classList.add('dh-bar')

  const GAP = 8        // the minimum distance kept between the dock and each viewport edge
  const NOTE = 420     // the widest a note's lines may make the bar; a longer note wraps
  const ROWS = 0.75    // the share of the viewport's width the bar's rows may take; more groups wrap
  const BALL = 32
  const KEY = 'proto-demo-harness'
  const svg = (box, body) => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='${box}'>${body}</svg>`)}")`
  const PLAY = svg('0 0 9 10', "<path d='M1 1.2v7.6a.6.6 0 0 0 .9.5l6.2-3.8a.6.6 0 0 0 0-1L1.9.7A.6.6 0 0 0 1 1.2z'/>")
  const INFO = svg('0 0 12 12', "<g fill='none' stroke='black'><circle cx='6' cy='6' r='5.25' stroke-width='1.1'/>" +
    "<path d='M6 5.3v3' stroke-width='1.2' stroke-linecap='round'/></g><circle cx='6' cy='3.6' r='.7'/>")

  // The bar is centred with both side offsets and auto margins, not a translate: a fixed box given only a
  // left offset can use the width from there to the viewport's right edge, and a translate moves it back
  // to the centre without giving it that width back, so a long bar wraps in half the viewport. Spacing
  // inside the bar is padding and gaps, never the children's margins: a box sized to its content leaves
  // those margins out when it measures, then wraps what no longer fits.
  // The selected option sits inside the card's border and the title covers it, so the title is the card's
  // full height and nothing after it looks taller.
  // Everything inside the bar takes its margin, padding and font from the rules here and from the bar: a
  // prototype page keeps its * rules on * rather than on the app window's box, and they would otherwise
  // reach in.
  document.head.insertAdjacentHTML('beforeend', `<style>
    [data-demo-harness].dh-bar{position:fixed;left:0;right:0;bottom:16px;margin:0 auto;width:max-content;
      max-width:calc(100vw - ${2 * GAP}px);z-index:50;box-sizing:border-box;display:flex;flex-wrap:wrap;align-items:center;
      gap:6px;padding:6px 8px;border:1px solid rgba(255,255,255,.18);border-radius:16px;background:#1c1c1e;
      color:#e8e8ea;box-shadow:0 8px 24px rgba(0,0,0,.35);text-align:left;letter-spacing:normal;text-transform:none;
      font:400 12px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
    .dh-bar *,.dh-bar *::before,.dh-bar *::after{box-sizing:border-box}
    .dh-bar *{margin:0;padding:0;font:inherit;letter-spacing:inherit;text-transform:inherit}
    .dh-bar[hidden],.dh-bar [hidden]{display:none !important}
    .dh-bar .dh-tag{flex:none;margin:0;padding:3px 8px;border-radius:7px;background:rgba(255,255,255,.1);
      color:#c7c7cc;font-size:11px;font-weight:700;white-space:nowrap}
    .dh-bar .dh-group{flex:none;display:flex;align-items:center;margin:0;padding:0;border:1px solid rgba(255,255,255,.06);
      border-radius:10px;background:#2c2c2e;white-space:nowrap}
    .dh-bar .dh-group.dh-actions{background:transparent;border:1px dashed rgba(255,255,255,.22)}
    .dh-bar .dh-title{flex:none;align-self:stretch;display:flex;align-items:center;position:relative;z-index:1;
      margin:-1px 0 -1px -1px;padding:0 10px;border-radius:10px 0 0 10px;color:#fff;font-size:12px;font-weight:700;
      cursor:default;background:linear-gradient(180deg,#5e5e62,#444448);
      box-shadow:inset 0 1px 0 rgba(255,255,255,.22),inset -1px 0 0 rgba(0,0,0,.5),2px 0 5px rgba(0,0,0,.4)}
    .dh-bar .dh-opts,.dh-bar .dh-acts{display:flex;align-self:stretch;gap:0;margin:0;padding:0}
    .dh-bar .dh-opt,.dh-bar .dh-act{display:flex;align-items:center;gap:5px;margin:0;padding:7px 11px;border:0;
      border-radius:0;background:none;box-shadow:none;color:#d1d1d6;font:inherit;font-size:11.5px;font-weight:400;
      line-height:1.4;letter-spacing:normal;text-transform:none;white-space:nowrap;cursor:pointer}
    .dh-bar .dh-opts > :last-child,.dh-bar .dh-acts > :last-child{border-radius:0 9px 9px 0}
    .dh-bar .dh-opt:hover,.dh-bar .dh-act:hover{background:rgba(255,255,255,.08);color:#fff}
    .dh-bar .dh-opt:focus-visible,.dh-bar .dh-act:focus-visible{outline:2px solid #6cb8ff;outline-offset:-2px}
    .dh-bar .dh-opt[aria-pressed="true"]{background:#141416;color:#5ab8ff;font-weight:600;
      box-shadow:inset 0 1px 3px rgba(0,0,0,.75)}
    .dh-bar .dh-act{position:relative;transition:background-color .1s ease,color .1s ease,box-shadow .1s ease}
    .dh-bar .dh-act + .dh-act::before{content:"";position:absolute;left:0;top:0;bottom:0;width:1px;
      background:rgba(255,255,255,.16)}
    .dh-bar .dh-act::after{content:"";order:-1;flex:none;width:9px;height:10px;background:currentColor;
      -webkit-mask:${PLAY} center/contain no-repeat;mask:${PLAY} center/contain no-repeat}
    .dh-bar .dh-act:active{background:rgba(255,255,255,.16)}
    .dh-bar .dh-act.dh-fired{transition:none;background:#141416;color:#5ab8ff;box-shadow:inset 0 1px 3px rgba(0,0,0,.75)}
    .dh-bar .dh-note{flex:1 0 100%;display:flex;align-items:flex-start;gap:6px;margin:0;padding:2px 6px 1px;
      color:#8e8e93;font-size:11px;font-weight:400;white-space:normal}
    .dh-bar .dh-note::before{content:"";flex:none;width:12px;height:12px;margin-top:2px;background:currentColor;
      -webkit-mask:${INFO} center/contain no-repeat;mask:${INFO} center/contain no-repeat}
    [data-demo-harness] > .dh-handle{display:inline-flex;align-items:center;gap:2px;flex:none;
      color:rgba(255,255,255,.5)}
    .dh-handle > span{display:grid;place-items:center;height:22px;border-radius:6px;color:inherit}
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

  // Spans rather than buttons: pages written before the bar's look moved into this script style every
  // "[data-demo-harness] button" as one of their pills
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
        if (n.classList.contains('dh-note')) {
          // The note takes a whole row whatever its length, so only its text lines count, and only up to
          // NOTE px from the note's left edge: past that the note wraps rather than widen the bar
          const range = document.createRange()
          range.selectNodeContents(n)
          const pad = parseFloat(cs.paddingRight) + parseFloat(cs.borderRightWidth)
          const most = n.getBoundingClientRect().left + NOTE
          boxes = [...range.getClientRects()].map((b) => ({ left: b.left, right: Math.min(b.right + pad, most) }))
        } else {
          const b = n.getBoundingClientRect()
          if (b.width || b.height) boxes = [{ left: b.left - parseFloat(cs.marginLeft), right: b.right + parseFloat(cs.marginRight) }]
        }
      } else if (n.nodeType === 3 && n.data.trim()) {
        const range = document.createRange()
        range.selectNodeContents(n)
        boxes = [...range.getClientRects()]
      }
      for (const b of boxes) { l = Math.min(l, b.left); r = Math.max(r, b.right) }
    }
    return r > l ? r - l : 0
  }

  /** The widest of the bar's items that cannot wrap (every child but the notes), margin box included */
  function widestItem() {
    let w = 0
    for (const n of h.children) {
      const cs = getComputedStyle(n)
      if (n.classList.contains('dh-note') || cs.display === 'none' || cs.position === 'absolute' || cs.position === 'fixed') continue
      w = Math.max(w, n.getBoundingClientRect().width + parseFloat(cs.marginLeft) + parseFloat(cs.marginRight))
    }
    return w
  }

  /**
   * Wraps the bar's rows at ROWS of the viewport (never narrower than its widest item), then shrinks the
   * bar to its widest row, counting a note as at most NOTE px wide. Shrinking to that width moves no line
   * break but the note's: every other row still fits, and the first item of each next row did not fit
   * even in the wider box. Returns false while the page itself hides the bar (a context the switches do
   * not apply to).
   */
  function fitWidth() {
    const cs = getComputedStyle(h)
    if (cs.display === 'none') return false
    const frame = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce((s, k) => s + parseFloat(cs[k]), 0)
    const toProp = cs.boxSizing === 'border-box' ? 0 : -frame   // a border-box width → the width property
    h.style.setProperty('width', 'max-content', 'important')
    const natural = h.getBoundingClientRect().width
    if (!natural) return false
    const cap = Math.min(vw() - 2 * GAP, Math.max(vw() * ROWS, widestItem() + frame))
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

  // A pressed action flashes the selected look, then fades back (the fade is the transition in the style)
  h.addEventListener('click', (e) => {
    const a = e.target.closest('.dh-act')
    if (!a || !h.contains(a)) return
    clearTimeout(a.dhFlash)
    a.classList.add('dh-fired')
    a.dhFlash = setTimeout(() => a.classList.remove('dh-fired'), 200)
  })

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
