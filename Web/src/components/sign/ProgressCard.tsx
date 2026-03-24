import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { SignStatusMessage } from '../../types';

interface ProgressCardProps {
  name: string;
  avatar?: string;
  mobile: string;
  isHost?: boolean;
  statusObj?: Partial<SignStatusMessage>;
}

export const ProgressCard: React.FC<ProgressCardProps> = ({ 
  name, 
  avatar, 
  mobile, 
  isHost = false, 
  statusObj 
}) => {
  const status = statusObj?.status || 'pending';
  const message = statusObj?.message || '等待中...';
  
  const theme = {
    pending: { bg: "rgba(248, 250, 252, 0.4)", border: "rgba(241, 245, 249, 0.3)", text: "#94a3b8" },
    signing: { bg: "rgba(239, 246, 255, 0.4)", border: "rgba(191, 219, 254, 0.3)", text: "#2563eb" },
    retrying: { bg: "rgba(255, 251, 235, 0.4)", border: "rgba(253, 230, 138, 0.3)", text: "#d97706" },
    success: { bg: "rgba(236, 253, 245, 0.4)", border: "rgba(167, 243, 208, 0.3)", text: "#059669" },
    failed: { bg: "rgba(255, 241, 242, 0.4)", border: "rgba(254, 205, 211, 0.3)", text: "#e11d48" }
  }[status];

  const tagText = {
    pending: "等待中",
    signing: "签到中",
    retrying: `重试中(${statusObj?.attempt || 0})`,
    success: "成功",
    failed: "失败"
  }[status];

  return (
    <motion.div 
      layout
      animate={{ 
        backgroundColor: theme.bg,
        borderColor: theme.border,
        color: theme.text
      }}
      transition={{ duration: 0.3 }}
      className="relative overflow-hidden p-3 px-4 rounded-2xl border mb-3 backdrop-blur-[2px]"
    >
      <div className="relative z-10 flex items-center space-x-3">
        <div className="w-12 h-12 rounded-xl overflow-hidden border-2 border-white shrink-0 shadow-sm bg-white">
          {avatar ? (
            <img src={avatar} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
          ) : (
            <div className="w-full h-full bg-slate-100 flex items-center justify-center text-slate-300 font-bold text-lg">{name[0]}</div>
          )}
        </div>
        
        <div className="flex-1 min-w-0 flex flex-col justify-center space-y-1">
          {/* Row 1: Name + Status Tag */}
          <div className="flex items-center justify-between">
            <div className="font-bold text-slate-900 text-base truncate leading-tight flex items-center">
              {name} 
              {isHost && <span className="text-[10px] text-slate-400 font-bold ml-1.5 uppercase tracking-tighter">(我)</span>}
            </div>
            
            <div className="shrink-0 ml-2">
              <AnimatePresence initial={false} mode="wait">
                <motion.div 
                  key={tagText}
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  className="text-[12px] font-black px-1.5 py-0 rounded-md border-current border bg-white/80 whitespace-nowrap leading-normal"
                >
                  {tagText}
                </motion.div>
              </AnimatePresence>
            </div>
          </div>

          {/* Row 2: Mobile + Message */}
          <div className="flex items-center justify-between mt-auto">
            <div className="text-[10px] text-slate-400 font-mono font-bold tracking-tighter opacity-80">
              {mobile}
            </div>
            
            <div className="shrink-0 ml-4 max-w-[60%] text-right overflow-hidden">
              <AnimatePresence initial={false} mode="wait">
                <motion.div 
                  key={message}
                  initial={{ opacity: 0, x: 10 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -10 }}
                  className="text-[10px] font-black opacity-90 truncate tracking-tight"
                  title={message}
                >
                  {message}
                </motion.div>
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
};
