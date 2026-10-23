'use strict';

// Create a short, silent overview from actual renderer screenshots.
// Called only when explicitly exporting website product media.
const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow } = require('electron');

module.exports = async function encodeWebsiteDemo(directory) {
  const images = ['editor', 'connection', 'backup'].map((name) =>
    `data:image/png;base64,${fs.readFileSync(path.join(directory, `${name}.png`)).toString('base64')}`);
  const encoder = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
  try {
    await encoder.loadURL('data:text/html;charset=utf-8,%3Ccanvas%20id%3D%22video%22%20width%3D%221344%22%20height%3D%22835%22%3E%3C%2Fcanvas%3E');
    const bytes = await encoder.webContents.executeJavaScript(`(async () => {
      const canvas = document.querySelector('canvas');
      const context = canvas.getContext('2d');
      const frames = await Promise.all(${JSON.stringify(images)}.map(src => new Promise((resolve, reject) => {
        const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = src;
      })));
      const stream = canvas.captureStream(0);
      const track = stream.getVideoTracks()[0];
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm;codecs=vp8';
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 800000 });
      const chunks = [];
      const done = new Promise((resolve, reject) => {
        recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
        recorder.onstop = resolve; recorder.onerror = reject;
      });
      recorder.start();
      for (const frame of frames) {
        for (let index = 0; index < 30; index += 1) {
          context.drawImage(frame, 0, 0, canvas.width, canvas.height);
          track.requestFrame();
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      recorder.stop(); await done; track.stop();
      return Array.from(new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer()));
    })()`);
    fs.writeFileSync(path.join(directory, 'overview.webm'), Buffer.from(bytes));
  } finally {
    encoder.destroy();
  }
};
