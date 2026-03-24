import React, { useState, useRef, useEffect } from 'react';
import toast from 'react-hot-toast';

interface GestureCanvasProps {
  value: string;
  onPathChange: (path: string) => void;
}

const GestureCanvas: React.FC<GestureCanvasProps> = ({ value, onPathChange }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [path, setPath] = useState<number[]>([]);
  const isDrawing = useRef(false);
  const pointsRef = useRef<{ x: number, y: number, r: number }[]>([]);

  useEffect(() => {
    if (value === '') setPath([]);
  }, [value]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const size = canvas.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    const dotR = 6;
    const activeR = 36;
    const padding = 44; // Increased padding
    const gap = (size - padding * 2) / 2;
    
    const points: { x: number; y: number; r: number }[] = [];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        points.push({ x: padding + gap * j, y: padding + gap * i, r: activeR });
      }
    }
    pointsRef.current = points;

    const draw = () => {
      ctx.clearRect(0, 0, size, size);
      if (path.length > 0) {
        ctx.beginPath();
        ctx.lineWidth = 6;
        ctx.strokeStyle = '#2563eb';
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        path.forEach((pIdx, i) => {
          const p = points[pIdx - 1];
          if (p && i === 0) ctx.moveTo(p.x, p.y);
          else if (p) ctx.lineTo(p.x, p.y);
        });
        ctx.stroke();
      }
      points.forEach((p, i) => {
        const isSelected = path.includes(i + 1);
        ctx.beginPath();
        ctx.arc(p.x, p.y, dotR, 0, Math.PI * 2);
        ctx.fillStyle = isSelected ? '#2563eb' : '#e2e8f0';
        ctx.fill();
        if (isSelected) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, activeR * 0.6, 0, Math.PI * 2);
          ctx.strokeStyle = '#2563eb44';
          ctx.lineWidth = 3;
          ctx.stroke();
        }
      });
    };
    draw();
  }, [path]);

  const getMidPoint = (p1: number, p2: number) => {
    const mids: Record<string, number> = {
      '1-3': 2, '3-1': 2, '4-6': 5, '6-4': 5, '7-9': 8, '9-7': 8,
      '1-7': 4, '7-1': 4, '2-8': 5, '8-2': 5, '3-9': 6, '9-3': 6,
      '1-9': 5, '9-1': 5, '3-7': 5, '7-3': 5
    };
    return mids[`${p1}-${p2}`] || null;
  };

  const findHitPoint = (e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    let hitIdx: number | null = null;
    pointsRef.current.forEach((p, i) => {
      const dist = Math.sqrt((x - p.x) ** 2 + (y - p.y) ** 2);
      if (dist < p.r) hitIdx = i + 1;
    });
    return hitIdx as number | null;
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    isDrawing.current = true;
    const hitIdx = findHitPoint(e);
    if (hitIdx !== null) {
      setPath([hitIdx]);
      onPathChange(String(hitIdx));
    } else {
      setPath([]);
      onPathChange('');
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDrawing.current) return;
    const pointIdx = findHitPoint(e);
    if (pointIdx !== null && !path.includes(pointIdx)) {
      let newPoints = [];
      if (path.length > 0) {
        const lastIdx = path[path.length - 1];
        const midPoint = getMidPoint(lastIdx, pointIdx);
        if (midPoint && !path.includes(midPoint)) newPoints.push(midPoint);
      }
      newPoints.push(pointIdx);
      const newPath = [...path, ...newPoints];
      setPath(newPath);
      onPathChange(newPath.join(''));
    }
  };

  const handlePointerUp = () => {
    isDrawing.current = false;
    if (path.length > 0 && path.length < 4) {
      toast.error('手势至少连接 4 个点', { id: 'gesture-error' });
      setPath([]);
      onPathChange('');
    }
  };

  return (
    <div className="relative aspect-square w-full max-w-[220px] mx-auto overflow-hidden touch-none">
      <canvas
        ref={canvasRef}
        className="w-full h-full cursor-crosshair"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
      />
    </div>
  );
};

interface GestureInputProps {
  value: string;
  onChange: (val: string) => void;
}

export const GestureInput: React.FC<GestureInputProps> = ({ value, onChange }) => (
  <div className="w-full">
    <div className="flex justify-center items-center py-2">
      <GestureCanvas value={value} onPathChange={onChange} />
    </div>
  </div>
);

