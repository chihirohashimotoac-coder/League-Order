import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AppStoreProvider } from './state/appStore';
import { ToastProvider } from './components/ui';
import { initServiceWorker } from './pwa';
import './styles/app.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

// Review preview only: answer n01 from demo data (the preview cannot reach n01). The flag is
// `false` in the production build, so this import is not even bundled there.
if (__PREVIEW_DEMO_N01__) {
  const [{ installDemoN01 }, { N01_API_BASE_URL }] = await Promise.all([import('./preview/demoN01'), import('./integrations/n01/endpoints')]);
  installDemoN01(N01_API_BASE_URL);
}

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
