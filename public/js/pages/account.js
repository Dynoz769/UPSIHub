import { state, api, esc, icon, page, forms, actions, avatar, imageField, toast, fmtDate, hooks } from '../core.js';

function nextHash(query) {
  const next = query.get('next');
  return next && next.startsWith('/') && !next.startsWith('/login') ? `#${next}` : '#/';
}

page('/login', (_, query) => {
  if (state.me) { location.replace(nextHash(query)); return ''; }
  const mode = query.get('mode') === 'register' ? 'register' : 'login';
  const campuses = state.config.campuses;
  const nextQs = query.get('next') ? `&next=${encodeURIComponent(query.get('next'))}` : '';
  return `
    <div class="auth-wrap">
      <div class="card pad-lg xnarrow stack">
        <div class="center stack-sm">
          <span class="brand-mark" style="margin:0 auto;width:52px;height:52px;font-size:24px">U</span>
          <h1 style="font-size:24px;font-weight:850">${mode === 'login' ? 'Log masuk ke UPSIHub' : 'Cipta akaun UPSIHub'}</h1>
          <p class="small muted">${mode === 'login' ? 'Pesan, bayar & chat – semuanya dalam satu akaun.' : 'Percuma untuk semua pelajar & warga UPSI.'}</p>
        </div>
        <div class="seg">
          <label><input type="radio" ${mode === 'login' ? 'checked' : ''} data-act="authMode" data-href="#/login?mode=login${nextQs}">Log Masuk</label>
          <label><input type="radio" ${mode === 'register' ? 'checked' : ''} data-act="authMode" data-href="#/login?mode=register${nextQs}">Daftar</label>
        </div>
        ${mode === 'login' ? `
          <form data-form="login" class="stack" data-next="${esc(nextHash(query))}">
            <div class="field"><label>E-mel</label><input class="input" name="email" type="email" required autocomplete="email" placeholder="nama@siswa.upsi.edu.my"></div>
            <div class="field"><label>Kata laluan</label><input class="input" name="password" type="password" required autocomplete="current-password" minlength="8"></div>
            <button class="btn btn-primary btn-lg btn-block" type="submit">${icon('logout')} Log Masuk</button>
          </form>
          ${state.config.demo ? `
            <div class="demo-box stack-sm">
              <b>Akaun demo (kata laluan: <code>demo1234</code>)</b>
              <div class="row-wrap">
                <button class="btn btn-ghost btn-sm" data-act="demoLogin" data-email="pelajar@demo.upsi">pelajar@demo.upsi</button>
                <button class="btn btn-ghost btn-sm" data-act="demoLogin" data-email="nasilemak@demo.upsi">nasilemak@demo.upsi</button>
              </div>
              <span class="faint">Akaun admin dipaparkan di konsol pelayan semasa pertama kali dijalankan.</span>
            </div>` : ''}` : `
          <form data-form="register" class="stack" data-next="${esc(nextHash(query))}">
            <div class="field"><label>Nama penuh *</label><input class="input" name="name" required minlength="2" maxlength="80" autocomplete="name"></div>
            <div class="field"><label>E-mel *</label><input class="input" name="email" type="email" required autocomplete="email" placeholder="nama@siswa.upsi.edu.my"></div>
            <div class="grid-2">
              <div class="field"><label>No. matrik</label><input class="input" name="matric" maxlength="30" placeholder="D20231000001"></div>
              <div class="field"><label>No. telefon</label><input class="input" name="phone" type="tel" maxlength="20" placeholder="0123456789"></div>
            </div>
            <div class="field"><label>Kampus utama</label><select class="input" name="campus">${Object.entries(campuses).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></div>
            <div class="field"><label>Kata laluan * <span class="faint">(min 8 aksara)</span></label><input class="input" name="password" type="password" required minlength="8" autocomplete="new-password"></div>
            <button class="btn btn-primary btn-lg btn-block" type="submit">${icon('user')} Cipta Akaun</button>
            <p class="xs faint center">Dengan mendaftar, anda bersetuju untuk menggunakan platform ini secara beretika mengikut peraturan universiti.</p>
          </form>`}
      </div>
    </div>`;
});

async function afterAuth(form, user, welcome) {
  state.me = user;
  await hooks.loadMe();
  toast(welcome, 'success');
  location.hash = form.dataset.next || '#/';
}

forms.login = async (data, form) => {
  const { user } = await api('POST', '/api/auth/login', data);
  await afterAuth(form, user, `Selamat kembali, ${user.name.split(' ')[0]}!`);
};
forms.register = async (data, form) => {
  const { user } = await api('POST', '/api/auth/register', data);
  await afterAuth(form, user, 'Akaun berjaya dicipta. Selamat datang!');
};
actions.authMode = (el) => { location.hash = el.dataset.href; };
actions.demoLogin = async (el) => {
  const { user } = await api('POST', '/api/auth/login', { email: el.dataset.email, password: 'demo1234' });
  await afterAuth(el.closest('.card').querySelector('form'), user, `Log masuk sebagai ${user.name}`);
};

// =====================================================================
// PROFILE
// =====================================================================
page('/profile', () => {
  const u = state.me;
  const campuses = state.config.campuses;
  return `
    <div class="narrow stack-lg">
      <div class="page-head"><div><h1>Profil & Tetapan</h1><p>Ahli sejak ${fmtDate(u.created_at)}</p></div></div>
      <section class="card pad stack">
        <div class="row">${avatar(u, 'lg')}<div><div class="bold" style="font-size:18px">${esc(u.name)}</div><div class="small muted">${esc(u.email)}</div>${u.role === 'admin' ? '<span class="badge blue" style="margin-top:4px">Pentadbir</span>' : ''}</div></div>
        <form data-form="saveProfile" class="stack">
          ${imageField('avatar', u.avatar, 'Gambar profil')}
          <div class="grid-2">
            <div class="field"><label>Nama penuh</label><input class="input" name="name" required value="${esc(u.name)}" maxlength="80"></div>
            <div class="field"><label>No. matrik</label><input class="input" name="matric" value="${esc(u.matric || '')}" maxlength="30"></div>
            <div class="field"><label>No. telefon</label><input class="input" name="phone" value="${esc(u.phone || '')}" maxlength="20"></div>
            <div class="field"><label>Kampus utama</label><select class="input" name="campus">${Object.entries(campuses).map(([k, v]) => `<option value="${k}" ${u.campus === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
          </div>
          <div><button class="btn btn-primary" type="submit">${icon('check')} Simpan profil</button></div>
        </form>
      </section>
      <section class="card pad stack">
        <h2 class="section-title">${icon('lock')} Tukar kata laluan</h2>
        <form data-form="changePassword" class="stack">
          <div class="grid-2">
            <div class="field"><label>Kata laluan semasa</label><input class="input" type="password" name="current" required autocomplete="current-password"></div>
            <div class="field"><label>Kata laluan baharu</label><input class="input" type="password" name="next" required minlength="8" autocomplete="new-password"></div>
          </div>
          <div><button class="btn btn-ghost" type="submit">Kemas kini kata laluan</button></div>
        </form>
      </section>
      <section class="card pad between">
        <div><div class="bold">Perlukan bantuan?</div><div class="small muted">Chat terus dengan pasukan UPSIHub di dalam aplikasi.</div></div>
        ${u.role === 'admin' ? '' : `<button class="btn btn-ghost" data-act="openSupport">${icon('headset')} Hubungi sokongan</button>`}
      </section>
      <button class="btn btn-danger btn-lg" data-act="logout">${icon('logout')} Log keluar</button>
    </div>`;
}, { auth: true });

forms.saveProfile = async (data) => {
  const { user } = await api('PATCH', '/api/me', data);
  Object.assign(state.me, user);
  hooks.renderShell();
  toast('Profil dikemas kini.', 'success');
};
forms.changePassword = async (data, form) => {
  await api('POST', '/api/me/password', data);
  form.reset();
  toast('Kata laluan berjaya ditukar. Sesi lain telah dilog keluar.', 'success');
};
