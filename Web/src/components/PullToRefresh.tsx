import React, { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { RefreshCw } from 'lucide-react';

interface PullToRefreshProps {
  onRefresh: () => Promise<void>;
  isRefreshing?: boolean;
  children: React.ReactNode;
  className?: string;
}

const PullToRefresh: React.FC<PullToRefreshProps> = ({ 
  onRefresh, 
  isRefreshing: externalIsRefreshing,
  children, 
  className 
}) => {
  const [pullDistance, setPullDistance] = useState(0);
  const [internalIsRefreshing, setInternalIsRefreshing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const startY = useRef(0);
  const isPulling = useRef(false);

  const isRefreshing = externalIsRefreshing ?? internalIsRefreshing;

  const PULL_THRESHOLD = 70;
  const MAX_PULL = 100;

  const handleTouchStart = useCallback((e: TouchEvent) => {
    const container = containerRef.current;
    if (!container || isRefreshing) return;

    if (container.scrollTop <= 0) {
      startY.current = e.touches[0].pageY;
      isPulling.current = true;
    }
  }, [isRefreshing]);

  const handleTouchMove = useCallback((e: TouchEvent) => {
    const container = containerRef.current;
    if (!container || !isPulling.current || isRefreshing) return;

    const currentY = e.touches[0].pageY;
    const diff = currentY - startY.current;

    if (diff > 0 && container.scrollTop <= 0) {
      if (e.cancelable) e.preventDefault();
      
      // Resistance calculation
      const pull = Math.min(MAX_PULL, diff * 0.45);
      setPullDistance(pull);
    } else if (diff < 0) {
      isPulling.current = false;
      setPullDistance(0);
    }
  }, [isRefreshing]);

  const handleTouchEnd = useCallback(async () => {
    if (!isPulling.current || isRefreshing) return;
    
    isPulling.current = false;
    if (pullDistance >= PULL_THRESHOLD) {
      setInternalIsRefreshing(true);
      setPullDistance(PULL_THRESHOLD * 0.6); // Show indicator partially while loading
      try {
        await onRefresh();
      } finally {
        setInternalIsRefreshing(false);
        setPullDistance(0);
      }
    } else {
      setPullDistance(0);
    }
  }, [pullDistance, isRefreshing, onRefresh]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: false });
    container.addEventListener('touchend', handleTouchEnd);

    return () => {
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('touchend', handleTouchEnd);
    };
  }, [handleTouchStart, handleTouchMove, handleTouchEnd]);

  return (
    <div 
      ref={containerRef} 
      className={`flex-1 overflow-y-auto relative scroll-smooth ${className}`}
    >
      <AnimatePresence>
        {(pullDistance > 0 || isRefreshing) && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ 
              opacity: Math.min(1, pullDistance / (PULL_THRESHOLD * 0.5)),
              y: pullDistance * 0.4 
            }}
            exit={{ opacity: 0, y: -20 }}
            className="absolute top-4 left-0 right-0 z-50 flex justify-center pointer-events-none"
          >
            <div className="bg-white rounded-full p-2 shadow-lg border border-slate-100 flex items-center justify-center">
              <RefreshCw 
                size={20} 
                className={`text-blue-600 ${isRefreshing ? 'animate-smooth-spin' : ''}`}
                style={{ 
                  transform: isRefreshing ? undefined : `rotate(${pullDistance * 4}deg)`
                }}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <motion.div
        animate={{ y: pullDistance }}
        transition={isPulling.current ? { type: 'tween', duration: 0 } : { type: 'spring', stiffness: 400, damping: 30 }}
        className="min-h-full"
      >
        {children}
      </motion.div>
    </div>
  );
};

export default PullToRefresh;
