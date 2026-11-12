import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pickMimeType, recorderOptions, desktopConstraints, combineStreams, stopStreams } from '../../extension/lib/media.js';

describe('pickMimeType', () => {
  test('prefers vp9,opus', () => {
    assert.equal(pickMimeType(() => true), 'video/webm;codecs=vp9,opus');
  });
  test('falls back to vp8,opus', () => {
    assert.equal(pickMimeType((t) => !t.includes('vp9')), 'video/webm;codecs=vp8,opus');
  });
  test('falls back to plain webm, then empty (browser default)', () => {
    assert.equal(pickMimeType((t) => t === 'video/webm'), 'video/webm');
    assert.equal(pickMimeType(() => false), '');
  });
});

describe('recorderOptions', () => {
  test('~4 Mbps video', () => {
    const o = recorderOptions('video/webm;codecs=vp9,opus');
    assert.equal(o.videoBitsPerSecond, 4_000_000);
    assert.equal(o.mimeType, 'video/webm;codecs=vp9,opus');
    assert.equal(recorderOptions('').mimeType, undefined);
  });
});

describe('desktopConstraints', () => {
  test('1080p / 30 fps cap on the desktop stream id', () => {
    const c = desktopConstraints('sid');
    assert.deepEqual(c.video.mandatory, {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: 'sid',
      maxWidth: 1920,
      maxHeight: 1080,
      maxFrameRate: 30,
    });
    assert.equal(c.audio, false);
  });
  test('audio uses the same stream id when allowed', () => {
    assert.deepEqual(desktopConstraints('sid', { audio: true }).audio, {
      mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: 'sid' },
    });
  });
});

// Minimal fakes for MediaStream / AudioContext.
class FakeTrack {
  constructor(kind, id) {
    this.kind = kind;
    this.id = id;
    this.stopped = false;
  }
  stop() {
    this.stopped = true;
  }
}
class FakeStream {
  constructor(tracks = []) {
    this.tracks = tracks;
  }
  getTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
}
function fakeEnv() {
  const env = { connected: [], closed: false };
  env.MediaStream = FakeStream;
  env.AudioContext = class {
    createMediaStreamDestination() {
      return { stream: new FakeStream([new FakeTrack('audio', 'mixed')]) };
    }
    createMediaStreamSource(s) {
      return { connect: () => env.connected.push(s) };
    }
    async close() {
      env.closed = true;
    }
  };
  return env;
}

describe('combineStreams', () => {
  const v = () => new FakeTrack('video', 'v');
  test('video only', () => {
    const { stream } = combineStreams(new FakeStream([v()]), null, fakeEnv());
    assert.deepEqual(stream.getTracks().map((t) => t.id), ['v']);
  });
  test('system audio only → passes the track through (no mixing)', () => {
    const env = fakeEnv();
    const { stream } = combineStreams(new FakeStream([v(), new FakeTrack('audio', 'sys')]), null, env);
    assert.deepEqual(stream.getTracks().map((t) => t.id), ['v', 'sys']);
    assert.equal(env.connected.length, 0);
  });
  test('mic only', () => {
    const { stream } = combineStreams(new FakeStream([v()]), new FakeStream([new FakeTrack('audio', 'mic')]), fakeEnv());
    assert.deepEqual(stream.getTracks().map((t) => t.id), ['v', 'mic']);
  });
  test('system + mic → mixed into ONE audio track via Web Audio', () => {
    const env = fakeEnv();
    const display = new FakeStream([v(), new FakeTrack('audio', 'sys')]);
    const mic = new FakeStream([new FakeTrack('audio', 'mic')]);
    const { stream, cleanup } = combineStreams(display, mic, env);
    assert.deepEqual(stream.getTracks().map((t) => t.id), ['v', 'mixed']);
    assert.deepEqual(env.connected, [display, mic]);
    cleanup();
    assert.equal(env.closed, true);
  });
  test('stopStreams stops all tracks and ignores null', () => {
    const t = [v(), new FakeTrack('audio', 'a')];
    stopStreams(new FakeStream(t), null);
    assert.ok(t.every((x) => x.stopped));
  });
});
