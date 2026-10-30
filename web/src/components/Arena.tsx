import { useEffect, useRef } from 'react';
import type { PublicRoom } from '../types';

export function Arena({ room }: { room: PublicRoom }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const width = Math.max(room.width, 16);
    const height = Math.max(room.height, 12);
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 720;
    const cell = Math.floor(cssW / width);
    const cssH = cell * height;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    canvas.style.height = `${cssH}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = '#070604';
    ctx.fillRect(0, 0, cssW, cssH);

    ctx.strokeStyle = 'rgba(232,197,71,0.07)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= width; x++) {
      ctx.beginPath();
      ctx.moveTo(x * cell + 0.5, 0);
      ctx.lineTo(x * cell + 0.5, cssH);
      ctx.stroke();
    }
    for (let y = 0; y <= height; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * cell + 0.5);
      ctx.lineTo(cssW, y * cell + 0.5);
      ctx.stroke();
    }

    const pad = Math.max(1, Math.floor(cell * 0.12));
    for (const food of room.foods) {
      ctx.fillStyle = '#e23d2a';
      ctx.shadowColor = '#e23d2a';
      ctx.shadowBlur = 12;
      ctx.fillRect(food.x * cell + pad, food.y * cell + pad, cell - pad * 2, cell - pad * 2);
      ctx.shadowBlur = 0;
    }

    for (const snake of room.players) {
      snake.body.forEach((p, i) => {
        const dead = !snake.alive;
        ctx.globalAlpha = dead ? 0.35 : 1;
        ctx.fillStyle = i === 0 ? snake.color : shade(snake.color, dead ? 0.5 : 0.75);
        const inset = i === 0 ? pad : pad + 1;
        ctx.fillRect(p.x * cell + inset, p.y * cell + inset, cell - inset * 2, cell - inset * 2);
        if (i === 0 && snake.alive) {
          ctx.fillStyle = '#120e0a';
          const ex = p.x * cell + cell * 0.62;
          const ey = p.y * cell + cell * 0.35;
          ctx.fillRect(ex, ey, Math.max(2, cell * 0.12), Math.max(2, cell * 0.12));
        }
        ctx.globalAlpha = 1;
      });
    }
  }, [room.tick, room.status, room.foods, room.players, room.width, room.height]);

  return <canvas ref={ref} />;
}

function shade(hex: string, amount: number): string {
  const n = hex.replace('#', '');
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  return `rgb(${Math.round(r * amount)},${Math.round(g * amount)},${Math.round(b * amount)})`;
}
