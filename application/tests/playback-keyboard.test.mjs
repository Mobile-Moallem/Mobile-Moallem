import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../dist/client/site.js', import.meta.url), 'utf8');
const start = source.indexOf('document.addEventListener("keydown", event => {');
const end = source.indexOf('}, true);', start) + '}, true);'.length;

function fixture() {
  let handler;
  class Element {
    constructor(type = '') { this.type = type; }
    closest(selector) {
      if (selector === "button, [role='button']") return this.type === 'body' || this.type === 'input' ? null : this;
      return this.type === 'input' ? this : null;
    }
    matches() { return ['word', 'word-row', 'hazza-mark', 'hazzat-stack', 'play-button'].includes(this.type); }
  }
  const players = Object.fromEntries(['hazzat', 'english', 'coptic'].map(kind => [kind, {
    currentTime: 42.75, paused: true,
    getAttribute: () => '/recording.mp3',
    pause() { this.paused = true; },
    play() { this.paused = false; return Promise.resolve(); },
  }]));
  const context = { document: { addEventListener(type, fn, capture) { assert.equal(type, 'keydown'); assert.equal(capture, true); handler = fn; } }, Element, players, aligning: false, reportingError: false, activePlaybackKind: 'hazzat', $: () => ({ hidden: false }), setHelp() {} };
  runInNewContext(source.slice(start, end), context);
  function press(type, extra = {}) {
    let replayed = false;
    const event = { key: ' ', target: new Element(type), prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...extra };
    handler(event);
    // Focused section handlers and native button activation run after capture.
    if (!event.stopped && !event.prevented && type !== 'body') replayed = true;
    return { event, replayed };
  }
  return { players, context, press };
}

for (const kind of ['hazzat', 'english', 'coptic']) {
  test(`Space pauses and resumes ${kind} at its current position with a focused hymn part`, () => {
    for (const type of ['word', 'word-row', 'hazza-mark', 'hazzat-stack', 'play-button', 'body']) {
      const f = fixture();
      f.players[kind].paused = false;
      f.context.activePlaybackKind = kind;
      assert.equal(f.press(type).replayed, false);
      assert.equal(f.players[kind].paused, true);
      assert.equal(f.players[kind].currentTime, 42.75);
      f.press(type, { repeat: true });
      assert.equal(f.players[kind].paused, true);
      assert.equal(f.press(type).replayed, false);
      assert.equal(f.players[kind].paused, false);
      assert.equal(f.players[kind].currentTime, 42.75);
    }
  });
}

test('typing, unrelated buttons, modifiers, and alignment retain their keyboard behavior', () => {
  const f = fixture();
  f.players.hazzat.paused = false;
  for (const [type, extra] of [['input', {}], ['other-button', {}], ['word', { ctrlKey: true }], ['word', { isComposing: true }], ['word', { key: 'Enter' }]]) {
    assert.equal(f.press(type, extra).event.stopped, false);
    assert.equal(f.players.hazzat.paused, false);
  }
  f.context.aligning = true;
  assert.equal(f.press('word').event.stopped, false);
  assert.equal(f.players.hazzat.paused, false);
});
