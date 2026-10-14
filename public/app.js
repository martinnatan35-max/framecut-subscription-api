const $ = (id) => document.getElementById(id);
$('year').textContent = new Date().getFullYear();
async function api(url, body) {
 const res = await fetch(url, { method: body ? 'POST' : 'GET', headers: body ? {'Content-Type':'application/json'} : {}, credentials:'same-origin', body: body ? JSON.stringify(body) : undefined });
 const data = await res.json().catch(() => ({})); if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`); return data;
}
function showDashboard(data) {
 $('dashboard').classList.remove('hidden'); $('accountInfo').textContent = `Signed in as ${data.user.email}`;
 const s = data.subscription;
 $('subscriptionInfo').textContent = s ? `Subscription: ${s.plan} · status: ${s.status}${s.current_period_end ? ' · through '+s.current_period_end : ''}` : 'No subscription is active yet.';
 $('registerForm').classList.add('hidden'); $('loginForm').classList.add('hidden');
}
function showMessage(id, text, bad=false) { $(id).textContent = text; $(id).style.color = bad ? '#ff9b9b' : 'var(--accent)'; }
$('registerForm').addEventListener('submit', async e => { e.preventDefault(); showMessage('registerMsg','Creating account…'); try { const d=await api('/api/auth/register',{email:$('regEmail').value,password:$('regPassword').value}); showDashboard(d); } catch(err){showMessage('registerMsg',err.message,true);} });
$('loginForm').addEventListener('submit', async e => { e.preventDefault(); showMessage('loginMsg','Signing in…'); try { const d=await api('/api/auth/login',{email:$('loginEmail').value,password:$('loginPassword').value}); showDashboard(d); } catch(err){showMessage('loginMsg',err.message,true);} });
$('accountBtn').addEventListener('click', async () => { $('account').scrollIntoView({behavior:'smooth'}); try { const d=await api('/api/account'); showDashboard(d); } catch { $('registerForm').classList.remove('hidden'); $('loginForm').classList.remove('hidden'); } });
$('logoutBtn').addEventListener('click', async () => { try { await api('/api/auth/logout',{}); } catch {} $('dashboard').classList.add('hidden'); $('registerForm').classList.remove('hidden'); $('loginForm').classList.remove('hidden'); $('tokenOutput').textContent=''; });
$('tokenBtn').addEventListener('click', async () => { showMessage('tokenOutput','Checking subscription…'); try { const d=await api('/api/app-token',{}); $('tokenOutput').textContent=`Activation token (copy now): ${d.token} · Expires ${d.expiresAt}`; } catch(err) { showMessage('tokenOutput',err.message,true); } });
document.querySelectorAll('[data-plan]').forEach(btn => btn.addEventListener('click', async () => { const plan=btn.dataset.plan; $('account').scrollIntoView({behavior:'smooth'}); if(plan==='free'){showMessage('registerMsg','Create a free account below.');return;} try { await api('/api/billing/start',{plan}); } catch(err) { alert(err.message); } }));
(async()=>{try{const d=await api('/api/account');showDashboard(d);}catch{}})();
