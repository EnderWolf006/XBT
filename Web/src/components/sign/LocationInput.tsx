import React from 'react';
import { motion } from 'framer-motion';
import { MapPin, ChevronRight } from 'lucide-react';

interface LocationInputProps {
  name: string;
  description: string;
  onOpen: () => void;
}

export const LocationInput: React.FC<LocationInputProps> = ({ name, description, onOpen }) => (
  <div className="location-ui w-full space-y-2">
    <h3 className="loc-eyebrow">常用地点 / 已选位置</h3>
    <motion.button
      type="button"
      whileTap={{ scale: 0.98 }} 
      onClick={onOpen} 
      className="w-full p-4 bg-slate-50 border border-slate-200 rounded-2xl flex items-center gap-3 text-left hover:bg-blue-50 transition-colors"
    >
      <span className="loc-place-icon"><MapPin size={19} /></span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-slate-800 text-sm">{name || '点击选择地点'}</p>
        <p className="loc-note line-clamp-2 mt-1">{description}</p>
      </div>
      <ChevronRight size={17} className="text-slate-400 shrink-0" />
    </motion.button>
  </div>
);
