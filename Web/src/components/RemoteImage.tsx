import { memo, useEffect, useRef, useState } from 'react';
import { useAuthStore } from '../store/auth';
import { loadMediaImage } from '../utils/mediaImages';

type Props = {
  src: string;
  alt: string;
  className?: string;
  loading?: 'lazy' | 'eager';
  token?: string;
};

function RemoteImage({ src, alt, className = '', loading = 'lazy', token: accountToken }: Props) {
  const activeToken = useAuthStore(state => state.token);
  const token = accountToken ?? activeToken;
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(loading === 'eager' || typeof IntersectionObserver === 'undefined');
  const [image, setImage] = useState<{ key: string; url: string; failed: boolean } | null>(null);
  const key = `${token ?? ''}\0${src}`;
  const local = /^(?:data:image\/|blob:|\/(?!\/))/.test(src);

  useEffect(() => {
    if (loading === 'eager' || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: '100px' });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [loading]);

  useEffect(() => {
    if (!(visible || loading === 'eager') || local || !token) return;
    const controller = new AbortController();
    let objectURL = '';
    void loadMediaImage(src.startsWith('//') ? `https:${src}` : src, token, controller.signal).then(blob => {
      if (controller.signal.aborted) return;
      objectURL = URL.createObjectURL(blob);
      setImage({ key, url: objectURL, failed: false });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
      console.warn('图片加载失败，已显示替代图像');
      setImage({ key, url: '', failed: true });
    });
    return () => {
      controller.abort();
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [key, src, token, local, visible, loading]);

  const failed = image?.key === key && image.failed;
  const url = failed ? '' : local ? src : image?.key === key ? image.url : '';
  return (
    <span ref={ref} className={`inline-flex items-center justify-center overflow-hidden bg-slate-100 text-slate-400 ${className}`}>
      {url ? (
        <img src={url} alt={alt} loading={loading} decoding="async" referrerPolicy="no-referrer"
          className="block h-full w-full object-cover"
          onError={() => setImage({ key, url: '', failed: true })} />
      ) : (
        <span role="img" aria-label={`${alt}${failed ? '（加载失败）' : '（默认图像）'}`}
          title={failed ? '图片加载失败，刷新页面可重试' : alt}
          className="flex h-full w-full items-center justify-center font-bold">
          {alt.trim()[0] || '·'}
        </span>
      )}
    </span>
  );
}

export default memo(RemoteImage);
