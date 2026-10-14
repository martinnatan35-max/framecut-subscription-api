
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

  const url = `${API_BASE}${path}`;
  const response = await fetch(url, options);
  const text = await response.text();

  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text || 'The server returned an unreadable response.' };
  }

  if (!response.ok) {
    throw new Error(
      `${response.status} ${response.statusText}: ` +
      (data.error || data.errorMessage || 'Request failed.')
    );
  }

  return data;
}

function showMessage(id, text, bad = false) {
  const element = $(id);
  if (!element) return;

  element.textContent = text;
  element.style.color = bad ? '#ff9b9b' : 'var(--accent)';
}

function showDashboard(data) {
  if (!data.user) {
    throw new Error('The server response did not include account information.');
  }

  $('dashboard').classList.remove('hidden');
  $('accountInfo').textContent = `Signed in as ${data.user.email}`;

  const subscription = data.subscription;
  $('subscriptionInfo').textContent = subscription
    ? `Subscription: ${subscription.plan} · Status: ${subscription.status}`
    : 'No subscription is active yet.';

  $('registerForm').classList.add('hidden');
  $('loginForm').classList.add('hidden');
}

function showAuthForms() {
  $('dashboard').classList.add('hidden');
  $('registerForm').classList.remove('hidden');
  $('loginForm').classList.remove('hidden');
}

$('registerForm').addEventListener('submit', async (event) => {
  event.preventDefault();

  const email = $('regEmail').value.trim();
  const password = $('regPassword').value;

  if (!email || !password) {
    showMessage('registerMsg', 'Enter your email and password.', true);
    return;
  }

  if (password.length < 12 || password.length > 200) {
    showMessage(
      'registerMsg',
      'Use a password between 12 and 200 characters.',
      true
    );
    return;
  }

  showMessage('registerMsg', 'Creating account…');

  try {
    const data = await api('/api/auth/register', { email, password });
    showDashboard(data);
    showMessage('registerMsg', 'Account created successfully.');
  } catch (error) {
    showMessage('registerMsg', error.message, true);
  }
});

$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();

  const email = $('loginEmail').value.trim();
  const password = $('loginPassword').value;

  if (!email || !password) {
    showMessage('loginMsg', 'Enter your email and password.', true);
    return;
  }

  showMessage('loginMsg', 'Signing in…');

  try {
    const data = await api('/api/auth/login', { email, password });
    showDashboard(data);
    showMessage('loginMsg', 'Signed in successfully.');
  } catch (error) {
    showMessage('loginMsg', error.message, true);
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
  } catch (error) {
    showMessage('loginMsg', error.message, true);
  }

  showAuthForms();
  $('tokenOutput').textContent = '';
});

$('tokenBtn').addEventListener('click', async () => {
  showMessage('tokenOutput', 'Checking subscription…');

  try {
    const data = await api('/api/app-token', {});
    $('tokenOutput').textContent =
      `Activation token: ${data.token} · Expires ${data.expiresAt}`;
  } catch (error) {
    showMessage('tokenOutput', error.message, true);
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
      alert('Checkout request completed.');
    } catch (error) {
      alert(error.message);
    }
  });
});

(async () => {
  try {
    showDashboard(await api('/api/account'));
  } catch {
    showAuthForms();
  }
})();
