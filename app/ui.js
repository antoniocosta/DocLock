// Page plumbing shared by app.js: Element lookup, the status snackbar, the
// one-step-at-a-time screens, freezing controls while busy, password eyes.

/** Elements by id, looked up once: ui.editor, ui['doc-title']… */
export const ui = new Proxy({}, { get: (cache, id) => cache[id] ??= document.getElementById(id) });

/** Builds an element: h('button', { className: 'x', onclick }, 'text', child…). */
export function h(tag, props, ...children) {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children);
  return el;
}

/** An icon from index.html's symbols, e.g. icon('back'). */
export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

// ---------------------------------------------------------------- status snackbar
// No kind = in progress (spinner, stays until replaced); the rest time out,
// errors and warnings later. Hover pauses, × dismisses.

let statusTimer = null, statusLeft = 0, statusStart = 0;
const hideStatus = () => { clearTimeout(statusTimer); statusTimer = null; statusLeft = 0; ui.status.classList.remove('show'); };
function runStatusTimer(ms) {
  clearTimeout(statusTimer);
  [statusLeft, statusStart] = [ms, Date.now()];
  statusTimer = setTimeout(hideStatus, ms);
}
/** Shows a message; kind: undefined (busy), 'ok', 'warn' or 'error'; mark: An icon before it, e.g. 'lock'. */
export function setStatus(text, kind, mark) {
  hideStatus();
  if (!text) return;
  const sign = mark || { ok: 'success', warn: 'warning', error: 'error' }[kind]; // in progress: A spinner (style.css)
  ui['status-icon'].replaceChildren(...(sign ? [icon(sign)] : []));
  ui['status-text'].textContent = text;
  ui.status.className = `snackbar show ${{ error: 'err', ok: 'ok', warn: 'warn' }[kind] || 'busy'}`;
  const [base, perChar] = { ok: [3000, 40], warn: [6000, 50], error: [7000, 50] }[kind] || [];
  if (base) runStatusTimer(Math.min(12000, base + perChar * text.length));
}
ui['status-close'].onclick = hideStatus;
ui.status.onpointerenter = () => {
  if (!statusTimer) return;
  clearTimeout(statusTimer);
  statusTimer = null;
  statusLeft = Math.max(1500, statusLeft - (Date.now() - statusStart));
};
ui.status.onpointerleave = () => { if (statusLeft) runStatusTimer(statusLeft); };

/** The message for the user. DocLock's own errors carry a string code; anything else is a bug, and is logged. */
export function explain(e) {
  const ours = typeof e?.code === 'string'; // a DOMException has a numeric one
  if (!ours) console.error(e);
  return ours ? e.message : `Something went wrong: ${e?.message || e}`;
}
export const showError = (e, kind = 'error') => setStatus(explain(e), kind);

// ---------------------------------------------------------------- steps

const MENU = 101; // screens opened from the editor's menu: Past the editor, so leaving them slides back
const STEPS = { // section id: [progress %, field to focus]
  signin: [0, 'signin'], doc: [33, 'link'], title: [50, 'title'], newpass: [75, 'newpass'], password: [66, 'password'], editor: [100, 'editor'],
  decoy: [MENU, 'decoy-pass'], pass: [MENU, 'pass-new'],
};
export let current = null;
/** Registers a step built at run time (the setup guide): Its section is #step-<id>. */
export const addStep = (id, progress, focus) => { STEPS[id] = [progress, focus]; };

/** Shows one step: The old one slides out, the new one in; leftwards going on, rightwards going back. */
export function go(step) {
  const prev = current && current !== step ? ui[`step-${current}`] : null;
  document.body.classList.toggle('still', !prev); // the first screen just appears
  document.body.classList.toggle('back', !!prev && STEPS[step][0] < STEPS[current][0]); // progress % ranks the steps
  current = step;
  // setup steps: #1…#7. The editor's menu screens stay #editor: Browser history must not record a visit to the decoy.
  history.replaceState(history.state, '', `#${/^setup(\d)$/.exec(step)?.[1] ?? (STEPS[step][0] === MENU ? 'editor' : step)}`);
  ui.progress.firstChild.style.width = STEPS[step][0] + '%';
  ui.progress.hidden = STEPS[step][0] >= 100;
  const show = () => {
    for (const s in STEPS) { ui[`step-${s}`].classList.remove('leaving'); ui[`step-${s}`].hidden = s !== step; }
    ui[STEPS[step][1]].focus({ preventScroll: true });
  };
  if (prev && !prev.hidden && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    prev.classList.add('leaving');
    setTimeout(() => current === step && show(), 170); // just under step-out's 0.18s (style.css)
  } else show();
}

/**
 * Disables the buttons and fields in a container while fn runs; one task at a time.
 * Text areas stay live, so the editor keeps its cursor through a save.
 */
let busy = false;
export const isBusy = () => busy;

export async function whileBusy(container, fn) {
  if (busy) return;
  busy = true;
  const els = [...container.querySelectorAll('button, input')], was = els.map((e) => e.disabled);
  els.forEach((e) => { e.disabled = true; });
  container.classList.add('frozen');
  try { return await fn(); } finally {
    els.forEach((e, i) => { e.disabled = was[i]; });
    container.classList.remove('frozen');
    busy = false;
  }
}

/** The eye in a password field: Show or mask what was typed. Returns a setter. */
function reveal(button, inputs) {
  const set = (on) => {
    inputs.forEach((i) => { i.type = on ? 'text' : 'password'; });
    button.title = on ? 'Hide password' : 'Show password';
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-pressed', on);
    button.querySelector('use').setAttribute('href', on ? '#i-hide' : '#i-show');
  };
  button.onpointerdown = (ev) => ev.preventDefault(); // keep the caret in the field
  button.onclick = () => { set(inputs[0].type === 'password'); inputs[0].focus(); };
  return set;
}
const masks = [reveal(ui.reveal, [ui.password]), reveal(ui['reveal-new'], [ui.newpass, ui.newpass2, ui.newdecoy]),
  reveal(ui['reveal-decoy'], [ui['decoy-pass']]), reveal(ui['reveal-pass'], [ui['pass-new'], ui['pass-new2']])];
/** Clears and masks every password field, and what goes with them: The decoy's text, the “Add a decoy” box. */
export function clearPasswords() {
  for (const i of [ui.password, ui.newpass, ui.newpass2, ui.newdecoy, ui['decoy-pass'], ui['pass-new'], ui['pass-new2']]) i.value = '';
  ui['decoy-text'].value = '';
  ui['newdecoy-box'].hidden = true;
  ui['newdecoy-offer'].hidden = false;
  masks.forEach((set) => set(false));
}

