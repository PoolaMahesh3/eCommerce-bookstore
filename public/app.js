'use strict';

const $ = (id) => document.getElementById(id);
const view = $('view');
const state = { token: sessionStorage.getItem('token'), user: null };

// ---- helpers (DOM is built with textContent only: no innerHTML, so API data cannot inject markup) ----
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}
const money = (c) => `$${(c / 100).toFixed(2)}`;
const clear = (el) => el.replaceChildren();

function notice(msg, isError) {
  const n = $('notice');
  n.textContent = msg;
  n.className = isError ? 'error' : '';
  n.hidden = !msg;
}

async function api(method, path, body, headers) {
  const h = { ...(headers || {}) };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (state.token) h.Authorization = `Bearer ${state.token}`;
  const res = await fetch(`/v1${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && state.token) signOut(true);
    throw new Error(data.message || `Request failed (${res.status})`);
  }
  return data;
}

function guard(fn) {
  return async (...args) => {
    try {
      notice('');
      await fn(...args);
    } catch (e) {
      notice(e.message, true);
    }
  };
}

// ---- account ----
function signOut(expired) {
  state.token = null;
  state.user = null;
  sessionStorage.removeItem('token');
  renderAccount();
  if (expired) notice('Session expired. Please sign in again.', true);
  location.hash = '#/login';
}

function renderAccount() {
  const box = $('account');
  clear(box);
  if (state.user) {
    box.append(h('span', { class: 'muted' }, `${state.user.name} `), h('button', { class: 'secondary', onclick: () => signOut(false) }, 'Sign out'));
    box.append(' ', h('a', { href: '#/orders' }, 'Orders'));
  } else {
    box.append(h('a', { href: '#/login' }, 'Sign in'));
  }
}

async function loadUser() {
  if (!state.token) return;
  try {
    state.user = await api('GET', '/me');
  } catch {
    state.token = null;
    sessionStorage.removeItem('token');
  }
}

async function login(email, password) {
  const r = await api('POST', '/auth/login', { email, password });
  state.token = r.accessToken;
  sessionStorage.setItem('token', r.accessToken);
  await loadUser();
  renderAccount();
}

// ---- pages ----
async function pageBrowse(params) {
  clear(view);
  const q = Object.fromEntries(params);
  const search = h('input', { type: 'search', placeholder: 'Search title, author, description', value: q.query || '', maxlength: '200' });
  const category = h('input', { type: 'text', placeholder: 'Category', value: q.category || '', maxlength: '100' });
  const format = h('select', {}, h('option', { value: '' }, 'Any format'), ...['hardcover', 'paperback', 'ebook', 'audiobook'].map((f) => h('option', { value: f, selected: q.format === f }, f)));
  const sort = h('select', {}, ...[['', 'Default'], ['title', 'Title'], ['price_asc', 'Price: low to high'], ['price_desc', 'Price: high to low'], ['newest', 'Newest']].map(([v, l]) => h('option', { value: v, selected: (q.sort || '') === v }, l)));
  const go = () => {
    const p = new URLSearchParams();
    if (search.value.trim()) p.set('query', search.value.trim());
    if (category.value.trim()) p.set('category', category.value.trim());
    if (format.value) p.set('format', format.value);
    if (sort.value) p.set('sort', sort.value);
    location.hash = `#/?${p}`;
  };
  search.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  const grid = h('div', { class: 'grid' });
  view.append(h('h1', {}, 'Browse books'), h('div', { class: 'toolbar' }, search, category, format, sort, h('button', { onclick: go }, 'Search')), grid);

  const data = await api('GET', `/books?${new URLSearchParams({ ...q, limit: '24' })}`);
  if (data.items.length === 0) grid.replaceWith(h('p', { class: 'muted' }, 'No books found.'));
  for (const b of data.items) {
    grid.append(
      h('div', { class: 'card' },
        h('h3', {}, h('a', { href: `#/book/${b.id}` }, b.title)),
        h('div', { class: 'muted' }, b.author),
        h('div', { class: 'muted' }, `${b.category}${b.avg_rating ? ` · ${b.avg_rating}/5` : ''}`),
        h('div', {}, `from ${money(b.min_price)}`)),
    );
  }
  if (data.nextCursor) {
    const next = new URLSearchParams(q);
    next.set('cursor', data.nextCursor);
    view.append(h('p', {}, h('a', { href: `#/?${next}` }, 'Next page')));
  }
}

