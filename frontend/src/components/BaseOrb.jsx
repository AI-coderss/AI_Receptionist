/* eslint-disable react-hooks/exhaustive-deps */
// src/components/BaseOrb.jsx
// Canvas stays small; particle sphere fills ~98–99% of that canvas
// Transparent background in both themes

import React, { useEffect, useRef, useState } from "react";
import "../styles/BaseOrb.css";
import useAudioForVisualizerStore from "../store/useAudioForVisualizerStore";
import { enhanceAudioScale } from "./audioLevelAnalyzer";

// Make sphere radius ~ 49.5% of the shorter side → diameter ≈ 99% of canvas
const FILL_FACTOR = 0.896;

const BaseOrb = () => {
  const canvasRef = useRef(null);
  const audioScale = useAudioForVisualizerStore((state) =>
    enhanceAudioScale(state.audioScale)
  );

  const [isDark, setIsDark] = useState(
    typeof document !== "undefined"
      ? document.documentElement.getAttribute("data-theme") === "dark"
      : false
  );

  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const root = document.documentElement;
    const mo = new MutationObserver(() => {
      setIsDark(root.getAttribute("data-theme") === "dark");
    });
    mo.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    let raf = 0;

    const fit = () => {
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width * dpr));
      const h = Math.max(1, Math.floor(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    };

    const ro = new ResizeObserver(fit);
    ro.observe(canvas);

    let sphereRad = 180;
    let radius_sp = Math.max(0.7, audioScale);

    const fLen = 320;
    const particleAlpha = 1;
    const colorLight = "rgba(0,123,255,";  // blue
    const colorDark  = "rgba(34,211,238,"; // cyan
    const randAccelX = 0.1, randAccelY = 0.1, randAccelZ = 0.1;
    const gravity = 0;
    const particleRad = 2.5;
    const zeroAlphaDepth = -750;

    let turnAngle = 0;
    const turnSpeed = (2 * Math.PI) / 1200;

    const particleList = {};
    const recycleBin = {};

    function addParticle(x0, y0, z0, vx0, vy0, vz0) {
      let p = recycleBin.first || {};
      recycleBin.first = p.next || null;

      if (!particleList.first) {
        particleList.first = p;
        p.prev = p.next = null;
      } else {
        p.next = particleList.first;
        particleList.first.prev = p;
        particleList.first = p;
        p.prev = null;
      }

      Object.assign(p, {
        x: x0, y: y0, z: z0,
        velX: vx0, velY: vy0, velZ: vz0,
        age: 0, dead: false,
        attack: 50, hold: 50, decay: 100,
        initValue: 0, holdValue: particleAlpha, lastValue: 0,
        stuckTime: 90 + Math.random() * 20,
        accelX: 0, accelY: gravity, accelZ: 0,
      });

      return p;
    }

    function recycle(p) {
      if (particleList.first === p) {
        particleList.first = p.next;
        if (p.next) p.next.prev = null;
      } else {
        if (p.next) p.next.prev = p.prev;
        if (p.prev) p.prev.next = p.next;
      }
      p.next = recycleBin.first;
      if (recycleBin.first) recycleBin.first.prev = p;
      recycleBin.first = p;
      p.prev = null;
    }

    let count = 0;

    const onFrame = () => {
      raf = requestAnimationFrame(onFrame);
      fit();

      const projCenterX = canvas.width / 2;
      const projCenterY = canvas.height / 2;
      const shortSide = Math.min(canvas.width, canvas.height);

      // SMALL canvas, BIG sphere inside
      sphereRad = Math.max(80, shortSide * FILL_FACTOR);

      const zMax = fLen - 2;
      const raw = useAudioForVisualizerStore.getState().audioScale;
      radius_sp = Math.max(0.7, enhanceAudioScale(raw));

      if (++count >= 1) {
        count = 0;
        for (let i = 0; i < 8; i++) {
          const theta = Math.random() * 2 * Math.PI;
          const phi = Math.acos(Math.random() * 2 - 1);
          const x0 = sphereRad * Math.sin(phi) * Math.cos(theta);
          const y0 = sphereRad * Math.sin(phi) * Math.sin(theta);
          const z0 = sphereRad * Math.cos(phi);
          addParticle(
            x0, y0, -3 - sphereRad + z0,
            0.002 * x0, 0.002 * y0, 0.002 * z0
          );
        }
      }

      turnAngle = (turnAngle + turnSpeed) % (2 * Math.PI);
      const sinAngle = Math.sin(turnAngle);
      const cosAngle = Math.cos(turnAngle);

      // Transparent canvas
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      canvas.style.backgroundColor = "transparent";

      const rgbString = isDark ? colorDark : colorLight;

      let p = particleList.first;
      while (p) {
        const next = p.next;
        p.age++;

        if (p.age > p.stuckTime) {
          p.velX += randAccelX * (Math.random() * 2 - 1);
          p.velY += gravity + randAccelY * (Math.random() * 2 - 1);
          p.velZ += randAccelZ * (Math.random() * 2 - 1);
          p.x += p.velX;
          p.y += p.velY;
          p.z += p.velZ;
        }

        const rotX = cosAngle * p.x + sinAngle * (p.z + sphereRad + 3);
        const rotZ = -sinAngle * p.x + cosAngle * (p.z + sphereRad + 3) - sphereRad - 3;
        const m = (radius_sp * fLen) / (fLen - rotZ);

        p.projX = rotX * m + projCenterX;
        p.projY = p.y * m + projCenterY;

        if (p.age < p.attack + p.hold + p.decay) {
          if (p.age < p.attack) {
            p.alpha = ((p.holdValue - p.initValue) / p.attack) * p.age + p.initValue;
          } else if (p.age < p.attack + p.hold) {
            p.alpha = p.holdValue;
          } else {
            p.alpha = ((p.lastValue - p.holdValue) / p.decay) * (p.age - p.attack - p.hold) + p.holdValue;
          }
        } else {
          p.dead = true;
        }

        const outOfView =
          p.projX > canvas.width || p.projX < 0 ||
          p.projY > canvas.height || p.projY < 0 || rotZ > zMax;

        if (outOfView || p.dead) {
          recycle(p);
        } else {
          const depthAlphaFactor = Math.min(1, Math.max(0, 1 - rotZ / zeroAlphaDepth));
          ctx.fillStyle = rgbString + depthAlphaFactor * p.alpha + ")";
          ctx.beginPath();
          ctx.arc(p.projX, p.projY, Math.max(0.5, m * particleRad), 0, 2 * Math.PI);
          ctx.fill();
        }

        p = next;
      }
    };

    raf = requestAnimationFrame(onFrame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [isDark]);

  return <canvas className="base-orb" id="base-orb" ref={canvasRef} />;
};

export default BaseOrb;
