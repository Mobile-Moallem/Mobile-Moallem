const params = new URLSearchParams(location.hash.slice(1));
const nonce = params.get('nonce');
const reviewOrigin = params.get('reviewOrigin');
const fragmentPayload = params.get('alignment');
const status = document.querySelector('#status');
const publish = document.querySelector('#publish');
let payload, project, busy = false;
function allowedReviewOrigin(value) {
  try { const url = new URL(value); return url.origin === value && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname); } catch { return false; }
}
function send(type, extra = {}) { if (window.opener) window.opener.postMessage({ type, nonce, ...extra }, reviewOrigin); }
async function jsonRequest(url, options) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  let data;
  try { data = await response.json(); } catch { throw new Error('Sign in to Mobile Moallem, then reopen Publish from your review.'); }
  if (!response.ok) throw new Error(data.error || 'Could not publish. Please try again.');
  return data;
}
async function prepare(incoming) {
  if (!incoming || typeof incoming !== 'object' || !/^[a-z0-9-]+(?:\/[a-z0-9-]+){2}$/u.test(incoming.hymnId || '') || !['coptic', 'english', 'hazzat'].includes(incoming.section) || !Array.isArray(incoming.timings) || incoming.timings.length > 12000 || !Array.isArray(incoming.labels) || incoming.labels.length !== incoming.timings.length) throw new Error('This review does not contain a complete alignment.');
  const session = await jsonRequest('/api/session');
  if (!session.canEdit) throw new Error('Sign in with your Mobile Moallem editor account to publish.');
  const result = await jsonRequest('/api/project?' + new URLSearchParams({ hymnId: incoming.hymnId }));
  if (!result.project) throw new Error('The saved hymn could not be found.');
  payload = incoming; project = result.project;
  document.querySelector('#title').textContent = project.title;
  document.querySelector('#summary').textContent = `${incoming.timings.filter(Number.isFinite).length} ${incoming.section === 'hazzat' ? 'note' : 'word'} starts · ${incoming.section === 'hazzat' ? 'Hazzat' : incoming.section === 'coptic' ? 'Coptic words' : 'English words'}`;
  const link = document.querySelector('#hymnLink'); link.href = '/#/hymn/' + incoming.hymnId;
  const list = document.querySelector('#parts'); list.replaceChildren();
  incoming.labels.forEach((label, i) => {
    const li = document.createElement('li'), part = document.createElement('span'), time = document.createElement('span');
    part.className = 'part-' + incoming.section; part.textContent = String(label).slice(0, 400);
    time.className = 'time'; time.textContent = incoming.timings[i] === null ? 'Breath · untimed' : Number(incoming.timings[i]).toFixed(3) + 's';
    li.append(part, time); list.append(li);
  });
  document.querySelector('#review').hidden = false; publish.disabled = false;
  status.textContent = 'Ready to publish this reviewed alignment.';
  send('mobile-moallem-publish-prepared');
}
if (!nonce || !/^[a-f0-9-]{36}$/u.test(nonce) || !allowedReviewOrigin(reviewOrigin) || (!window.opener && !fragmentPayload)) {
  status.textContent = 'Open Publish on Mobile Moallem from your alignment review.';
} else {
  window.addEventListener('message', async event => {
    if (event.origin !== reviewOrigin || event.source !== window.opener || event.data?.nonce !== nonce || event.data?.type !== 'mobile-moallem-publish-payload' || payload || busy) return;
    busy = true;
    try { await prepare(event.data.payload); } catch (error) { status.textContent = error.message; send('mobile-moallem-publish-error', { message: error.message }); } finally { busy = false; }
  });
  send('mobile-moallem-publish-ready');
  // Sign-in redirects can detach the opener. Keep the review in the URL fragment,
  // which is not sent in HTTP requests, so publication still works after sign-in.
  if (fragmentPayload) {
    busy = true;
    try { await prepare(JSON.parse(fragmentPayload)); }
    catch (error) { status.textContent = error.message; send('mobile-moallem-publish-error', { message: error.message }); }
    finally { busy = false; }
  }
}
publish.addEventListener('click', async () => {
  if (!payload || !project || busy) return;
  busy = true; publish.disabled = true; status.textContent = 'Publishing…';
  try {
    const result = await jsonRequest('/api/project/publish-alignment?' + new URLSearchParams({ hymnId: payload.hymnId }), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ section: payload.section, timings: payload.timings, recordingUrl: payload.recordingUrl, expectedSource: payload.expectedSource, duration: payload.duration, expectedUpdatedAt: project.updatedAt })
    });
    const key = payload.section === 'coptic' ? 'copticTimings' : payload.section === 'english' ? 'timings' : 'hazzatTimings';
    const saved = await jsonRequest('/api/project?' + new URLSearchParams({ hymnId: payload.hymnId }));
    if (saved.project?.status !== 'complete' || JSON.stringify(saved.project[key]) !== JSON.stringify(payload.timings)) throw new Error('Publication could not be verified. Open the hymn to check before retrying.');
    project = result.project; publish.textContent = 'Published'; status.textContent = 'Published on Mobile Moallem. Ready for listeners.';
    send('mobile-moallem-publish-success', { hymnId: payload.hymnId });
  } catch (error) { status.textContent = error.message; send('mobile-moallem-publish-error', { message: error.message }); publish.disabled = false; }
  finally { busy = false; }
});
