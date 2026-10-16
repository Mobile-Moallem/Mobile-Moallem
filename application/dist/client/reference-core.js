// Evidence rules shared by the browser, worker, and draft-save endpoint.
export const ENGINE = 'coptic-reference-v1';
export const isBreath = glyph => /^\.+$/u.test(String(glyph).replace(/\s/gu, ''));
export const fields = { hazzat: 'hazzatTimings', coptic: 'copticTimings', english: 'timings' };
export function audit(times, parts, duration, section = 'hazzat') {
  if (!Array.isArray(times) || times.length !== parts.length || !parts.length || parts.length > 12000) throw new Error('The passage count changed. Prepare a new review.');
  if (!Number.isFinite(duration) || duration <= 0 || duration > 3600) throw new Error('Use a recording shorter than one hour.');
  let previous = -1, notes = 0, breaths = 0, marked = 0;
  times.forEach((t, i) => {
    if (section === 'hazzat' && isBreath(parts[i].glyph)) {
      breaths++;
      if (t !== null) throw new Error('Standalone breath marks must stay blank.');
      return;
    }
    notes++;
    if (t === null) return;
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t >= duration || t <= previous) throw new Error('Keep note starts in order and inside the recording.');
    previous = t; marked++;
  });
  return { notes, breaths, marked, unresolved: notes - marked };
}
export async function digest(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
}
export function compatible(reference, target) {
  if (reference?.engine !== ENGINE || reference.approval !== 'human-reviewed') throw new Error('Choose a reference whose musical identity and starts were reviewed.');
  if (reference.hymnId !== target.hymnId || reference.section !== target.section) throw new Error('The reference must use this same hymn and language channel.');
  if (!reference.expectedSource || reference.expectedSource !== target.expectedSource) throw new Error('This notation or text edition differs from the reference. Resolve its passage correspondence first.');
  if (JSON.stringify(reference.parts.map(p => [p.glyph, p.font, p.stack])) !== JSON.stringify(target.parts.map(p => [p.glyph, p.font, p.stack]))) throw new Error('The passage map differs from the reference.');
  audit(reference.times, reference.parts, reference.duration, reference.section);
  if (!reference.times.some(Number.isFinite)) throw new Error('The reference has no approved starts.');
  if (!/^[a-f0-9]{64}$/u.test(reference.audioSha256 || '')) throw new Error('The reference is missing its recording fingerprint.');
}
export function mergeReviewed(baseline, times, decisions, parts, duration, section) {
  audit(times, parts, duration, section);
  if (!Array.isArray(decisions) || decisions.length !== parts.length || decisions.some(d => !['unreviewed','approved','rejected','early','late','unsure'].includes(d))) throw new Error('Review decisions are missing.');
  if (baseline.length > parts.length) throw new Error('The original timing map differs from this edition.');
  const merged = parts.map((part, i) => {
    if (section === 'hazzat' && isBreath(part.glyph)) return null;
    // Human work is never replaced by a generated cue.
    if (Number.isFinite(baseline[i])) return baseline[i];
    return decisions[i] === 'approved' && Number.isFinite(times[i]) ? times[i] : null;
  });
  audit(merged, parts, duration, section);
  return merged;
}
