// Opt-in, metadata-only desktop UX trace. Never records prompts, audio, or credentials.
(() => {
  if (window.__yuviUxTrace) return;
  const trace = (phase, detail = {}) => console.info('[yuvi-ux] ' + JSON.stringify({
    at: Math.round(performance.now()), phase, ...detail
  }));
  window.__yuviUxTrace = trace;
  trace('webview', { secure: isSecureContext, mediaDevices: !!navigator.mediaDevices,
    getUserMedia: !!navigator.mediaDevices?.getUserMedia, origin: location.origin });
  const originalFetch = window.fetch;
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    const url = String(args[0]?.url ?? args[0]);
    if (/\/v1\/(tts|speech-activity|voice)/.test(url)) trace('voice-response', {
      path: new URL(url, location.href).pathname, status: response.status
    });
    if (/\/v1\/(messages|proactive-turns)\/stream/.test(url) && response.body) {
      trace('stream-headers', { status: response.status });
      const getReader = response.body.getReader.bind(response.body);
      response.body.getReader = (...readerArgs) => {
        const reader = getReader(...readerArgs);
        const read = reader.read.bind(reader);
        reader.read = async () => {
          const result = await read();
          trace('stream-chunk', { bytes: result.value?.length ?? 0, done: result.done });
          return result;
        };
        return reader;
      };
    }
    return response;
  };
  const post = BroadcastChannel.prototype.postMessage;
  BroadcastChannel.prototype.postMessage = function (data) {
    trace('bus-post', { channel: this.name, kind: data?.message?.kind });
    return post.call(this, data);
  };
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    trace('audio-play', { type: this.tagName, muted: this.muted, volume: this.volume });
    this.addEventListener('ended', () => trace('audio-ended'), { once: true });
    return play.call(this).then(value => { trace('playbackStarted'); return value; }, error => {
      trace('playbackError', { name: error.name, message: error.message }); throw error;
    });
  };
  if (navigator.mediaDevices?.getUserMedia) {
    const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      trace('microphone-request');
      try {
        const stream = await get(constraints);
        trace('microphone-acquired', { tracks: stream.getAudioTracks().length });
        return stream;
      } catch (error) { trace('microphone-error', { name: error.name }); throw error; }
    };
  }
  let previous = '';
  new MutationObserver(() => {
    const states = [...document.querySelectorAll('.yuvi-main-message')].map(el => ({
      length: el.textContent.length, status: el.getAttribute('data-status')
    }));
    const subtitle = document.querySelector('.yuvi-subtitle-band');
    const value = JSON.stringify({ states, subtitleLength: subtitle?.textContent.length,
      subtitleVisible: subtitle?.classList.contains('is-visible') });
    if (value !== previous) { previous = value; trace('render', JSON.parse(value)); }
  }).observe(document.body, { subtree: true, characterData: true, childList: true, attributes: true });
})();
