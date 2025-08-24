export function startVolumeMonitoring(stream, onVolumeChange) {
  const audioContext = new AudioContext();
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;

  const source = audioContext.createMediaStreamSource(stream);
  source.connect(analyser);

  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  function updateVolume() {
    analyser.getByteFrequencyData(dataArray);

    const avg = dataArray.reduce((sum, val) => sum + val, 0) / dataArray.length;
    console.log("Average: ", avg);
    const scale = Math.min(1, Math.max(0.5, avg / 10));
    onVolumeChange(scale); // Zustand: setAudioScale
    requestAnimationFrame(updateVolume);
  }

  updateVolume();
}

export function enhanceAudioScale(rawScale, smoothing = 0.1) {
  // Clamp raw scale input
  const clampedRaw = Math.max(0.5, Math.min(2, rawScale));

  // Normalize raw scale from [0.5 - 2] to [0 - 1]
  const normalized = (clampedRaw - 0.5) / (2 - 0.5); // 0.5 to 2 mapped to 0 to 1

  // Apply easing for smoother transition
  const eased = Math.pow(normalized, 1.5); // Adjust the exponent for effect

  // Map to final visible range, e.g., [0.5 - 1.2]
  const minScale = 0.7;
  const maxScale = 1.9;
  const final = minScale + (maxScale - minScale) * eased;

  return final;
}
