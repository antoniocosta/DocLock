// The setup guide, shown by a copy of DocLock that has no Google client ID
// yet (no config.js). One action per screen, its link going straight to the
// right page of the Google Cloud console; the last screen makes config.js,
// to be uploaded next to index.html. Nothing else is kept, bar a one-time
// flag in sessionStorage.
// Any copy shows it with ?setup in the address (to preview it, or redo it).

import { ui, h, icon, go, addStep, setStatus } from './ui.js';

const CONSOLE = 'https://console.cloud.google.com';
const here = new URL('./', location.href); // this copy's folder
const origin = location.origin;
const redirect = new URL('oauth-callback.html', here).href;
const configUrl = new URL('config.js', here).href;
const CLIENT_ID = /^[\w-]+\.apps\.googleusercontent\.com$/;

const b = (t) => h('strong', {}, t);
const a = (href, t) => h('a', { href, target: '_blank', rel: 'noopener' }, `${t} ↗`);
const STEPS = [
  {
    title: 'Create a Google Cloud project',
    body: [a(`${CONSOLE}/projectcreate`, 'Create a project'), ' named ', b('DocLock'), '. It’s free: No billing account or card needed.'],
  },
  {
    title: 'Turn on the Google Docs and Drive APIs',
    body: [a(`${CONSOLE}/flows/enableapi?apiid=docs.googleapis.com,drive.googleapis.com`, 'Enable both APIs'), ' in the ', b('DocLock'), ' project: Check it’s selected at the top, then click ', b('Next'), ' and ', b('Enable'), '.'],
  },
  {
    title: 'Configure the sign-in screen',
    body: [a(`${CONSOLE}/auth/branding`, 'Open Branding'), ' and click ', b('Get started'), '. App name is ', b('DocLock'), ', enter your email, audience is ', b('External'), ', then click ', b('Create'), '.'],
  },
  {
    title: 'Allow your account to sign in',
    body: [a(`${CONSOLE}/auth/audience`, 'Open Audience'), ', click ', b('Add users'), ' under ', b('Test users'), ' and enter your own Google email. Only accounts on this list can use DocLock.'],
  },
  {
    title: 'Create the sign-in client',
    body: [a(`${CONSOLE}/auth/clients/create`, 'Create a client'), ' of type ', b('Web application'), ' with these two addresses. Then paste its Client ID below. Don’t copy the Client secret: DocLock doesn’t need it, and it must stay private.'],
    copies: [['Authorized JavaScript origins', origin], ['Authorized redirect URIs', redirect]],
    input: true,
  },
  {
    title: 'Download your config.js',
    body: [h('a', { href: '#', onclick: (ev) => { ev.preventDefault(); download(); } }, 'Download ↓'), ' your personal DocLock configuration file.'],
  },
  {
    title: 'Upload your config.js',
    body: ['Upload it to the DocLock folder, next to index.html. You should be able to open and see it at ', a(configUrl, configUrl.replace(/^https?:\/\//, '')), '.'],
    final: true,
  },
];
const n = STEPS.length;
let clientId = '';

function copyRow([label, value]) {
  return h('div', { className: 'copy' },
    h('span', { className: 'copy-label' }, label),
    h('div', { className: 'copy-row' },
      h('code', {}, value),
      h('button', { type: 'button', className: 'ghost', onclick: () => navigator.clipboard.writeText(value).then(
        () => setStatus('Copied.', 'ok'), () => setStatus('Can’t copy. Select the text and copy it.', 'error')) }, 'Copy')));
}

function download() {
  if (!CLIENT_ID.test(clientId)) return setStatus('Paste the Client ID in step 5 first.', 'error'); // never a secret or junk in a public file
  const file = `// DocLock configuration, made by its setup guide.\nexport const CLIENT_ID = '${clientId}';\n`;
  const link = h('a', { href: URL.createObjectURL(new Blob([file], { type: 'text/javascript' })), download: 'config.js' });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}

const DONE = 'doclock.setup.done'; // sessionStorage: Shows "You're all set!" after the reload

/** Is config.js there and right? Then reload as a normal copy; else say what's wrong and where to fix it. */
async function check() {
  setStatus('Checking…');
  let res, text;
  try {
    res = await fetch(configUrl, { cache: 'no-store' });
    text = await res.text();
  } catch {
    return fail('Can’t reach your server', ['Check your connection, then try again.'], 'Back to upload', `setup${n}`);
  }
  const id = text.match(/CLIENT_ID\s*=\s*['"]([^'"]*)/)?.[1];
  if (!res.ok) {
    return fail('config.js isn’t there yet', [`Nothing opens at its address (error ${res.status}). Upload config.js to the DocLock folder, next to index.html.`], 'Back to upload', `setup${n}`);
  }
  if (id == null) {
    return fail('That’s not your config.js', ['Something else opens at its address. Upload the config.js you downloaded, next to index.html.'], 'Back to upload', `setup${n}`);
  }
  if (!CLIENT_ID.test(id)) {
    return fail('The Client ID is wrong', ['The one in config.js doesn’t end in .apps.googleusercontent.com. Paste it again, then download and upload a new config.js.'], 'Fix the Client ID', `setup${STEPS.findIndex((x) => x.input) + 1}`);
  }
  try { sessionStorage.setItem(DONE, '1'); } catch { /* the message is a nicety */ }
  location.replace(here.href);
}

/** The last screen when something is wrong: What, and one button to the step that fixes it. */
function fail(title, body, label, step) {
  setStatus('');
  ui['setupfail-title'].textContent = title;
  ui['setupfail-body'].replaceChildren(...body);
  ui['setupfail-go'].textContent = label;
  ui['setupfail-go'].onclick = () => go(step);
  go('setupfail');
}

/** True once, right after the guide's last step reloaded the page. */
export function setupJustFinished() {
  try {
    if (!sessionStorage.getItem(DONE)) return false;
    sessionStorage.removeItem(DONE);
    return true;
  } catch { return false; }
}

function build(s, i) {
  const id = `setup${i + 1}`, next = i + 1 < n ? `setup${i + 2}` : null;
  const nextBtn = h('button', { type: 'submit', id: `${id}-next` }, 'Done');
  const form = h('form', { autocomplete: 'off', noValidate: true },
    h('button', { type: 'button', className: 'back', id: `back-${id}`, ariaLabel: 'Back', title: 'Back', onclick: () => { setStatus(''); go(i ? `setup${i}` : 'signin'); } }, icon('back')),
    h('p', { className: 'kicker' }, `Setup · step ${i + 1} of ${n}`),
    h('h2', { className: 'q' }, s.title),
    h('p', { className: 'desc' }, ...s.body),
    ...(s.copies || []).map(copyRow),
    ...(s.input ? [h('label', { htmlFor: 'client-id', className: 'copy-label' }, 'Client ID'), h('input', { id: 'client-id', className: 'answer', type: 'text', spellcheck: false, placeholder: '1234-abc.apps.googleusercontent.com' })] : []),
    h('div', { className: 'actions' },
      nextBtn));
  form.onsubmit = (ev) => {
    ev.preventDefault();
    if (s.final) return check();
    if (s.input) {
      clientId = ui['client-id'].value.trim();
      if (/^GOCSPX-/i.test(clientId)) { // the Client secret: Never keep it, not even in the field
        clientId = ui['client-id'].value = '';
        setStatus('That’s the Client secret. Keep it private and paste the Client ID instead.', 'error');
        return ui['client-id'].focus();
      }
      if (!CLIENT_ID.test(clientId)) { setStatus('That’s not a Client ID. It ends in .apps.googleusercontent.com.', 'error'); ui['client-id'].select(); return; }
    }
    setStatus('');
    go(next);
  };
  document.querySelector('main').append(h('section', { id: `step-${id}`, className: 'step', hidden: true }, form));
  addStep(id, Math.round(((i + 1) / n) * 100), s.input ? 'client-id' : `${id}-next`);
}

function buildFail() {
  document.querySelector('main').append(h('section', { id: 'step-setupfail', className: 'step', hidden: true },
    h('div', {},
      h('button', { type: 'button', className: 'back', id: 'back-setupfail', ariaLabel: 'Back', title: 'Back', onclick: () => go(`setup${n}`) }, icon('back')),
      h('p', { className: 'kicker' }, 'Setup · not done yet'),
      h('h2', { className: 'q', id: 'setupfail-title' }),
      h('p', { className: 'desc', id: 'setupfail-body' }),
      h('div', { className: 'actions' }, h('button', { type: 'button', id: 'setupfail-go' })))));
  addStep('setupfail', 100, 'setupfail-go');
}

let built = false;
/** Opens the guide at its first step, or at step k when given ('3' or 'setup3'), as in ?setup#3. */
export function startSetup(step) {
  if (!built) { STEPS.forEach(build); buildFail(); built = true; }
  setStatus('');
  const k = Number(/^(?:setup)?([1-9])$/.exec(step || '')?.[1]);
  go(`setup${k && k <= n ? k : 1}`);
}

/** A short burst of confetti over the page, for the end of the setup (skipped with reduced motion). */
export function confetti() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = h('canvas', { className: 'confetti', ariaHidden: 'true' });
  document.body.append(canvas);
  const ctx = canvas.getContext('2d'), dpr = devicePixelRatio || 1;
  const W = (canvas.width = innerWidth * dpr), H = (canvas.height = innerHeight * dpr);
  const S = 0.5, T = 6400; // half speed (same paths, twice as long); total ms
  const colours = ['#3186ff', '#76bbff', '#a9a8ff', '#1d6b32', '#f3cf7a', '#e05a5a'];
  const bits = Array.from({ length: 160 }, () => ({
    x: W / 2 + (Math.random() - 0.5) * W * 0.2, y: H * 0.35,
    vx: (Math.random() - 0.5) * 22 * dpr * S, vy: (-Math.random() * 18 - 6) * dpr * S,
    w: (6 + Math.random() * 6) * dpr, h: (3 + Math.random() * 4) * dpr,
    a: Math.random() * Math.PI, va: (Math.random() - 0.5) * 0.4 * S, c: colours[Math.floor(Math.random() * colours.length)],
  }));
  const start = performance.now();
  (function frame(now) {
    const t = now - start;
    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = Math.max(0, Math.min(1, (T - t) / 1600)); // fades out over the last 1.6 s
    for (const p of bits) {
      p.vy += 0.5 * dpr * S * S; p.vx *= 0.985 ** S; p.vy *= 0.985 ** S;
      p.x += p.vx; p.y += p.vy; p.a += p.va;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a);
      ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.a * 2)));
      ctx.restore();
    }
    if (t < T) requestAnimationFrame(frame); else canvas.remove();
  })(start);
}
