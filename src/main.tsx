import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App';
import { registerSW } from 'virtual:pwa-register';

const root = document.getElementById('root');
if (!root) throw new Error('#root tidak ditemukan');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

let updateReady = false;
const updateSW = registerSW({
  onNeedRefresh() {
    updateReady = true;
    window.dispatchEvent(new CustomEvent('cc:update-available'));
  },
  onOfflineReady() {
    window.dispatchEvent(new CustomEvent('cc:offline-ready'));
  },
});

export function applyUpdate() {
  if (updateReady) void updateSW(true);
}

window.addEventListener('cc:apply-update', applyUpdate);
