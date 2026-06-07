import React, { useRef } from 'react';
import { Camera, ImagePlus, X } from 'lucide-react';

interface PhotoInputProps {
  files: File[];
  previewUrls: string[];
  disabled?: boolean;
  onAdd: (files: File[]) => void;
  onRemove: (index: number) => void;
  onClear: () => void;
  onOpenCamera?: () => void;
}

export const PhotoInput: React.FC<PhotoInputProps> = ({
  files,
  previewUrls,
  disabled = false,
  onAdd,
  onRemove,
  onClear,
  onOpenCamera,
}) => {
  const galleryInputRef = useRef<HTMLInputElement | null>(null);

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const nextFiles = Array.from(event.target.files || []);
    event.target.value = '';
    if (nextFiles.length > 0) {
      onAdd(nextFiles);
    }
  };

  return (
    <div className="w-full space-y-4 py-2">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-slate-800 uppercase tracking-widest">拍照签到</h3>
          <p className="text-[10px] text-slate-400 font-medium mt-1 truncate">
            {files.length > 0 ? `已选择 ${files.length} 张照片` : '支持相册上传或全屏拍摄'}
          </p>
        </div>
        <div className="w-12 h-12 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center shrink-0 shadow-inner">
          <Camera size={24} />
        </div>
      </div>

      {previewUrls.length > 0 ? (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            {previewUrls.map((url, index) => (
              <div key={url} className="relative aspect-square overflow-hidden rounded-2xl bg-slate-100 border border-slate-100 shadow-sm">
                <img src={url} alt={`签到照片预览 ${index + 1}`} className="w-full h-full object-cover" />
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onRemove(index)}
                  className="absolute right-1 top-1 w-6 h-6 rounded-full bg-slate-900/70 text-white flex items-center justify-center backdrop-blur-md disabled:opacity-50"
                  title="移除照片"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            disabled={disabled}
            onClick={onClear}
            className="w-full py-2.5 rounded-xl bg-slate-100 text-slate-500 text-xs font-bold disabled:opacity-50 active:bg-slate-200 transition-colors"
          >
            清空已选照片
          </button>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 text-center py-4">
          <div className="w-20 h-20 bg-blue-50 rounded-2xl flex items-center justify-center text-blue-600 shadow-inner">
            <Camera size={40} />
          </div>
          <p className="text-[10px] text-slate-400 font-medium">请选择相册照片或点击下方按钮拍摄</p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          disabled={disabled}
          onClick={() => galleryInputRef.current?.click()}
          className="py-3.5 rounded-xl bg-slate-100 text-slate-700 text-xs font-bold flex items-center justify-center gap-2 disabled:opacity-50 active:bg-slate-200 transition-all"
        >
          <ImagePlus size={16} />
          从相册选择
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={onOpenCamera}
          className="py-3.5 rounded-xl bg-blue-50 text-blue-600 text-xs font-bold flex items-center justify-center gap-2 disabled:opacity-50 active:bg-blue-100 transition-all border border-blue-100"
        >
          <Camera size={16} />
          进入相机拍摄
        </button>
      </div>

      <input
        ref={galleryInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={handleChange}
      />
    </div>
  );
};
