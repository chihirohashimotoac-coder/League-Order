import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AppStoreProvider } from './state/appStore';
import { ToastProvider } from './components/ui';
import { initServiceWorker } from './pwa';
import './styles/app.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

createRoot(container).render(
  <StrictMode>
    <ToastProvider>
      <AppStoreProvider>
        <App />
      </AppStoreProvider>
    </ToastProvider>
  </StrictMode>,
);

// Offline support (spec §2): the service worker keeps the app usable at a venue with no
// signal. Updates are surfaced in the UI rather than reloading over a live order.
initServiceWorker();
