


const API_BASE = 'https://framecut-subscription-api.onrender.com';

async function api(path, body) {
  const options = {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'include',
    headers: {}
  };

  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${API_BASE}${path}`, options);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.errorMessage ||
      data.error ||
      `Request failed (${response.status})`
    );
  }

  return data;
}

function showDashboard(data) {
  $('dashboard').classList.remove('hidden');
  $('accountInfo').textContent = `Signed in as ${data.user.email}`;

  const s = data.subscription;

  $('subscriptionInfo').textContent = s
    ? `Subscription: ${s.plan} · status: ${s.status}${
        s.current_period_end
          ? ' · through ' + s.current_period_end
          : ''
      }`
    : 'No subscription is active yet.';

  $('registerForm').classList.add('hidden');
  $('loginForm').classList.add('hidden');
}

function showMessage(id, text, bad = false) {
  $(id).textContent = text;
  $(id).style.color = bad ? '#ff9b9b' : 'var(--accent)';
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
  } catch (err) {
    showMessage('loginMsg', err.message, true);
  }
});

$('accountBtn').addEventListener('click', async () => {
  $('account').scrollIntoView({ behavior: 'smooth' });

  try {
    const data = await api('/api/account');
    showDashboard(data);
  } catch {
    $('registerForm').classList.remove('hidden');
    $('loginForm').classList.remove('hidden');
  }
});

$('logoutBtn').addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', {});
  } catch (err) {
    console.error('Logout failed:', err.message);
  }

  $('dashboard').classList.add('hidden');
  $('registerForm').classList.remove('hidden');
  $('loginForm').classList.remove('hidden');
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

document.querySelectorAll('[data-plan]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const plan = btn.dataset.plan;

    $('account').scrollIntoView({ behavior: 'smooth' });

    if (plan === 'free') {
      showMessage('registerMsg', 'Create a free account below.');
      return;
    }

    try {
      await api('/api/billing/start', { plan });
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
    // No active session.
  }
})();
