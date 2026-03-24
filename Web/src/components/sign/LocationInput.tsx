import React from 'react';
import { motion } from 'framer-motion';
import { MapPin } from 'lucide-react';

interface LocationInputProps {
  name: string;
  description: string;
  onOpen: () => void;
}

export const LocationInput: React.FC<LocationInputProps> = ({ name, description, onOpen }) => (
  <div className="w-full space-y-4 px-1">
    <div className="text-center">
      <h3 className="text-sm font-bold text-slate-800 uppercase tracking-widest">请确认签到位置</h3>
    </div>
    <motion.div 
      whileTap={{ scale: 0.98 }} 
      onClick={onOpen} 
      className="w-full p-4 bg-slate-50 rounded-2xl flex items-center justify-between cursor-pointer group hover:bg-slate-100 transition-colors"
    >
      <div className="min-w-0 px-1">
        <p className="font-bold text-slate-800 truncate text-sm">{name || '点击选择地点'}</p>
        <p className="text-[10px] text-slate-400 font-medium truncate">{description}</p>
      </div>
      <div className="w-9 h-9 rounded-full bg-white flex items-center justify-center shadow-sm shrink-0">
        <MapPin size={16} className="text-blue-500" />
      </div>
    </motion.div>
  </div>
);
