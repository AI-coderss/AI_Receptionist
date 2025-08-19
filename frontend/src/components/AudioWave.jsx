/* eslint-disable no-unused-vars */
/* eslint-disable react-hooks/exhaustive-deps */
import React, { useEffect, useRef } from 'react';
import '../styles/AudioWave.css';

/**
 * AudioWave — Bar Graph (CodeBin extraction)
 * - Black background
 * - Log-scale x mapping (like CodeBin)
 * - HSL color per bar (same feel)
 * - Width matches the card below
 */
const AudioWave = ({ stream, audioUrl, onEnded }) => {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const srcNodeRef = useRef(null);
  const rafRef = useRef(null);

  // Resize canvas to the container (retina crisp)
  const resizeCanvas = () => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const dpr = Math.max(window.devicePixelRatio || 1, 1);
    const cssW = wrap.clientWidth || 600;
    const cssH = wrap.clientHeight || 80;

    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';

    const ctx = canvas.getContext('2d');
    // Draw in CSS pixels
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  useEffect(() => {
    resizeCanvas();
    const onResize = () => resizeCanvas();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // Create / setup WebAudio graph
    const AC = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AC();
    audioContextRef.current = audioCtx;

    const analyser = audioCtx.createAnalyser();
    // CodeBin used 2**12 (4096) → frequencyBinCount = 2048
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.5;
    analyserRef.current = analyser;

    // Source
    let srcNode;
    if (stream) {
      srcNode = audioCtx.createMediaStreamSource(stream);
      srcNode.connect(analyser);
    } else if (audioUrl) {
      const el = new Audio(audioUrl);
      el.crossOrigin = 'anonymous';
      el.play();
      srcNode = audioCtx.createMediaElementSource(el);
      srcNode.connect(analyser);
      analyser.connect(audioCtx.destination);
      el.addEventListener('ended', () => {
        onEnded?.();
      });
    }
    srcNodeRef.current = srcNode;

    const data = new Uint8Array(analyser.frequencyBinCount);

    const render = () => {
      rafRef.current = requestAnimationFrame(render);

      analyser.getByteFrequencyData(data);

      // Dimensions in CSS px (we set transform already)
      const w = canvas.clientWidth || 600;
      const h = canvas.clientHeight || 80;

      // Black background (as requested)
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);

      // Log-scale mapping (matches CodeBin approach)
      // scale = ln(N-1) / WIDTH, x = floor( ln(i) / scale )
      const N = data.length;              // frequencyBinCount
      if (N <= 1) return;
      const scale = Math.log(N - 1) / w;

      // Draw bars bottom-up; color via HSL like CodeBin
      for (let i = 1; i < N; i++) {       // i=0 would be ln(0)
        const x0 = Math.floor(Math.log(i) / scale);
        const x1 = Math.floor(Math.log(i + 1) / scale);
        const barW = Math.max(1, x1 - x0);

        const m = data[i];                // 0..255
        const barH = (m / 255) * (h * 0.9);
        const y = h - barH;

        // HSL coloring (CodeBin style)
        const hue = 300 - (m * 300) / 255;
        const sat = 100;
        const light = m < 64 ? (m * 50) / 64 : 50;
        ctx.fillStyle = `hsl(${hue}, ${sat}%, ${light}%)`;

        ctx.fillRect(x0, y, barW, barH);
      }
    };

    render();

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      try { srcNodeRef.current && srcNodeRef.current.disconnect(); } catch {}
      try { analyserRef.current && analyserRef.current.disconnect?.(); } catch {}
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close();
      }
    };
  }, [stream, audioUrl, onEnded]);

  return (
    <div ref={wrapRef} className="aw-wrap">
      <canvas ref={canvasRef} id="aw-canvas" />
    </div>
  );
};

export default AudioWave;