async function pageBook(id) {
  clear(view);
  const [b, rv, also] = await Promise.all([api('GET', `/books/${id}`), api('GET', `/books/${id}/reviews`).catch(() => null), api('GET', `/books/${id}/also-bought`).catch(() => null)]);
  const rows = b.editions.map((e) =>
    h('tr', {},
      h('td', {}, e.format),
      h('td', {}, e.isbn13),
      h('td', { class: 'num' }, money(e.price_cents)),
      h('td', {}, e.in_stock ? 'In stock' : 'Out of stock'),
      h('td', {}, h('button', { disabled: !e.in_stock, onclick: guard(async () => {
        if (!state.user) { location.hash = '#/login'; return; }
        await api('PUT', `/cart/items/${e.id}`, { qty: 1 });
        notice(`Added "${b.title}" (${e.format}) to cart.`);
      }) }, 'Add to cart'))),
  );
  view.append(
    h('p', {}, h('a', { href: '#/' }, '← Back')),
    h('h1', {}, b.title),
    h('p', { class: 'muted' }, `${b.author} · ${b.category}${b.avg_rating ? ` · ${b.avg_rating}/5 (${b.review_count})` : ''}`),
    h('p', {}, b.description),
    h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Format'), h('th', {}, 'ISBN-13'), h('th', { class: 'num' }, 'Price'), h('th', {}, 'Stock'), h('th', {}))), h('tbody', {}, rows)),
  );
  const items = rv && rv.items;
  if (items && items.length) {
    view.append(h('h2', {}, 'Reviews'), ...items.map((r) => h('div', { class: 'panel' }, h('strong', {}, `${r.rating}/5`), ` by ${r.author}`, h('div', {}, r.body))));
  }
  const rec = also && also.items;
  if (rec && rec.length) {
    view.append(h('h2', {}, 'Customers also bought'), h('div', { class: 'grid' }, rec.map((x) => h('div', { class: 'card' }, h('a', { href: `#/book/${x.id}` }, x.title)))));
  }
}

function pageLogin() {
  clear(view);
  const email = h('input', { type: 'email', required: true, autocomplete: 'username' });
  const pw = h('input', { type: 'password', required: true, minlength: '12', autocomplete: 'current-password' });
  const name = h('input', { type: 'text', maxlength: '100', autocomplete: 'name' });
  const signIn = guard(async () => { await login(email.value, pw.value); location.hash = '#/'; });
  const register = guard(async () => {
    if (!name.value.trim()) throw new Error('Enter your name to register.');
    await api('POST', '/auth/register', { email: email.value, name: name.value.trim(), password: pw.value });
    await login(email.value, pw.value);
    location.hash = '#/';
  });
  view.append(
    h('h1', {}, 'Sign in or register'),
    h('div', { class: 'panel' },
      h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); signIn(); } },
        h('label', {}, 'Email', email),
        h('label', {}, 'Password (min 12 characters)', pw),
        h('label', {}, 'Name (only needed to register)', name),
        h('div', { class: 'row' }, h('button', { type: 'submit' }, 'Sign in'), h('button', { type: 'button', class: 'secondary', onclick: register }, 'Register')))),
  );
}

async function pageCart() {
  clear(view);
  if (!state.user) { location.hash = '#/login'; return; }
  const coupon = h('input', { type: 'text', placeholder: 'Coupon code', maxlength: '40' });
  const draw = async () => {
    const code = coupon.value.trim() || undefined;
    const q = await api('GET', `/cart${code ? `?coupon=${encodeURIComponent(code)}` : ''}`);
    clear(view);
    view.append(h('h1', {}, 'Your cart'));
    if (q.lines.length === 0) { view.append(h('p', { class: 'muted' }, 'Your cart is empty.')); return; }
    view.append(h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Title'), h('th', {}, 'Format'), h('th', { class: 'num' }, 'Price'), h('th', { class: 'num' }, 'Qty'), h('th', { class: 'num' }, 'Total'), h('th', {}))),
      h('tbody', {}, q.lines.map((l) => h('tr', {},
        h('td', {}, h('a', { href: `#/book/${l.bookId}` }, l.title)),
        h('td', {}, l.format),
        h('td', { class: 'num' }, money(l.unitPriceCents)),
        h('td', { class: 'num' }, String(l.qty)),
        h('td', { class: 'num' }, money(l.lineCents)),
        h('td', {}, h('button', { class: 'secondary', onclick: guard(async () => { await api('DELETE', `/cart/items/${l.editionId}`); await draw(); }) }, 'Remove')))))));
    view.append(
      h('div', { class: 'toolbar' }, coupon, h('button', { class: 'secondary', onclick: guard(draw) }, 'Apply coupon')),
      h('div', { class: 'totals' },
        h('div', {}, `Subtotal: ${money(q.subtotalCents)}`),
        q.discountCents ? h('div', {}, `Discount (${q.couponCode}): -${money(q.discountCents)}`) : null,
        h('strong', {}, `Total: ${money(q.totalCents)}`)));

    const needsShipping = q.lines.some((l) => l.format === 'hardcover' || l.format === 'paperback');
    const f = {};
    const field = (key, label, req, attrs) => (f[key] = h('input', { type: 'text', required: req, maxlength: '200', ...attrs }), h('label', {}, label, f[key]));
    const key = crypto.randomUUID();
    const checkout = guard(async () => {
      const body = {};
      if (code) body.couponCode = code;
      if (needsShipping) {
        body.shippingAddress = { name: f.name.value, line1: f.line1.value, city: f.city.value, postalCode: f.postalCode.value, country: f.country.value.toUpperCase() };
        if (f.line2.value) body.shippingAddress.line2 = f.line2.value;
        if (f.region.value) body.shippingAddress.region = f.region.value;
      }
      const order = await api('POST', '/checkout', body, { 'Idempotency-Key': key });
      location.hash = `#/orders/${order.id}`;
    });
    view.append(h('div', { class: 'panel' }, h('h2', {}, 'Checkout'),
      h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); checkout(); } },
        needsShipping ? [field('name', 'Full name', true), field('line1', 'Address line 1', true), field('line2', 'Address line 2', false), field('city', 'City', true), field('region', 'State / region', false), field('postalCode', 'Postal code', true, { maxlength: '20' }), field('country', 'Country (2-letter code, e.g. US)', true, { maxlength: '2', minlength: '2' })] : h('p', { class: 'muted' }, 'Digital items only: no shipping address needed.'),
        h('button', { type: 'submit' }, 'Place order'))));
  };
  await draw();
}

