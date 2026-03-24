import React from 'react';
import { QrCode } from 'lucide-react';

export const QrInput: React.FC = () => (
  <div className="w-full space-y-4 py-2">
    <div className="text-center">
      <h3 className="text-sm font-bold text-slate-800 uppercase tracking-widest">请准备扫码签到</h3>
    </div>
    <div className="flex flex-col items-center gap-3 text-center">
      <div className="w-20 h-20 bg-blue-50 rounded-2xl flex items-center justify-center text-blue-600 shadow-inner">
        <QrCode size={40} />
      </div>
      <p className="text-[10px] text-slate-400 font-medium">二维码签到需先跳转至扫码界面</p>
    </div>
  </div>
);
