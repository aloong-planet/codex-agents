// The app's name and icon on the browser tab (copied from the prototype skill's template; do not edit by
// hand — change the skill template and copy it again). Scaffolding, not part of any design.
//
// Where it is included, and why every tab needs it: the prototype skill's SKILL.md, general rule 11. From
// window.PROTOTYPE_APP = { name, icon } in manifest.js it puts the app's name in front of the page's own
// title and sets the tab icon: the app icon — its path is relative to this file's directory — or, while the
// app has none, the name's initials: the first letter of a one-word name, else the first letters of its
// first two words, words being split at spaces, underscores and hyphens.
;(function () {
  const APP = window.PROTOTYPE_APP
  if (!APP || !APP.name) return
  const base = new URL('.', document.currentScript.src)

  const words = APP.name.split(/[\s_-]+/).filter(Boolean)
  const initials = (words.length > 1 ? words[0][0] + words[1][0] : words[0][0]).toUpperCase()
  const glyph = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1b1b1f"/>' +
    '<text x="32" y="33" text-anchor="middle" dominant-baseline="central" fill="#fff" font-family="-apple-system,Helvetica,Arial,sans-serif" ' +
    `font-weight="700" font-size="${initials.length > 1 ? 28 : 38}">${initials}</text></svg>`
  const icon = document.createElement('link')
  icon.rel = 'icon'
  icon.href = APP.icon ? new URL(APP.icon, base).href : `data:image/svg+xml,${encodeURIComponent(glyph)}`
  document.head.appendChild(icon)

  // After parsing, so the page's own <title> exists wherever this script sits in <head>
  const prefix = () => {
    if (!document.title.startsWith(`${APP.name} · `)) document.title = `${APP.name} · ${document.title}`
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', prefix)
  else prefix()
})()
