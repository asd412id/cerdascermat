import { useEffect, useState } from 'react';
import { toDataURL } from 'qrcode';

/** QR pendaftaran: dibuat di peramban supaya tautan mengikuti alamat yang sedang dibuka. */
export function QrCode({ text, size = 200, className = '' }: { text: string; size?: number; className?: string }) {
  const [src, setSrc] = useState('');

  useEffect(() => {
    if (!text) {
      setSrc('');
      return;
    }
    let alive = true;
    setSrc('');
    toDataURL(text, { margin: 1, width: size * 2, color: { dark: '#16130f', light: '#f2ede4' } })
      .then((url) => {
        if (alive) setSrc(url);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [text, size]);

  if (!src) {
    return (
      <div
        aria-hidden="true"
        className={`animate-pulse bg-ink/15 ${className}`}
        style={{ width: size, height: size }}
      />
    );
  }
  return <img src={src} alt={`Kode QR pendaftaran ${text}`} width={size} height={size} className={className} />;
}
