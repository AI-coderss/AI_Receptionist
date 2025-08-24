import { create } from 'zustand';

const useAudioForVisualizerStore = create((set) => ({
  audioStream: null,
  setAudioStream: (stream) => set({ audioStream: stream }),
  clearAudioStream: () => set({ audioStream: null }),

  audioUrl: null,
  setAudioUrl: (url) => set({ audioUrl: url }),
  clearAudioUrl: () => set({ audioUrl: null }),

  isVisualizerReady: false,
  setVisualizerReady: (ready) => set({ isVisualizerReady: ready }),

  // ✅ Added:
  audioScale: 0.7,
  setAudioScale: (scale) => set({ audioScale: scale }),
}));

export default useAudioForVisualizerStore;
