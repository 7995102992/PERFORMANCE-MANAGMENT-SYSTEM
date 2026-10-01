const http = require('http');

async function run() {
  const loginRes = await fetch('http://localhost:8000/api/v1/auth/login', { // Or wherever the backend is
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'manager1@acme.com', password: 'Password123!' })
  });
  
  if (!loginRes.ok) {
    console.log('Login failed', loginRes.status, await loginRes.text());
    return;
  }
  
  const token = (await loginRes.json()).access_token;
  
  const tripsRes = await fetch('http://localhost:8000/api/v1/trips?scope=team&month_from=2026-08-01&month_to=2026-08-31', {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  
  console.log('Trips status:', tripsRes.status);
  console.log('Trips body:', await tripsRes.text());
}

run();
