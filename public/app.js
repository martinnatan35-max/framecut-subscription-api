
const API_BASE = 'https://framecut-subscription-api.onrender.com';
const $ = (id) => document.getElementById(id);

$('year').textContent = new Date().getFullYear();

async function api(path, body) {
  const options = {
    method: body !== undefined ? 'POST' : 'GET',
    credentials: 'include',
    headers: {}
  };

  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const res = await fetch(`${API_BASE}${path}`, options);
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }

  return data;
}

function showMessage(id, text, bad = false) {
  $(id).textContent = text;
  $(id).style.color = bad ? '#ff9b9b' : 'var(--accent)';
}

function showDashboard(data) {
  $('dashboard').classList.remove('hidden');
  $('accountInfo').textContent = `Signed in as ${data.user.email}`;

  const s = data.subscription;
  $('subscriptionInfo').textContent = s
    ? `Subscription: ${s.plan} · Status: ${s.status}${s.current_period_end ? ' · Through ' + s.current_period_end : ''}`
    : 'No subscription is active yet.';

  $('registerForm').classList.add('hidden');
  $('loginForm').classList.add('hidden');
}

function showAuthForms() {
  $('dashboard').classList.add('hidden');
  $('registerForm').classList.remove('hidden');
  $('loginForm').classList.remove('hidden');
}

$('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  showMessage('registerMsg', 'Creating account…');

  try {
    const data = await api('/api/auth/register', {
      email: $('regEmail').value.trim(),
      password: $('regPassword').value
    });
    showDashboard(data);
    showMessage('registerMsg', 'Account created successfully.');
  } catch (err) {
    showMessage('registerMsg', err.message, true);
  }
});

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  showMessage('loginMsg', 'Signing in…');

  try {
    const data = await api('/api/auth/login', {
      email: $('loginEmail').value.trim(),
      password: $('loginPassword').value
    });
    showDashboard(data);
    showMessage('loginMsg', 'Signed in successfully.');
  } catch (err) {
    showMessage('loginMsg', err.message, true);
  }
});

$('accountBtn').addEventListener('click', async () => {
  $('account').scrollIntoView({ behavior: 'smooth' });

  try {
    showDashboard(await api('/api/account'));
  } catch {
    showAuthForms();
  }
});

$('logoutBtn').addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', {});
    showMessage('loginMsg', 'You have signed out.');
  } catch (err) {
    showMessage('loginMsg', err.message, true);
  }

  showAuthForms();
  $('tokenOutput').textContent = '';
});

$('tokenBtn').addEventListener('click', async () => {
  showMessage('tokenOutput', 'Checking subscription…');

  try {
    const data = await api('/api/app-token', {});
    $('tokenOutput').textContent =
      `Activation token (copy now): ${data.token} · Expires ${data.expiresAt}`;
  } catch (err) {
    showMessage('tokenOutput', err.message, true);
  }
});

document.querySelectorAll('[data-plan]').forEach((button) => {
  button.addEventListener('click', async () => {
    const plan = button.dataset.plan;
    $('account').scrollIntoView({ behavior: 'smooth' });

    if (plan === 'free') {
      showMessage('registerMsg', 'Create your free account below.');
      $('regEmail').focus();
      return;
    }

    try {
      await api('/api/billing/start', { plan });
      alert('Checkout request completed. Follow the payment provider instructions.');
    } catch (err) {
      alert(err.message);
    }
  });
});

(async () => {
  try {
    const data = await api('/api/account');
    showDashboard(data);
  } catch {
    showAuthForms();
  }
})();
