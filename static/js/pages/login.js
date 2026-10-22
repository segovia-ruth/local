/* Local login UI. Authentication and the session belong to the real backend. */
document.getElementById('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const error = document.getElementById('loginError');
  error.hidden = true;
  button.disabled = true;
  button.textContent = 'Signing in…';
  try {
    const username = form.elements.username.value.trim();
    const response = await fetch('/login', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ username, email: username, password: form.elements.password.value })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Sign-in failed. Please try again.');
    const destination = new URL(data.next || '/', location.origin);
    if (destination.origin !== location.origin) throw new Error('Unexpected sign-in destination.');
    form.elements.password.value = '';
    location.assign(destination.pathname + destination.search + destination.hash);
  } catch (err) {
    error.textContent = err instanceof SyntaxError ? 'Unable to sign in. Please try again.' : err.message;
    error.hidden = false;
    button.disabled = false;
    button.textContent = 'Sign in';
  }
});
