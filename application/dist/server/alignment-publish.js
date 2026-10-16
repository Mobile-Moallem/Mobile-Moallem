const sections = {
  coptic: { times: 'coptic_timings_json', recording: 'coptic_recording_url', source: 'coptic_text' },
  english: { times: 'timings_json', recording: 'english_recording_url', source: 'text_content' },
  hazzat: { times: 'hazzat_timings_json', recording: 'recording_url', source: 'notation_html' }
};
export const sectionConfig = section => sections[section];
const decode = text => text.replace(/&(?:nbsp|#160);/giu, ' ').replace(/&lt;/giu, '<').replace(/&gt;/giu, '>').replace(/&quot;/giu, '"').replace(/&apos;|&#39;/giu, "'").replace(/&amp;/giu, '&');
export const normalizedSource = text => String(text || '').trim().replace(/\s+/gu, ' ');
export function sourceParts(source, section) {
  if (section !== 'hazzat') return normalizedSource(source).split(/\s+/u).filter(Boolean);
  const parts = [];
  for (const match of source.matchAll(/<(?:span|div|b|i)\b[^>]*class=["'][^"']*\bHazzat(?:V)?Font\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:span|div|b|i)>/giu)) {
    parts.push(...decode(match[1].replace(/<[^>]*>/gu, '')).split(/\s+/u).filter(Boolean));
  }
  return parts;
}
export function validateAlignment(body, row, source) {
  const config = sectionConfig(body.section);
  if (!config) throw new Error('Choose a supported alignment section.');
  if (typeof body.recordingUrl !== 'string' || !body.recordingUrl || body.recordingUrl !== row[config.recording]) throw new Error('The recording changed. Prepare a review for the current recording.');
  if (typeof body.expectedSource !== 'string' || normalizedSource(body.expectedSource) !== normalizedSource(source)) throw new Error('The hymn text or notation changed. Prepare a new review before publishing.');
  if (!Number.isFinite(body.duration) || body.duration <= 0 || body.duration > 86400) throw new Error('The recording duration is missing or invalid.');
  const parts = sourceParts(source, body.section);
  if (!parts.length || !Array.isArray(body.timings) || body.timings.length !== parts.length || parts.length > 12000) throw new Error('The timing count does not match this hymn.');
  let previous = -1;
  for (let i = 0; i < parts.length; i++) {
    const value = body.timings[i];
    if (body.section === 'hazzat' && /^\.+$/u.test(parts[i])) {
      if (value !== null) throw new Error('Breath marks must remain untimed.');
    } else {
      if (!Number.isFinite(value) || value < 0 || value >= body.duration || value <= previous) throw new Error('Every sung part needs an ordered timing within the recording.');
      previous = value;
    }
  }
  if (previous < 0) throw new Error('At least one sung part is required.');
  // Publishing individual notes does not replace separately edited stack starts.
  return { config, parts };
}

export function catalogSource(hymn, section) {
  if (section === 'hazzat') {
    const variation = hymn?.formats?.['2']?.[0] || hymn?.formats?.['3']?.[0];
    return variation?.content?.copticHazzat || variation?.content?.englishHazzat || '';
  }
  return (hymn?.formats?.['1']?.[0]?.content?.paragraphs || []).map(p => decode(String((p.columns || []).find(c => c.language?.toLowerCase() === section)?.content || '').replace(/<br\s*\/?\s*>/giu, ' ')).trim()).join('\n');
}