async function pageOrders() {
  clear(view);
  if (!state.user) { location.hash = '#/login'; return; }
  const data = await api('GET', '/orders');
  view.append(h('h1', {}, 'Your orders'));
  if (data.items.length === 0) { view.append(h('p', { class: 'muted' }, 'No orders yet.')); return; }
  view.append(h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Placed'), h('th', {}, 'Status'), h('th', { class: 'num' }, 'Total'), h('th', {}))),
    h('tbody', {}, data.items.map((o) => h('tr', {}, h('td', {}, new Date(o.createdAt).toLocaleString()), h('td', {}, o.status), h('td', { class: 'num' }, money(o.totalCents)), h('td', {}, h('a', { href: `#/orders/${o.id}` }, 'View')))))));
}

async function pageOrder(id) {
  clear(view);
  if (!state.user) { location.hash = '#/login'; return; }
  const o = await api('GET', `/orders/${encodeURIComponent(id)}`);
  view.append(
    h('p', {}, h('a', { href: '#/orders' }, '← All orders')),
    h('h1', {}, `Order ${o.id.slice(0, 8)}`),
    h('p', {}, `Status: `, h('strong', {}, o.status), o.payment ? ` · Payment: ${o.payment.status}` : ''),
    h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Title'), h('th', {}, 'Format'), h('th', { class: 'num' }, 'Price'), h('th', { class: 'num' }, 'Qty'))),
      h('tbody', {}, o.items.map((i) => h('tr', {}, h('td', {}, i.title), h('td', {}, i.format), h('td', { class: 'num' }, money(i.unitPriceCents)), h('td', { class: 'num' }, String(i.qty)))))),
    h('div', { class: 'totals' }, h('strong', {}, `Total: ${money(o.totalCents)}`)),
  );
  if (o.shipment) view.append(h('p', {}, `Shipment: ${o.shipment.status}${o.shipment.trackingNumber ? ` (${o.shipment.trackingNumber})` : ''}`));
  if (o.status === 'PENDING') {
    view.append(h('button', { class: 'secondary', onclick: guard(async () => { await api('POST', `/orders/${encodeURIComponent(id)}/cancel`); await pageOrder(id); }) }, 'Cancel order'));
  }
}

// ---- router ----
async function route() {
  notice('');
  const [path, query] = location.hash.slice(1).split('?');
  const params = new URLSearchParams(query || '');
  const parts = (path || '/').split('/').filter(Boolean);
  try {
    if (parts.length === 0) await pageBrowse(params);
    else if (parts[0] === 'book' && parts[1]) await pageBook(encodeURIComponent(parts[1]));
    else if (parts[0] === 'login') pageLogin();
    else if (parts[0] === 'cart') await pageCart();
    else if (parts[0] === 'orders' && parts[1]) await pageOrder(parts[1]);
    else if (parts[0] === 'orders') await pageOrders();
    else await pageBrowse(params);
  } catch (e) {
    notice(e.message, true);
  }
}

window.addEventListener('hashchange', route);
loadUser().then(() => { renderAccount(); route(); });
