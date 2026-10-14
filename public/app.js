const $ = (id) => document.getElementById(id);
const API_BASE = 'https://framecut-subscription-api.onrender.com';
$('year').textContent = new Date().getFullYear();

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
    throw new Error(data.errorMessage || data.error || `Request failed (${response.status})`);
  }
  return data;
}

function showDashboard(data) {
  if (!data || !data.user) throw new Error('The API response did not include account information.');
  $('dashboard').classList.remove('hidden');
  $('accountInfo').textContent = `Signed in as ${data.user.email}`;
  const s = data.subscription;
  $('subscriptionInfo').textContent = s
    ? `Subscription: ${s.plan} · status: ${s.status}${s.current_period_end ? ' · through ' + s.current_period_end : ''}`
    : 'No subscription is active yet.';
  $('registerForm').classList.add('hidden');
  $('loginForm').classList.add('hidden');
}
function showMessage(id, message, bad = false) {
  const el = $(id);
  el.textContent = message;
  el.classList.toggle('error', bad);
}

$('registerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  showMessage('registerMsg', 'Creating account…');
  try {
    const data = await api('/api/auth/register', {
      email: $('regEmail').value.trim(),
      password: $('regPassword').value
    });
    showDashboard(data);
  } catch (error) {
    showMessage('registerMsg', error.message || 'Registration failed.', true);
  }
});
$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  showMessage('loginMsg', 'Signing in…');
  try {
    const data = await api('/api/auth/login', {
      email: $('loginEmail').value.trim(),
      password: $('loginPassword').value
    });
    showDashboard(data);
  } catch (error) {
    showMessage('loginMsg', error.message || 'Sign-in failed.', true);
  }
});
$('accountBtn').addEventListener('click', async () => {
  $('account').scrollIntoView({ behavior: 'smooth' });
  try {
    showDashboard(await api('/api/account'));
  } catch {
    $('registerForm').classList.remove('hidden');
    $('loginForm').classList.remove('hidden');
  }
});
$('logoutBtn').addEventListener('click', async () => {
  try { await api('/api/auth/logout', {}); }
  catch (error) { console.error('Logout failed:', error.message); }
  $('dashboard').classList.add('hidden');
  $('registerForm').classList.remove('hidden');
  $('loginForm').classList.remove('hidden');
  $('tokenOutput').textContent = '';
});
$('tokenBtn').addEventListener('click', async () => {
  showMessage('tokenOutput', 'Checking subscription…');
  try {
    const data = await api('/api/app-token', {});
    $('tokenOutput').textContent = `Activation token (copy now): ${data.token} · Expires ${data.expiresAt}`;
  } catch (error) {
    showMessage('tokenOutput', error.message || 'Could not generate a token.', true);
  }
});
document.querySelectorAll('[data-plan]').forEach((button) => {
  button.addEventListener('click', async () => {
    const plan = button.dataset.plan;
    $('account').scrollIntoView({ behavior: 'smooth' });
    if (plan === 'free') {
      showMessage('registerMsg', 'Create a free account below.');
      return;
    }
    try { await api('/api/billing/start', { plan }); }
    catch (error) { alert(error.message || 'Checkout is not available yet.'); }
  });
});
(async () => {
  try { showDashboard(await api('/api/account')); }
  catch { /* No active session; leave sign-in forms visible. */ }
})();
