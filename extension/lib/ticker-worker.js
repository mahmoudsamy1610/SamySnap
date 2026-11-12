// Steady timer for the canvas watermark fallback. Timers in a minimized
// window are throttled to about once per second; timers in a worker are not.
let timer = null;
self.onmessage = (e) => {
  clearInterval(timer);
  if (e.data?.fps) timer = setInterval(() => self.postMessage(0), 1000 / e.data.fps);
};
