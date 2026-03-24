import React from 'react';

interface PinInputProps {
  value: string;
  onChange: (val: string) => void;
}

export const PinInput: React.FC<PinInputProps> = ({ value, onChange }) => (
  <div className="w-full space-y-4">
    <div className="text-center">
      <h3 className="text-sm font-bold text-slate-800 uppercase tracking-widest">请输入4-8位签到码</h3>
    </div>
    <div className="flex flex-col items-center gap-3">
      <input 
        type="text" 
        placeholder="请输入签到码" 
        value={value} 
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 8))} 
        className="w-full p-4 bg-slate-50 rounded-2xl border-none text-center text-3xl font-black tracking-[0.4em] text-blue-600 focus:ring-2 focus:ring-blue-100 outline-none transition-all" 
      />
    </div>
  </div>
);
