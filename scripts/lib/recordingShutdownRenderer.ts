import { ipcRenderer } from 'electron';
import { stopCaptureResources } from '../../src/utils/captureShutdown';

const results: Array<Record<string, unknown>> = [];
const run = async () => {
  for (const missingStopEvent of [false, true]) {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const destination = context.createMediaStreamDestination();
    oscillator.connect(destination); // Synthetic audio never reaches speakers or a microphone.
    oscillator.start();
    const recorder = new MediaRecorder(destination.stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    recorder.start();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const began = performance.now();
    const target = missingStopEvent
      ? {
          get state() {
            return recorder.state;
          },
          addEventListener: () => {},
          removeEventListener: () => {},
          stop: () => recorder.stop(),
        }
      : recorder;
    const result = await stopCaptureResources({
      recorder: target,
      stopNative: () => ipcRenderer.invoke('stop-synthetic-child'),
      releaseTracks: () => {
        for (const track of destination.stream.getTracks()) track.stop();
        return destination.stream
          .getTracks()
          .every((track) => track.readyState === 'ended');
      },
      closeContext: () => context.close(),
    });
    const savedBytes = (await new Blob(chunks).arrayBuffer()).byteLength;
    const report = {
      missingStopEvent,
      ...result,
      elapsedMs: performance.now() - began,
      savedBytes,
      contextClosed: context.state === 'closed',
      tracksEnded: destination.stream
        .getTracks()
        .every((track) => track.readyState === 'ended'),
    };
    if (
      !report.released ||
      !report.contextClosed ||
      !report.tracksEnded ||
      savedBytes < 1000 ||
      report.elapsedMs > 4000 ||
      result.recorderCompleted === missingStopEvent
    ) {
      throw new Error(JSON.stringify(report));
    }
    results.push(report);
  }
  ipcRenderer.send('shutdown-result', { results });
};
void run().catch((error) =>
  ipcRenderer.send('shutdown-result', { error: String(error) }),
);
