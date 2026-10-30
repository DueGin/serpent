import { useEffect, useRef, useState } from 'react';
import { COLORS, DELTA } from '../types';
import type { Frame, MatchConfig, ReplayDTO, ReviewOption } from '../types';

const TEAM_COLORS = ['#e8c547', '#e23d2a'];

export interface ArenaOverlay {
  slot: number;
  options: ReviewOption[];
}

interface ArenaProps {
  frame: Frame;
  config: MatchConfig;
  players: ReplayDTO['players'];
  overlay?: ArenaOverlay;
}

export function Arena({ frame, config, players, overlay }: ArenaProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const updateWidth = () => setContainerWidth(container.clientWidth);
    updateWidth();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateWidth);
      return () => window.removeEventListener('resize', updateWidth);
    }
    const observer = new ResizeObserver(updateWidth);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const columns = Math.max(1, config.width);
    const rows = Math.max(1, config.height);
    const cssWidth = Math.max(1, Math.floor(containerWidth || containerRef.current?.clientWidth || 640));
    const cell = cssWidth / columns;
    const cssHeight = cell * rows;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    canvas.style.width = '100%';
    canvas.style.height = `${cssHeight}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(canvas.width / cssWidth, 0, 0, canvas.height / cssHeight, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    ctx.fillStyle = '#070604';
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    ctx.strokeStyle = 'rgba(232,197,71,0.075)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= columns; x += 1) {
      const px = x * cell + 0.5;
      ctx.moveTo(px, 0);
      ctx.lineTo(px, cssHeight);
    }
    for (let y = 0; y <= rows; y += 1) {
      const py = y * cell + 0.5;
      ctx.moveTo(0, py);
      ctx.lineTo(cssWidth, py);
    }
    ctx.stroke();

    if (!config.wrap) {
      ctx.strokeStyle = 'rgba(232,197,71,0.42)';
      ctx.lineWidth = Math.max(1, cell * 0.08);
      ctx.strokeRect(1, 1, cssWidth - 2, cssHeight - 2);
    }

    const pad = Math.max(0.7, cell * 0.12);
    for (const food of frame.foods) {
      const size = Math.max(1, cell - pad * 2);
      ctx.fillStyle = '#e23d2a';
      ctx.shadowColor = '#e23d2a';
      ctx.shadowBlur = Math.min(14, cell * 0.65);
      ctx.fillRect(food.x * cell + pad, food.y * cell + pad, size, size);
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#f3ead8';
      const core = Math.max(1, cell * 0.16);
      ctx.fillRect(food.x * cell + cell / 2 - core / 2, food.y * cell + cell / 2 - core / 2, core, core);
    }

    const playerBySlot = new Map(players.map((player) => [player.slot, player]));
    for (const snake of frame.snakes) {
      const player = playerBySlot.get(snake.slot);
      const color = player?.color || COLORS[snake.slot % COLORS.length] || '#e8c547';
      const teamColor = config.teams && player?.team != null
        ? TEAM_COLORS[player.team % TEAM_COLORS.length] || '#f3ead8'
        : null;
      ctx.globalAlpha = snake.alive ? 1 : 0.24;

      snake.body.forEach((point, index) => {
        const head = index === 0;
        const inset = head ? pad : Math.min(cell * 0.28, pad + 1);
        const size = Math.max(1, cell - inset * 2);
        const x = point.x * cell + inset;
        const y = point.y * cell + inset;
        ctx.fillStyle = head ? color : shadeColor(color, snake.alive ? 0.76 : 0.55);
        ctx.fillRect(x, y, size, size);

        if (teamColor) {
          const stripe = Math.max(1, cell * 0.11);
          ctx.fillStyle = teamColor;
          ctx.fillRect(x, y, size, stripe);
          if (head) {
            ctx.strokeStyle = teamColor;
            ctx.lineWidth = Math.max(1.5, cell * 0.1);
            ctx.strokeRect(point.x * cell + pad / 2, point.y * cell + pad / 2, cell - pad, cell - pad);
          }
        }

        if (head && snake.alive) {
          ctx.fillStyle = '#120e0a';
          const eye = Math.max(1.2, cell * 0.13);
          const eyeY = point.y * cell + cell * 0.34;
          ctx.fillRect(point.x * cell + cell * 0.6, eyeY, eye, eye);
        }
      });
      ctx.globalAlpha = 1;
    }

    if (overlay) {
      const snake = frame.snakes.find((item) => item.slot === overlay.slot && item.alive);
      const head = snake?.body[0];
      if (head) {
        for (const option of overlay.options) {
          const delta = DELTA[option.dir];
          const rawX = head.x + delta.x;
          const rawY = head.y + delta.y;
          const x = config.wrap ? (rawX + columns) % columns : rawX;
          const y = config.wrap ? (rawY + rows) % rows : rawY;
          if (x < 0 || x >= columns || y < 0 || y >= rows) continue;
          const inset = Math.max(1, cell * 0.09);
          ctx.fillStyle = option.legal && option.death === null ? 'rgba(62,207,142,0.42)' : 'rgba(226,61,42,0.48)';
          ctx.fillRect(x * cell + inset, y * cell + inset, cell - inset * 2, cell - inset * 2);
          if (option.chosen) {
            ctx.strokeStyle = '#f3ead8';
            ctx.lineWidth = Math.max(2, cell * 0.1);
            ctx.strokeRect(x * cell + inset, y * cell + inset, cell - inset * 2, cell - inset * 2);
          }
        }
      }
    }
  }, [frame, config, players, overlay, containerWidth]);

  return (
    <div className="arena-viewport" ref={containerRef}>
      <canvas ref={canvasRef} role="img" aria-label={`对局第 ${frame.tick} 拍棋盘`}>
        当前浏览器不支持 Canvas，无法显示对局画面。
      </canvas>
    </div>
  );
}

function shadeColor(color: string, amount: number): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(color);
  if (!match) return color;
  const value = match[1];
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgb(${Math.round(r * amount)},${Math.round(g * amount)},${Math.round(b * amount)})`;
}
